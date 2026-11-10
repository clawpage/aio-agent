package ai.clawpage.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference

// The agent's own browser on this phone (docs/EXEC-ENVS.md, capability `browser`): a second web view the
// agent drives through aio_env (browser_open, browser_read, …, answered by DeviceTools.kt), shown to the
// person as a small live window over the console that opens full screen, where they can watch, take over
// and hand back. It keeps its own sign-ins (a WebView profile of its own, apart from the console's).
//
// Android's WebView has no isolated script world: whatever runs here runs in the page's own world. So the
// scripts leave nothing behind (each is a function that returns; no global, attribute, node or patched
// prototype), and an element's ref is its place in the same enumeration of the page's controls on every
// call, checked against a fingerprint from the last read. Clicks, typing and scrolling are real input
// (touches, the keyboard's text, key events), so a page sees trusted events, as from the person.
//
// Paying, ordering, sending, deleting and signing in or authorizing are never done on the agent's word:
// such a click first asks the person here, and the call answers `needs_confirmation` (or `declined`)
// until they tap.

class BrowserError(val code: String, override val message: String) : Exception(message)

typealias BrowserDone = (JSONObject?, BrowserError?) -> Unit

/** Words on a control that mean money, sending, deleting or signing in: the person confirms those on the phone. */
private val SENSITIVE = Regex(
  "\\b(pay|checkout|check out|(place|submit) (your )?order|buy now|purchase|subscribe|confirm (payment|order)|send|post|publish|delete|remove|sign in|log in|login|authori[sz]e|allow|grant|transfer)\\b|支付|付款|购买|購買|下单|下單|提交订单|提交訂單|立即购买|结算|結算|发送|發送|发布|發布|删除|刪除|移除|登录|登入|授权|授權|允许|允許|转账|轉帳|確認付款|确认付款",
  RegexOption.IGNORE_CASE,
)

private const val PROFILE = "ai-browser"
private const val TAG = "aio-device-tools"

/**
 * The page's controls, in document order, as every script here finds them: `all()` and the fingerprint `fp(el)`
 * a ref is checked against. Plain declarations inside each script's own function, so nothing outlives it.
 */
private val CONTROLS = """
  const all = () => {
    const out = [];
    for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick], [contenteditable=true]')) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
      out.push(el);
      if (out.length >= 200) break;
    }
    return out;
  };
  const fp = (el) => [el.tagName, el.type || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id,
    /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ? '' : (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), el.getAttribute('href') || ''].join('|');
"""

/** Where the element's centre is on screen, and whether that point is the element itself (nothing covers it). */
private val GEOMETRY = """
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return { x: cx - vv.offsetLeft, y: cy - vv.offsetTop, vw: vv.width, vh: vv.height, clear: !!hit && (hit === el || el.contains(hit)) };
"""

/** The page's text and its controls, each with a ref for click and type, and the fingerprint the app keeps for it. */
private val READ = """(() => {
  $CONTROLS
  const elements = all().map((el, i) => {
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase());
    return Object.assign({ ref: 'e' + (i + 1), role, name, fp: fp(el) }, el.tagName === 'A' ? { href: el.href.slice(0, 200) } : {});
  });
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 20000);
  return { url: location.href, title: document.title, text, elements };
})()"""

object AIBrowser {
  private val main = Handler(Looper.getMainLooper())
  private var activity: WeakReference<Activity>? = null
  private var view: WebView? = null
  private var panel: BrowserPanel? = null
  private val loads = ArrayList<(BrowserError?) -> Unit>()
  /** The page is on its way to another one (started, not there yet). */
  private var navigating = false
  /** The fingerprint of each ref from the last read. */
  private var refs: Map<String, String> = emptyMap()
  private var humanWait: ((Boolean) -> Unit)? = null

  /** How long a confirmation waits for the person; a debug build can shorten it for tests (`AIOConfirmSeconds`). */
  var confirmSeconds = 90.0

  fun attach(activity: Activity) {
    if (this.activity?.get() === activity) return
    // A new activity (the old one went with its views): the browser starts again in this one.
    panel?.let { (it.parent as? ViewGroup)?.removeView(it) }
    view?.destroy()
    view = null
    panel = null
    this.activity = WeakReference(activity)
  }

