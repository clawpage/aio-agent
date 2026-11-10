package ai.clawpage.agent

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// The agent's folder on this phone (docs/EXEC-ENVS.md, capability `files`): `AI Files` in the app's own
// storage (Android/data/ai.clawpage.agent/files, no storage permission), which the system Files app shows under
// the app's name (AIFilesProvider.kt). The agent lists it, copies files from it into its workspace and puts files
// there for the person; nothing outside this folder is reachable.

class FilesError(val code: String, override val message: String) : Exception(message)

object DeviceFiles {
  /** A file the agent puts here or takes from here may be as large as the control plane moves (MAX_FILE_BYTES in gateway.ts). */
  private const val MAX_BYTES = 20 * 1024 * 1024
  /**
   * A file taken goes up the device link in parts the control plane asks for one by one (`offset`, `length`):
   * each answer is one message, base64 twice (the part in the answer, the answer in the frame), and the socket
   * sends at most 16 MB at once.
   */
  private const val MAX_PART_BYTES = 6 * 1024 * 1024
  /** A control plane from before the parts asks for the whole file in one answer. */
  private const val MAX_WHOLE_BYTES = 8 * 1024 * 1024

  private lateinit var context: Context

  fun init(context: Context) { this.context = context.applicationContext }

  val root: File
    get() {
      val folder = File(context.getExternalFilesDir(null) ?: context.filesDir, "AI Files")
      folder.mkdirs()
      return folder
    }

  /** A path the agent gave, inside the folder; nothing that climbs out of it. */
  private fun inside(relative: String): File {
    val clean = relative.split("/").filter { it.isNotEmpty() && it != "." }
    if (clean.contains("..")) throw FilesError("invalid", "paths stay inside the folder")
    val base = root.canonicalFile
    val file = clean.fold(base) { dir, part -> File(dir, part) }.canonicalFile
    if (file != base && !file.path.startsWith(base.path + File.separator)) throw FilesError("invalid", "paths stay inside the folder")
    return file
  }

  private fun iso(ms: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).apply { timeZone = TimeZone.getDefault() }.format(Date(ms))

  fun list(args: JSONObject): JSONObject {
    val name = args.optString("folder", "")
    val items = inside(name).listFiles()?.filter { !it.name.startsWith(".") }?.take(500) ?: emptyList()
    val files = JSONArray()
    for (f in items) files.put(JSONObject().put("name", f.name).put("folder", f.isDirectory).put("size", if (f.isFile) f.length() else 0).put("modified", iso(f.lastModified())))
    return JSONObject().put("folder", name).put("files", files)
  }

  fun pull(args: JSONObject): JSONObject {
    val name = args.optString("name", "")
    if (name.isEmpty()) throw FilesError("invalid", "name is required")
    val file = inside(name)
    if (!file.isFile) throw FilesError("not_found", name)
    val size = file.length()
    if (size > MAX_BYTES) throw FilesError("invalid", "larger than ${MAX_BYTES / 1024 / 1024} MB")
    if (!args.has("offset")) {
      if (size > MAX_WHOLE_BYTES) throw FilesError("invalid", "larger than ${MAX_WHOLE_BYTES / 1024 / 1024} MB")
      return JSONObject().put("name", file.name).put("data", Base64.encodeToString(file.readBytes(), Base64.NO_WRAP))
    }
    val offset = args.optLong("offset").coerceIn(0, size)
    val part = ByteArray(minOf(args.optLong("length", MAX_PART_BYTES.toLong()).coerceIn(1, MAX_PART_BYTES.toLong()), size - offset).toInt())
    RandomAccessFile(file, "r").use { it.seek(offset); it.readFully(part) }
    return JSONObject().put("name", file.name).put("data", Base64.encodeToString(part, Base64.NO_WRAP)).put("offset", offset).put("size", size)
  }

  /** Saved under its name; a name already there gets " (2)", " (3)", … rather than replacing what the person has. */
  fun push(args: JSONObject): JSONObject {
    val name = args.optString("name", "").substringAfterLast('/')
    val encoded = args.optString("data", "")
    if (name.isEmpty() || name == "." || name == ".." || !args.has("data")) throw FilesError("invalid", "name and data are required")
    val data = try { Base64.decode(encoded, Base64.DEFAULT) } catch (_: IllegalArgumentException) { throw FilesError("invalid", "name and data are required") }
    if (data.size > MAX_BYTES) throw FilesError("invalid", "larger than ${MAX_BYTES / 1024 / 1024} MB")
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot + 1) else ""
    var target = File(root, name)
    var n = 2
    while (target.exists()) {
      target = File(root, if (ext.isEmpty()) "$base ($n)" else "$base ($n).$ext")
      n++
    }
    val partial = File(root, ".${target.name}.part")
    partial.writeBytes(data)
    if (!partial.renameTo(target)) { partial.delete(); throw FilesError("failed", "could not save ${target.name}") }
    return JSONObject().put("saved", target.name).put("size", data.size)
  }
}
