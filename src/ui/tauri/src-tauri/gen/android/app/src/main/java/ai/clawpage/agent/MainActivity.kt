package ai.clawpage.agent

import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.webkit.WebView
import android.webkit.CookieManager
import android.widget.Toast
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  private var authWebView: WebView? = null
  private var authReady = false
  private var pendingAuth: String? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  /**
   * Images and videos go straight into the gallery, from the bytes the console already has, with
   * no download link (which this web view does nothing with). The same messages as the iOS app
   * (DeviceBrowser.swift): "begin" (name, mime), the file in base64 "chunk"s, then "finish" or
   * "cancel"; "settings" opens this app's system settings. Each message carries a `seq` that its
   * answer repeats: {"id"} for "begin", {"error": "denied" | …} when something failed, {} otherwise.
   * Android 10+ adds to MediaStore with no permission; 7–9 need the storage permission, asked once.
   */
  private class Transfer(val file: File, val out: FileOutputStream, val mime: String, val ext: String, val name: String)
  private val transfers = HashMap<String, Transfer>()
  private val storageWaiting = ArrayList<(Boolean) -> Unit>()
  private val saveTypes = mapOf(
    "image/png" to "png", "image/jpeg" to "jpg", "image/gif" to "gif", "image/webp" to "webp", "image/heic" to "heic",
    "video/mp4" to "mp4", "video/quicktime" to "mov", "video/x-m4v" to "m4v",
  )

  private fun saveMedia(body: JSONObject, reply: (JSONObject) -> Unit) {
    val id = body.optString("id")
    val error = { code: String -> reply(JSONObject().put("error", code)) }
    when (body.optString("type")) {
      "begin" -> {
        val mime = body.optString("mime")
        val ext = saveTypes[mime] ?: return error("type")
        val name = body.optString("name").replace('/', '_').take(200).ifEmpty { "download.$ext" }
        withStorage { granted ->
          if (!granted) return@withStorage error("denied")
          val transferId = UUID.randomUUID().toString()
          val file = File(cacheDir, "aio-save-$transferId.$ext")
          try {
            transfers[transferId] = Transfer(file, FileOutputStream(file), mime, ext, name)
            reply(JSONObject().put("id", transferId))
          } catch (_: IOException) { error("failed") }
        }
      }
      "chunk" -> {
        val transfer = transfers[id] ?: return error("failed")
        try {
          transfer.out.write(Base64.decode(body.optString("data"), Base64.DEFAULT))
          reply(JSONObject())
        } catch (_: Exception) { dropTransfer(id); error("failed") }
      }
      "finish" -> {
        val transfer = transfers.remove(id) ?: return error("failed")
        Thread {
          val ok = try { transfer.out.close(); addToGallery(transfer); true } catch (_: Exception) { false }
          transfer.file.delete()
          runOnUiThread { if (ok) reply(JSONObject()) else error("failed") }
        }.start()
      }
      "cancel" -> { dropTransfer(id); reply(JSONObject()) }
      "settings" -> {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        reply(JSONObject())
      }
      else -> error("unknown")
    }
  }

  private fun dropTransfer(id: String) {
    val transfer = transfers.remove(id) ?: return
    try { transfer.out.close() } catch (_: IOException) {}
    transfer.file.delete()
  }

  private fun withStorage(then: (Boolean) -> Unit) {
    if (Build.VERSION.SDK_INT >= 29 || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) return then(true)
    storageWaiting.add(then)
    if (storageWaiting.size == 1) requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), STORAGE_REQUEST)
  }

  @Deprecated("Deprecated in Java")
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != STORAGE_REQUEST) return
    val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
    val waiting = storageWaiting.toList()
    storageWaiting.clear()
    waiting.forEach { it(granted) }
  }

  /** Pictures/Clawpage or Movies/Clawpage, where the gallery shows it as an album. */
  private fun addToGallery(transfer: Transfer) {
    val video = transfer.mime.startsWith("video/")
    val folder = if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
    if (Build.VERSION.SDK_INT >= 29) {
      val collection = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, transfer.name)
        put(MediaStore.MediaColumns.MIME_TYPE, transfer.mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/Clawpage")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = contentResolver.insert(collection, values) ?: throw IOException("insert")
      try {
        val out = contentResolver.openOutputStream(uri) ?: throw IOException("open")
        out.use { sink -> transfer.file.inputStream().use { it.copyTo(sink) } }
        contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) {
        contentResolver.delete(uri, null, null)
        throw e
      }
    } else {
      @Suppress("DEPRECATION")
      val dir = File(Environment.getExternalStoragePublicDirectory(folder), "Clawpage")
      if (!dir.isDirectory && !dir.mkdirs()) throw IOException("mkdirs")
      val name = if (transfer.name.lowercase().endsWith(".${transfer.ext}")) transfer.name else "${transfer.name}.${transfer.ext}"
      val stem = name.substring(0, name.length - transfer.ext.length - 1)
      var target = File(dir, name)
      var n = 1
      while (target.exists()) target = File(dir, "$stem (${n++}).${transfer.ext}")
      transfer.file.copyTo(target)
      MediaScannerConnection.scanFile(this, arrayOf(target.path), arrayOf(transfer.mime), null)
    }
  }

  /**
   * WebView never learns about connectivity by itself: navigator.onLine stays true offline and
   * the "online" event never fires. The console uses both when it opens without a network (to say
   * the device is offline, and to reload the latest UI as soon as it is back).
   */
  private fun followNetwork(webView: WebView) {
    val connectivity = getSystemService(ConnectivityManager::class.java) ?: return
    networkCallback?.let { connectivity.unregisterNetworkCallback(it) }
    webView.setNetworkAvailable(connectivity.activeNetwork != null)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { webView.post { webView.setNetworkAvailable(true) } }
      override fun onLost(network: Network) {
        webView.post { webView.setNetworkAvailable(connectivity.activeNetwork.let { it != null && it != network }) }
      }
    }
    connectivity.registerDefaultNetworkCallback(callback)
    networkCallback = callback
  }
  private fun receiveAuth(intent: Intent?) {
    val url = intent?.data ?: return
    if (url.scheme != "aioagent" || url.host != "auth" || url.path.orEmpty().isNotEmpty()) return
    val ticket = url.getQueryParameter("ticket")
    val error = url.getQueryParameter("error")
    if (ticket != null && Regex("^[A-Za-z0-9_-]{43}$").matches(ticket)) {
      pendingAuth = JSONObject().put("ticket", ticket).toString()
    } else if (error == "failed") pendingAuth = JSONObject().put("error", error).toString()
    deliverAuth()
  }
  private fun deliverAuth() {
    if (!authReady) return
    val detail = pendingAuth ?: return
    val webView = authWebView ?: return
    // The code is useful only with the initiating WebView's HttpOnly flow cookie.
    // Never pass a callback to a different site that happened to navigate this WebView.
    if (Uri.parse(webView.url ?: "").let { it.scheme != "https" || it.host != "agent.clawpage.ai" }) return
    webView.post {
      webView.evaluateJavascript("if(location.origin==='https://agent.clawpage.ai'){window.dispatchEvent(new CustomEvent('aio-google-return',{detail:$detail}));}", null)
    }
    pendingAuth = null
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveAuth(intent)
  }
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    authWebView = webView
    authReady = false
    followNetwork(webView)
    // The browser bridge is only injected into this exact origin. Subframes
    // and navigations to other sites receive no access to native operations.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(webView, "aioDeviceBrowser", setOf("https://agent.clawpage.ai")) { _, message, _, mainFrame, _ ->
        if (mainFrame) {
          if (message.data == "aioagent-auth-ready") { authReady = true; deliverAuth(); return@addWebMessageListener }
          val url = Uri.parse(message.data ?: "")
          if ((url.scheme == "https" || url.scheme == "http") && url.host != null) {
            try {
              // /google/start has just set the initiating HttpOnly cookie. Persist
              // it before switching apps: Android may kill this process while the
              // user is authorizing, and the callback must retain that binding.
              CookieManager.getInstance().flush()
              CustomTabsIntent.Builder()
                .setShowTitle(true)
                .setInitialActivityHeightPx((resources.displayMetrics.heightPixels * 0.9).toInt())
                .build().launchUrl(this, url)
            } catch (_: android.content.ActivityNotFoundException) {
              Toast.makeText(this, "未找到设备浏览器", Toast.LENGTH_LONG).show()
            }
          }
        }
      }
      // What is left of a transfer the app was closed in the middle of.
      cacheDir.listFiles { file -> file.name.startsWith("aio-save-") }?.forEach { it.delete() }
      WebViewCompat.addWebMessageListener(webView, "aioSaveMedia", setOf("https://agent.clawpage.ai")) { _, message, _, mainFrame, replyProxy ->
        if (!mainFrame) return@addWebMessageListener
        val body = try { JSONObject(message.data ?: "") } catch (_: JSONException) { return@addWebMessageListener }
        val seq = body.optInt("seq")
        saveMedia(body) { answer -> replyProxy.postMessage(answer.put("seq", seq).toString()) }
      }
    }
  }
  companion object {
    private const val STORAGE_REQUEST = 7301
  }
  override fun onDestroy() {
    networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
    networkCallback = null
    super.onDestroy()
  }
  override fun onPause() {
    super.onPause()
    CookieManager.getInstance().flush()
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    receiveAuth(intent)
    // Edge to edge, Android no longer shrinks the window for the keyboard, so a focused
    // field could sit under it. The page keeps the whole screen (it pads itself for the
    // status and navigation bars) and gives up the keyboard's height while it is shown.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(0, 0, 0, keyboard)
      insets
    }
  }
}
