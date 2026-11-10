package ai.clawpage.agent

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Locale

// The photos the person shared with the agent (docs/EXEC-ENVS.md, capability `photos`). Google Play allows
// broad photo access only to apps whose core function is a gallery, so the app reads no library: the person
// picks photos in the system photo picker (no permission), the app keeps a lasting read grant for each, and
// the agent sees exactly those, as one album, "Shared with AI". The person adds and removes them in the
// console's settings. The tools answer as the iPhone's do (DeviceTools.swift): metadata to find, downscaled
// JPEG copies, at most five per call.

object DevicePhotos {
  const val ALBUM = "shared"
  private const val MAX_PHOTOS = 5
  private const val MAX_SIDE = 1600
  /** Five of these, base64 twice up the device link, stay under the socket's 16 MB a message. */
  private const val MAX_PHOTO_BYTES = 1400 * 1024
  private const val THUMB_SIDE = 160

  private lateinit var context: Context
  private val random = SecureRandom()

  fun init(context: Context) { this.context = context.applicationContext }

  private val resolver get() = context.contentResolver

  /** One shared photo: its grant, and what was read from it when it was added. */
  private class Shared(val id: String, val uri: Uri, val video: Boolean, val created: Long?, val width: Int, val height: Int, val duration: Double?) {
    fun json(): JSONObject = JSONObject().put("id", id).put("uri", uri.toString()).put("video", video).put("created", created ?: JSONObject.NULL)
      .put("width", width).put("height", height).put("duration", duration ?: JSONObject.NULL)
  }

  private val file get() = File(context.noBackupFilesDir, "shared-photos.json")
  private var cached: MutableList<Shared>? = null

  @Synchronized private fun shared(): MutableList<Shared> = cached ?: run {
    val list = mutableListOf<Shared>()
    val raw = try { JSONArray(file.readText()) } catch (_: Exception) { JSONArray() }
    for (i in 0 until raw.length()) {
      val o = raw.getJSONObject(i)
      list.add(Shared(o.getString("id"), Uri.parse(o.getString("uri")), o.optBoolean("video"), if (o.isNull("created")) null else o.getLong("created"),
        o.optInt("width"), o.optInt("height"), if (o.isNull("duration")) null else o.getDouble("duration")))
    }
    list.also { cached = it }
  }

  @Synchronized private fun save(list: List<Shared>) {
    cached = list.toMutableList()
    val partial = File(file.path + ".part")
    partial.writeText(JSONArray(list.map { it.json() }).toString())
    partial.renameTo(file)
  }

  val count: Int get() = shared().size