  private fun browser(): WebView {
    view?.let { return it }
    val activity = activity?.get() ?: throw BrowserError("off", "the app is not open")
    val webView = WebView(activity)
    // Its own cookies and storage, kept across launches, never the console's.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      ProfileStore.getInstance().getOrCreateProfile(PROFILE)
      WebViewCompat.setProfile(webView, PROFILE)
    }
    webView.settings.apply {
      @SuppressLint("SetJavaScriptEnabled")
      javaScriptEnabled = true
      domStorageEnabled = true
      // Laid out and zoomed as Chrome lays out a page, not at the web view's defaults.
      useWideViewPort = true
      loadWithOverviewMode = true
      builtInZoomControls = true
      displayZoomControls = false
      setSupportMultipleWindows(false)
    }
    // Pages are not told which app they are in (WebView's X-Requested-With header names it). The emulator's
    // WebView 124 still sent it on a main-frame navigation with this set; it is the only control WebView offers.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) WebSettingsCompat.setRequestedWithHeaderOriginAllowList(webView.settings, emptySet())
    val cookies = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getProfile(PROFILE)?.cookieManager else null
    (cookies ?: CookieManager.getInstance()).setAcceptThirdPartyCookies(webView, true)
    webView.webViewClient = Client
    view = webView
    panel = BrowserPanel(activity, webView)
    return webView
  }

  private object Client : WebViewClient() {
    /** Only web pages: no app links, intents, files or other schemes from what the agent opens. */
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      request.url.scheme?.lowercase() !in setOf("http", "https", "about", "blob", "data")

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { navigating = true }
    override fun onPageFinished(view: WebView, url: String?) { finishLoads(null) }
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (request.isForMainFrame) finishLoads(BrowserError("failed", error.description.toString()))
    }

    /** A page that crashed its renderer takes only this browser with it, not the app. */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      if (view === AIBrowser.view) {
        panel?.let { (it.parent as? ViewGroup)?.removeView(it) }
        AIBrowser.view = null
        panel = null
        finishLoads(BrowserError("failed", "the page crashed; open it again"))
      }
      view.destroy()
      return true
    }
  }

  // Tools (main thread; each answers once)

  fun open(raw: String, done: BrowserDone) {
    val scheme = Uri.parse(raw).scheme?.lowercase()
    if (scheme != "https" && scheme != "http") return done(null, BrowserError("invalid", "only http(s) addresses"))
    val webView = browser()
    panel!!.show(expanded = false)
    waitLoad(30_000) { error ->
      if (error != null) done(null, error) else done(JSONObject().put("url", webView.url ?: raw).put("title", webView.title ?: ""), null)
    }
    webView.loadUrl(raw)
  }

  fun read(done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    evaluate(webView, READ) { value ->
      val page = value as? JSONObject ?: return@evaluate done(null, BrowserError("failed", "the page could not be read"))
      val elements = page.optJSONArray("elements") ?: JSONArray()
      val kept = HashMap<String, String>()
      for (i in 0 until elements.length()) {
        val element = elements.getJSONObject(i)
        kept[element.getString("ref")] = element.remove("fp") as? String ?: ""
      }
      refs = kept
      done(page, null)
    }
  }

  fun click(ref: String, done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    act(webView, ref, "const form = el.closest('form'); return { label: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 120), action: form ? (form.getAttribute('action') || '') : '' };") { target ->
      if (target !is JSONObject) return@act done(null, changed(ref))
      val label = target.optString("label")
      val press = { press(webView, ref, done) }
      if (!SENSITIVE.containsMatchIn("$label ${target.optString("action")}")) return@act press()
      val site = Uri.parse(webView.url ?: "").host ?: ""
      confirm("${if (label.isEmpty()) ref else "“$label”"} — $site") { allowed ->
        when (allowed) {
          true -> press()
          false -> done(null, BrowserError("declined", label))
          null -> done(null, BrowserError("needs_confirmation", "${label.ifEmpty { ref }} on $site"))
        }
      }
    }
  }

  /** A touch on the element's centre; a script click only when something covers it or it cannot be brought on screen. */
  private fun press(webView: WebView, ref: String, done: BrowserDone) {
    locate(webView, ref) { geometry ->
      if (geometry == null) return@locate done(null, changed(ref))
      navigating = false
      // A click that leads to another page answers once that page is there, so the next read is of it.
      val after = {
        main.postDelayed({
          val answer = { done(JSONObject().put("clicked", ref).put("url", webView.url ?: ""), null) }
          if (navigating) waitLoad(15_000) { answer() } else answer()
        }, 600)
      }
      val point = point(webView, geometry)
      if (point == null) {
        Log.i(TAG, "browser click by script (covered or off screen)")
        act(webView, ref, "el.click(); return true;") { after() }
      } else {
        tap(webView, point.first, point.second)
        after()
      }
    }
  }

  fun type(ref: String, text: String, submit: Boolean, done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    val check = """
      if ((el.type || '').toLowerCase() === 'password') return { refuse: 'password' };
      if (el.tagName === 'SELECT') return { refuse: 'select' };
      if (!(el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type || '')))) return null;
      return { before: el.isContentEditable ? el.innerText : el.value };
    """
    act(webView, ref, check) { field ->
      if (field !is JSONObject) return@act done(null, BrowserError("not_found", "no field $ref; read the page again"))
      when (field.optString("refuse")) {
        "password" -> return@act done(null, BrowserError("invalid", "passwords are typed by the user: ask them with browser_request_human"))
        // A select's list is drawn by the system, outside the page: its value is set by script.
        "select" -> return@act setByScript(webView, ref, text) { finishTyping(webView, ref, submit, done) }
      }
      val before = field.optString("before")
      locate(webView, ref) located@{ geometry ->
        if (geometry == null) return@located done(null, changed(ref))
        val point = point(webView, geometry)
        webView.requestFocus()
        if (point != null) tap(webView, point.first, point.second) else act(webView, ref, "el.focus(); return true;") {}
        // The text goes in once the tap has focused the field (a page laid out for desktops holds a tap back
        // while it waits for a double tap) and the keyboard's connection has followed the focus.
        focused(webView, ref, 0) {
          commitText(webView, text) {
            act(webView, ref, "return el.isContentEditable ? el.innerText : el.value;") { now ->
              val value = now as? String ?: return@act done(null, changed(ref))
              // The page may reformat what it got (a phone number, a card); only nothing at all means the keyboard missed.
              if (value == text || value != before) finishTyping(webView, ref, submit, done)
              else {
                Log.i(TAG, "browser type by script (the keyboard's text did not arrive)")
                setByScript(webView, ref, text) { finishTyping(webView, ref, submit, done) }
              }
            }
          }
        }
      }
    }
  }

  private fun focused(webView: WebView, ref: String, tries: Int, then: () -> Unit) {
    main.postDelayed({
      act(webView, ref, "return document.activeElement === el;") { yes -> if (yes == true || tries >= 12) main.postDelayed(then, 150) else focused(webView, ref, tries + 1, then) }
    }, 120)
  }

  private fun finishTyping(webView: WebView, ref: String, submit: Boolean, done: BrowserDone) {
    if (!submit) {
      hideKeyboard(webView)
      return done(JSONObject().put("typed", ref), null)
    }
    navigating = false
    key(webView, KeyEvent.KEYCODE_ENTER)
    hideKeyboard(webView)
    main.postDelayed({
      val answer = { done(JSONObject().put("typed", ref), null) }
      if (navigating) waitLoad(15_000) { answer() } else answer()
    }, 600)
  }

  fun scroll(direction: String, done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    val h = webView.height.toFloat()
    // A finger's swipe over most of the page, held still at the end so it does not fling on.
    val (from, to) = if (direction == "up") h * 0.2f to h * 0.85f else h * 0.85f to h * 0.2f
    swipe(webView, webView.width / 2f, from, to) {
      main.postDelayed({ evaluate(webView, "window.scrollY") { value -> done(JSONObject().put("scrollY", (value as? Number)?.toDouble() ?: 0.0), null) } }, 250)
    }
  }

  fun back(done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    if (!webView.canGoBack()) return done(null, BrowserError("invalid", "no page to go back to"))
    waitLoad(15_000) { done(JSONObject().put("url", webView.url ?: "").put("title", webView.title ?: ""), null) }
    webView.goBack()
  }

  fun screenshot(done: BrowserDone) {
    val webView = shown() ?: return done(null, noPage())
    // After the panel's layout, so a browser just shown again has its size.
    main.post {
      if (webView.width <= 0 || webView.height <= 0) return@post done(null, BrowserError("failed", "no picture"))
      val bitmap = Bitmap.createBitmap(webView.width, webView.height, Bitmap.Config.ARGB_8888)
      webView.draw(Canvas(bitmap))
      Thread {
        val width = minOf(bitmap.width, 1080)
        val picture = if (width == bitmap.width) bitmap else Bitmap.createScaledBitmap(bitmap, width, bitmap.height * width / bitmap.width, true)
        val png = ByteArrayOutputStream().also { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        main.post { done(JSONObject().put("image", Base64.encodeToString(png, Base64.NO_WRAP)).put("mimeType", "image/png"), null) }
      }.start()
    }
  }

  /** The person does a step themselves: the browser opens full screen with the agent's reason, until they hand it back. */
  fun requestHuman(reason: String, done: BrowserDone) {
    browser()
    humanWait?.invoke(false)
    var answered = false
    val wait = { handedBack: Boolean ->
      if (!answered) {
        answered = true
        humanWait = null
        if (handedBack) done(JSONObject().put("handedBack", true).put("url", view?.url ?: ""), null)
        else done(null, BrowserError("busy", "another request took its place"))
      }
    }
    humanWait = wait
    panel!!.show(expanded = true, ask = reason) { humanWait?.invoke(true) }
    // The agent's call ends after 10 minutes; the person can still hand back later by asking again.
    main.postDelayed({
      if (!answered) {
        answered = true
        if (humanWait === wait) humanWait = null
        done(null, BrowserError("needs_confirmation", "still waiting for the user to finish in the browser"))
      }
    }, 600_000)
  }

  // Helpers

  /** The browser with a page in it, on screen (a page that is not shown is hidden from itself, and takes no touch). */
  private fun shown(): WebView? {
    val webView = view ?: return null
    if (webView.url == null) return null
    panel?.reveal()
    return webView
  }

  private fun noPage() = BrowserError("invalid", "no page is open; use browser_open first")
  private fun changed(ref: String) = BrowserError("not_found", "no element $ref; the page changed, read the page again")

  /** Asks the person on the phone; null when nobody answers in time (the dialog goes away). */
  private fun confirm(what: String, answer: (Boolean?) -> Unit) {
    val activity = activity?.get() ?: return answer(null)
    panel?.show(expanded = true)
    var answered = false
    val finish = { value: Boolean? -> if (!answered) { answered = true; answer(value) } }
    val dialog = AlertDialog.Builder(activity)
      .setTitle(R.string.aio_confirm_title)
      .setMessage(what)
      .setNegativeButton(R.string.aio_confirm_decline) { _, _ -> finish(false) }
      .setPositiveButton(R.string.aio_confirm_allow) { _, _ -> finish(true) }
      .setOnCancelListener { finish(false) }
      .show()
    main.postDelayed({
      if (!answered) {
        finish(null)
        dialog.dismiss()
      }
    }, (confirmSeconds * 1000).toLong())
  }

  private fun waitLoad(ms: Long, then: (BrowserError?) -> Unit) {
    var answered = false
    val once = { error: BrowserError? -> if (!answered) { answered = true; then(error) } }
    loads.add(once)
    main.postDelayed({ loads.remove(once); once(null) }, ms)
  }

  private fun finishLoads(error: BrowserError?) {
    navigating = false
    val waiting = loads.toList()
    loads.clear()
    waiting.forEach { it(error) }
  }

  /** A script in the page; its value as JSON (an object, array, string, number, boolean or null). */
  private fun evaluate(webView: WebView, script: String, done: (Any?) -> Unit) {
    webView.evaluateJavascript(script) { raw ->
      done(try { JSONTokener(raw ?: "null").nextValue().takeIf { it != JSONObject.NULL } } catch (_: Exception) { null })
    }
  }

  /**
   * `body` with `el`, the element a ref from the last read names, when it is still the same one; null otherwise.
   * The ref is its place among the page's controls, so the same enumeration finds it again.
   */
  private fun act(webView: WebView, ref: String, body: String, done: (Any?) -> Unit) {
    val index = ref.removePrefix("e").toIntOrNull()
    val print = refs[ref]
    if (index == null || print == null) return done(null)
    evaluate(webView, "(() => {\n$CONTROLS\nconst el = all()[${index - 1}];\nif (!el || fp(el) !== ${JSONObject.quote(print)}) return null;\n$body\n})()", done)
  }

  /**
   * The element brought into view and measured once the page holds still: a scroll, a keyboard going away or
   * the page zooming to fit new content all move it, and a touch has to land where it is when it lands.
   */
  private fun locate(webView: WebView, ref: String, then: (JSONObject?) -> Unit) {
    act(webView, ref, "el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true;") { found ->
      if (found != true) return@act then(null)
      var last: JSONObject? = null
      var tries = 0
      fun measure() {
        main.postDelayed({
          act(webView, ref, GEOMETRY) { geometry ->
            if (geometry !is JSONObject) return@act then(null)
            val before = last
            val still = before != null && listOf("x", "y", "vw", "vh").all { Math.abs(before.optDouble(it) - geometry.optDouble(it)) < 0.5 }
            if (still || ++tries >= 8) then(geometry) else { last = geometry; measure() }
          }
        }, 120)
      }
      measure()
    }
  }

  /** The element's centre in the web view's pixels, when the page says it is on screen and not covered. */
  private fun point(webView: WebView, geometry: JSONObject): Pair<Float, Float>? {
    val vw = geometry.optDouble("vw", 0.0)
    if (!geometry.optBoolean("clear") || vw <= 0 || webView.width <= 0) return null
    val scale = webView.width / vw
    val x = (geometry.optDouble("x") * scale).toFloat()
    val y = (geometry.optDouble("y") * scale).toFloat()
    if (x < 0 || y < 0 || x >= webView.width || y >= webView.height) return null
    return x to y
  }

  private fun motion(action: Int, down: Long, at: Long, x: Float, y: Float): MotionEvent {
    val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
    val coords = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 0.05f }
    return MotionEvent.obtain(down, at, action, 1, arrayOf(pointer), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
  }

  private fun send(webView: WebView, event: MotionEvent) {
    webView.dispatchTouchEvent(event)
    event.recycle()
  }

  /** A finger's tap, as the touch screen gives it. */
  private fun tap(webView: WebView, x: Float, y: Float) {
    val down = SystemClock.uptimeMillis()
    send(webView, motion(MotionEvent.ACTION_DOWN, down, down, x, y))
    main.postDelayed({ send(webView, motion(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x, y)) }, 80)
  }

  private fun swipe(webView: WebView, x: Float, from: Float, to: Float, then: () -> Unit) {
    val down = SystemClock.uptimeMillis()
    val steps = 12
    send(webView, motion(MotionEvent.ACTION_DOWN, down, down, x, from))
    for (i in 1..steps) {
      main.postDelayed({ send(webView, motion(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), x, from + (to - from) * i / steps)) }, 25L * i)
    }
    main.postDelayed({ send(webView, motion(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), x, to)) }, 25L * steps + 120)
    main.postDelayed({ send(webView, motion(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x, to)); then() }, 25L * steps + 160)
  }

  private fun key(webView: WebView, code: Int) {
    val down = SystemClock.uptimeMillis()
    webView.dispatchKeyEvent(KeyEvent(down, down, KeyEvent.ACTION_DOWN, code, 0))
    webView.dispatchKeyEvent(KeyEvent(down, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0))
  }

  /**
   * The text as the keyboard gives it, through the web view's own input connection: replaces what the
   * focused field holds, in any script (Chinese too). Answers whether the connection took it.
   */
  private fun commitText(webView: WebView, text: String, then: (Boolean) -> Unit) {
    val connection = webView.onCreateInputConnection(EditorInfo())
    if (connection == null) {
      // No connection to the field: the same text as one key event, which the web view commits the same way.
      @Suppress("DEPRECATION")
      val sent = webView.dispatchKeyEvent(KeyEvent(SystemClock.uptimeMillis(), text, KeyCharacterMap.VIRTUAL_KEYBOARD, 0))
      return then(sent)
    }
    (connection.handler ?: main).post {
      connection.performContextMenuAction(android.R.id.selectAll)
      val ok = connection.commitText(text, 1)
      main.post { then(ok) }
    }
  }

  private fun hideKeyboard(webView: WebView) {
    (webView.context.getSystemService(Activity.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(webView.windowToken, 0)
  }

  /** The value set by script and the page told as an input would tell it: for a select, or when the keyboard's text did not arrive. */
  private fun setByScript(webView: WebView, ref: String, text: String, then: () -> Unit) {
    val value = JSONObject.quote(text)
    act(webView, ref, """
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (el.isContentEditable) el.textContent = $value; else if (setter && setter.set) setter.set.call(el, $value); else el.value = $value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    """) { then() }
  }
}

/**
 * The browser as the person sees it: a small live window over the console, or full screen. The page keeps
 * the panel's full size either way (the small window is the same view scaled down), so what the agent reads
 * and pictures does not change with it, and a touch the agent gives lands where it would full screen.
 */
@SuppressLint("ViewConstructor")
private class BrowserPanel(private val activity: Activity, private val webView: WebView) : FrameLayout(activity) {
  private val banner = TextView(activity)
  private val doneButton = Button(activity, null, android.R.attr.borderlessButtonStyle)
  private val doneBox = FrameLayout(activity)
  private val dot = View(activity)
  private val frame = GradientDrawable()
  private val outline = GradientDrawable()
  // The console's colors (src/ui/src/theme.css), dark or light by the system's setting.
  private val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
  private fun tone(dark: Long, light: Long) = (0xff000000L or (if (night) dark else light)).toInt()
  private val surface = tone(0x1a1823, 0xffffff)
  private val hairline = tone(0x2d2939, 0xe6e3ee)
  private val ink = tone(0xecebf3, 0x1d1b26)
  private val inkDim = tone(0x9d98ae, 0x6b6878)
  /** Indigo: the AI is working. Amber: the person's turn. */
  private val ai = tone(0x8f86ff, 0x5a4fe0)
  private val you = tone(0xffb547, 0xa15f00)
  private val youSoft = tone(0x3a2c16, 0xfff3df)
  private val onYou = tone(0x1b1200, 0xffffff)
  private var expanded = false
  private var turn = ai
  private var onDone: (() -> Unit)? = null
  private val hide = Runnable { close() }
  private val back = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() { if (webView.canGoBack()) webView.goBack() else show(expanded = false) }
  }

  private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics)

  init {
    val card = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      background = frame.apply { setColor(surface) }
      // Over the page, which would cover a stroke on the background.
      foreground = outline
      clipToOutline = true
      elevation = dp(8)
    }
    val bar = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16).toInt(), 0, dp(4).toInt(), 0)
    }
    // The dot says whose turn it is, as the console does.
    bar.addView(dot, LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply { marginEnd = dp(8).toInt() })
    bar.addView(TextView(activity).apply { setText(R.string.aio_browser_title); setTextColor(ink); textSize = 15f; typeface = android.graphics.Typeface.DEFAULT_BOLD }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    val action = { label: Int, then: () -> Unit ->
      bar.addView(Button(activity, null, android.R.attr.borderlessButtonStyle).apply { setText(label); isAllCaps = false; textSize = 14f; setTextColor(inkDim); minWidth = 0; minimumWidth = 0; setOnClickListener { then() } })
    }
    action(R.string.aio_browser_minimize) { show(expanded = false) }
    action(R.string.aio_browser_close) { close() }
    banner.setPadding(dp(16).toInt(), dp(10).toInt(), dp(16).toInt(), dp(10).toInt())
    banner.textSize = 13f
    banner.setTextColor(ink)
    // Two lines of what is asked, so the page keeps the screen; a tap shows all of it.
    banner.maxLines = 2
    banner.ellipsize = android.text.TextUtils.TruncateAt.END
    banner.setOnClickListener { banner.maxLines = if (banner.maxLines == 2) Int.MAX_VALUE else 2 }
    banner.setBackgroundColor(youSoft)
    // The person's turn: the one filled amber control on the screen.
    doneButton.setText(R.string.aio_browser_done)
    doneButton.isAllCaps = false
    doneButton.textSize = 16f
    doneButton.typeface = android.graphics.Typeface.DEFAULT_BOLD
    doneButton.setTextColor(onYou)
    doneButton.background = GradientDrawable().apply { cornerRadius = dp(12); setColor(you) }
    doneBox.setBackgroundColor(surface)
    doneBox.addView(doneButton, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48).toInt()).apply { setMargins(dp(16).toInt(), dp(10).toInt(), dp(16).toInt(), dp(10).toInt()) })
    // Handed back: the agent carries on, so the browser goes back to the small window and the console is in front again.
    doneButton.setOnClickListener { val done = onDone; onDone = null; setAsk(null); show(expanded = false); done?.invoke() }
    card.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48).toInt()))
    card.addView(View(activity).apply { setBackgroundColor(hairline) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
    card.addView(banner, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    card.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    card.addView(doneBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(card, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setAsk(null)
    // Clear of the status and navigation bars (the window is edge to edge).
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> place(animate = false) }
    (activity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(back)
  }

  private fun setAsk(reason: String?) {
    banner.text = reason?.let { "${resources.getString(R.string.aio_browser_asks)} $it" }
    banner.maxLines = 2
    banner.visibility = if (reason == null) View.GONE else View.VISIBLE
    doneBox.visibility = banner.visibility
    val turn = if (reason == null) ai else you
    dot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(turn) }
    this.turn = turn
    place(animate = false)
  }

  /** Full screen, or a live thumbnail of the page at the top right, under the console's header. */
  private fun place(animate: Boolean) {
    val scale = if (expanded || width == 0) 1f else dp(128) / width
    // Full screen has no frame; the small window's outline is drawn thick enough to survive the scaling.
    for (shape in listOf(frame, outline)) shape.cornerRadius = if (expanded) 0f else dp(12) / scale
    outline.setStroke(if (expanded) 0 else (dp(2) / scale).toInt(), turn)
    pivotX = width.toFloat()
    pivotY = 0f
    val tx = if (expanded) 0f else -dp(12)
    // The scaled view keeps (a scaled) status-bar padding of its own above the card.
    val ty = if (expanded) 0f else paddingTop * (1 - scale) + dp(52)
    animate().cancel()
    // Not before the first layout: there is no size to scale from yet (the layout that follows places it).
    if (animate && width > 0) animate().scaleX(scale).scaleY(scale).translationX(tx).translationY(ty).setDuration(250).start()
    else { scaleX = scale; scaleY = scale; translationX = tx; translationY = ty }
  }

  fun show(expanded: Boolean, ask: String? = null, onDone: (() -> Unit)? = null) {
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    if (parent == null) {
      content.addView(this, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      // The window's insets were given out before this view was there.
      ViewCompat.requestApplyInsets(this)
    }
    visibility = View.VISIBLE
    bringToFront()
    this.expanded = expanded
    if (ask != null) { setAsk(ask); this.onDone = onDone }
    back.isEnabled = expanded
    place(animate = true)
    // Out of the way once the agent has not used it for a while.
    removeCallbacks(hide)
    if (!expanded) postDelayed(hide, 180_000)
  }

  /** On screen again, as it was (the small window when it had been closed). */
  fun reveal() {
    if (parent == null || visibility != View.VISIBLE) show(expanded = false)
    else if (!expanded) { removeCallbacks(hide); postDelayed(hide, 180_000) }
  }

  private fun close() {
    visibility = View.GONE
    expanded = false
    back.isEnabled = false
  }

  // The small window is one button: a tap opens it full screen. The agent's own touches go to the page directly.
  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = !expanded

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (expanded) return super.onTouchEvent(ev)
    if (ev.actionMasked == MotionEvent.ACTION_UP) show(expanded = true)
    return true
  }
}
