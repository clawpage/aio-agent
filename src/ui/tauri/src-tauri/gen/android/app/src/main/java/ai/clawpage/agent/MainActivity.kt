package ai.clawpage.agent

import android.os.Bundle
import android.content.Intent
import org.json.JSONObject
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
    }
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