  /** What the person picked: each kept with a lasting grant (one already shared is not added twice). */
  @Synchronized fun add(uris: List<Uri>): Int {
    val list = shared()
    var added = 0
    for (uri in uris) {
      if (list.any { it.uri == uri }) continue
      try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: SecurityException) { continue }
      val id = ByteArray(6).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
      list.add(read(id, uri) ?: continue)
      added++
    }
    save(list)
    return added
  }

  /** No longer shared: the grant goes too. Null removes them all. */
  @Synchronized fun remove(ids: Collection<String>?) {
    val list = shared()
    val (gone, kept) = list.partition { ids == null || it.id in ids }
    for (s in gone) try { resolver.releasePersistableUriPermission(s.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: SecurityException) {}
    save(kept)
  }

  private fun read(id: String, uri: Uri): Shared? = try {
    val video = resolver.getType(uri)?.startsWith("video/") == true
    if (video) {
      val r = MediaMetadataRetriever()
      try {
        r.setDataSource(context, uri)
        val rotated = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0) % 180 != 0
        val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
        val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        Shared(id, uri, true, taken(uri), if (rotated) h else w, if (rotated) w else h, ms?.let { Math.round(it / 100.0) / 10.0 })
      } finally { r.release() }
    } else {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      val exif = resolver.openInputStream(uri)?.use { ExifInterface(it) }
      val rotated = rotation(exif) % 180 != 0
      Shared(id, uri, false, taken(uri) ?: exifDate(exif), if (rotated) bounds.outHeight else bounds.outWidth, if (rotated) bounds.outWidth else bounds.outHeight, null)
    }
  } catch (_: Exception) { null }

  /** When it was taken, as the picker tells it. */
  private fun taken(uri: Uri): Long? = try {
    resolver.query(uri, arrayOf(MediaStore.MediaColumns.DATE_TAKEN), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0).takeIf { it > 0 } else null
    }
  } catch (_: Exception) { null }

  private fun exifDate(exif: ExifInterface?): Long? {
    val text = exif?.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: exif?.getAttribute(ExifInterface.TAG_DATETIME) ?: return null
    return try { SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US).parse(text)?.time } catch (_: Exception) { null }
  }

  private fun rotation(exif: ExifInterface?): Int = when (exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
    ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
    ExifInterface.ORIENTATION_ROTATE_180 -> 180
    ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
    else -> 0
  }

  private fun describe(s: Shared): JSONObject {
    val item = JSONObject().put("id", s.id).put("created", s.created?.let { Dates.string(it) } ?: JSONObject.NULL).put("width", s.width).put("height", s.height)
      .put("mediaType", if (s.video) "video" else "image").put("favorite", false)
    if (s.duration != null) item.put("duration", s.duration)
    return item
  }

  // The tools

  fun albums(): JSONObject =
    JSONObject().put("albums", JSONArray().put(JSONObject().put("id", ALBUM).put("title", "Shared with AI").put("count", count).put("kind", "album")))

  fun list(args: JSONObject): JSONObject {
    val album = args.optString("album_id", "")
    if (album.isNotEmpty() && album != ALBUM) throw ToolError("not_found", "no album $album")
    val from = Dates.parse(args.opt("from"), "from")?.ms
    val to = Dates.parse(args.opt("to"), "to")?.let { Dates.end(it) }
    val media = args.optString("media", "image")
    val found = shared().filter { s ->
      (media == "any" || (media == "video") == s.video) &&
        (from == null || (s.created != null && s.created >= from)) && (to == null || (s.created != null && s.created < to))
    }.sortedByDescending { it.created ?: Long.MIN_VALUE }
    val offset = intArg(args, "offset", 0, 1_000_000)
    val limit = intArg(args, "limit", 20, 100)
    return JSONObject().put("photos", JSONArray(found.drop(offset).take(limit).map(::describe))).put("total", found.size).put("offset", offset)
  }

  fun fetch(args: JSONObject): JSONObject {
    val raw = args.optJSONArray("ids") ?: JSONArray()
    val ids = (0 until raw.length()).map { raw.optString(it) }.filter { it.isNotEmpty() }
    if (ids.isEmpty() || ids.size > MAX_PHOTOS) throw ToolError("invalid", "ids: 1 to $MAX_PHOTOS photo ids")
    val side = intArg(args, "max_size", MAX_SIDE, MAX_SIDE).coerceIn(64, MAX_SIDE)
    val byId = shared().associateBy { it.id }
    val photos = JSONArray()
    val missing = JSONArray()
    for (id in ids) {
      val s = byId[id]
      val jpeg = s?.let { picture(it, side, MAX_PHOTO_BYTES) }
      if (s == null || jpeg == null) { missing.put(id); continue }
      photos.put(describe(s).put("jpeg", Base64.encodeToString(jpeg, Base64.NO_WRAP)))
    }
    return JSONObject().put("photos", photos).put("missing", missing)
  }

  /** Small copies for the console's list of what is shared, so the person sees what they are removing. */
  fun thumbnails(): JSONArray = JSONArray(shared().map { s ->
    JSONObject().put("id", s.id).put("video", s.video).put("thumb", picture(s, THUMB_SIDE, 64 * 1024)?.let { "data:image/jpeg;base64," + Base64.encodeToString(it, Base64.NO_WRAP) } ?: JSONObject.NULL)
  })

  /** A JPEG no larger than `side` on its longer edge (never larger than the original), upright, within `limit` bytes. */
  private fun picture(s: Shared, side: Int, limit: Int): ByteArray? = try {
    val full = if (s.video) {
      val r = MediaMetadataRetriever()
      try { r.setDataSource(context, s.uri); r.frameAtTime } finally { r.release() }
    } else {
      val longer = maxOf(s.width, s.height, 1)
      var sample = 1
      while (longer / (sample * 2) >= side) sample *= 2
      val bitmap = resolver.openInputStream(s.uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
      val turn = rotation(resolver.openInputStream(s.uri)?.use { ExifInterface(it) })
      if (bitmap != null && turn != 0) Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(turn.toFloat()) }, true) else bitmap
    }
    full?.let { bitmap ->
      val scale = minOf(1.0, side.toDouble() / maxOf(bitmap.width, bitmap.height, 1))
      val sized = if (scale < 1) Bitmap.createScaledBitmap(bitmap, maxOf(1, Math.round(bitmap.width * scale).toInt()), maxOf(1, Math.round(bitmap.height * scale).toInt()), true) else bitmap
      listOf(80, 60, 40).asSequence().map { q -> ByteArrayOutputStream().also { sized.compress(Bitmap.CompressFormat.JPEG, q, it) }.toByteArray() }.firstOrNull { it.size <= limit }
    }
  } catch (_: Exception) { null }
}
