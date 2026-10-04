package com.mengxiao.aioagent

import android.os.Bundle
import android.net.Uri
import android.webkit.WebView
import android.widget.Toast
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // The browser bridge is only injected into this exact origin. Subframes
    // and navigations to other sites receive no access to native operations.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(webView, "aioDeviceBrowser", setOf("https://agent.clawpage.ai")) { _, message, _, mainFrame, _ ->
        if (mainFrame) {
          val url = Uri.parse(message.data ?: "")
          if ((url.scheme == "https" || url.scheme == "http") && url.host != null) {
            try {
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
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
