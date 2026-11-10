package ai.clawpage.agent

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// This phone as an execution environment (docs/EXEC-ENVS.md, protocol 1) for the agent of the account signed
// in here: the app's own browser (AIBrowser.kt) and folder (DeviceFiles.kt), and what the person turns on one by
// one in the console: the calendar (DeviceCalendar.kt, which is when Android asks for the permission) and the
// photos they pick for it (DevicePhotos.kt). The app dials the control plane
// itself (the device-link socket the Mac and iPhone apps use, kind `android`) with a device token its account
// issued, and answers the agent's calls while it is on screen; in the background the socket closes and the
// agent is told to ask the person to open the app, as on the iPhone (DeviceTools.swift).
//
// Only the console's main frame may talk to it (`aioDeviceTools`, JSON strings with a `seq` its answer
// repeats, answered with the state). The token is in a file of the app's that backups leave out; the account
// it belongs to is kept beside it, and a console signed in as anyone else makes the app forget both.

private const val CONSOLE_HOST = "agent.clawpage.ai"
private const val LINK_URL = "wss://agent.clawpage.ai/api/device-link/connect"
private const val TAG = "aio-device-tools"

private fun trace(message: String) { Log.i(TAG, message) }

private fun failure(code: String, message: String = "") = JSONObject().put("ok", false).put("code", code).put("message", message)

/** What the person turns on one by one; the browser and folder come with the link itself. */
private enum class Ability(val key: String) { PHOTOS("photos"), CALENDAR("calendar") }

/** What the activity does for the console: Android's permission prompt and the system photo picker. */
interface DeviceToolsHost {
  fun askCalendar(done: (Boolean) -> Unit)
  fun pickPhotos(done: (List<Uri>) -> Unit)
}

object DeviceTools {
  private val main = Handler(Looper.getMainLooper())
  private lateinit var app: Context
  private var console: WeakReference<WebView>? = null
  private var installed = false
  @Volatile private var foreground = false
  /** A debug build linked from its launch extras: the console's account does not turn that link off. */
  private var testLink = false
  private var testURL: String? = null
  private var activity: WeakReference<Activity>? = null
  private val work = Executors.newSingleThreadExecutor()

  // What the person chose, and the token: a file in the app's no-backup folder (a restored backup on another phone must not carry it).

  private object Store {
    private var cached: JSONObject? = null
    private val file get() = File(app.noBackupFilesDir, "device-link.json")
    private fun read(): JSONObject = cached ?: (try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }).also { cached = it }
    private fun write(next: JSONObject) {
      cached = next
      val partial = File(file.path + ".part")
      partial.writeText(next.toString())
      partial.renameTo(file)
    }
    private fun value(key: String): String? = read().optString(key, "").ifEmpty { null }
    private fun keep(key: String, value: String?) = write(JSONObject(read().toString()).apply { if (value == null) remove(key) else put(key, value) })
    var token: String? get() = value("token"); set(v) = keep("token", v)
    var linkId: String? get() = value("linkId"); set(v) = keep("linkId", v)
    var account: String? get() = value("account"); set(v) = keep("account", v)
    fun enabled(ability: Ability): Boolean = read().optBoolean("enabled.${ability.key}")
    fun setEnabled(ability: Ability, on: Boolean) = write(JSONObject(read().toString()).put("enabled.${ability.key}", on))
    /** Whether Android was asked for the calendar once (after that, a refusal can be for good). */
    var askedCalendar: Boolean get() = read().optBoolean("asked.calendar"); set(v) { write(JSONObject(read().toString()).put("asked.calendar", v)) }
    /** Everything about the link goes, every ability is off and nothing stays shared: the next account starts from nothing. */
    fun forget() {
      write(JSONObject().put("asked.calendar", askedCalendar))
      DevicePhotos.remove(null)
    }
  }

  // Permissions: the calendar's is Android's; photos need none (the person picks each one).

  private fun calendarGranted(): Boolean = listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
    .all { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

  /** "authorized", "notDetermined" (Android will ask) or "denied" (only the app's system settings can allow it now). */
  private fun permission(ability: Ability): String = when {
    ability == Ability.PHOTOS || calendarGranted() -> "authorized"
    !Store.askedCalendar -> "notDetermined"
    activity?.get()?.shouldShowRequestPermissionRationale(Manifest.permission.READ_CALENDAR) == true -> "notDetermined"
    else -> "denied"
  }

  private fun usable(ability: Ability) = permission(ability) == "authorized"

  /** This phone, the same across launches and reinstalls of this app (ANDROID_ID is per app signing key), hashed. */
  private val deviceId: String by lazy {
    val raw = Settings.Secure.getString(app.contentResolver, Settings.Secure.ANDROID_ID) ?: "android"
    MessageDigest.getInstance("SHA-256").digest("aio-android:$raw".toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
  }

  private val name: String
    get() = (if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) else null)
      ?.takeIf { it.isNotBlank() } ?: Build.MODEL

  fun install(activity: Activity) {
    AIBrowser.attach(activity)
    this.activity = WeakReference(activity)
    if (installed) return
    installed = true
    app = activity.applicationContext
    DeviceFiles.init(app)
    DeviceCalendar.init(app)
    DevicePhotos.init(app)
    foreground = true
    ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
      override fun onStart(owner: LifecycleOwner) { foreground = true; link.cameToFront() }
      override fun onStop(owner: LifecycleOwner) { foreground = false; link.wentToBack() }
    })
    // A link made earlier connects for its account again; the console's next `account` confirms or forgets it.
    if (Store.token != null) link.wanted = true
  }

  /**
   * Debug builds only: `--es AIODeviceToolsLinkURL ws://localhost:<port>/api/device-link/connect
   * --es AIODeviceToolsLinkToken dl_… [--es AIOConfirmSeconds 4]` links the app to a local control plane without
   * the console. Release builds never read these extras (BuildConfig.DEBUG is a constant, so R8 removes this).
   */
  fun debugLink(intent: Intent?) {
    if (!BuildConfig.DEBUG || intent == null) return
    intent.getStringExtra("AIOConfirmSeconds")?.toDoubleOrNull()?.let { AIBrowser.confirmSeconds = it }
    val token = intent.getStringExtra("AIODeviceToolsLinkToken") ?: return
    testURL = intent.getStringExtra("AIODeviceToolsLinkURL")
    testLink = true
    link.wanted = false
    Store.token = token
    Store.linkId = "debug"
    Store.account = "debug"
    for (ability in Ability.values()) Store.setEnabled(ability, usable(ability))
    link.wanted = true
  }

  // What the agent may do here, and how a call reaches it

  private fun manifest(): JSONObject {
    val abilities = Ability.values().filter { Store.enabled(it) && usable(it) }.map { it.key }
    val env = JSONObject().put("deviceId", deviceId).put("kind", "android").put("name", name)
      .put("capabilities", JSONArray(listOf("browser", "files") + abilities)).put("foreground", foreground)
    return JSONObject().put("protocol", 1).put("envs", JSONArray().put(env))
  }

  /** One call (off the main thread); the browser's tools run on the main thread and are waited for here. */
  private fun call(body: JSONObject): JSONObject {
    val tool = body.optString("tool")
    if (body.optString("env") != deviceId || tool.isEmpty()) return failure("not_found", "not this phone")
    val args = body.optJSONObject("arguments") ?: JSONObject()
    if (tool.startsWith("files_")) {
      return try {
        val result = when (tool) {
          "files_list" -> DeviceFiles.list(args)
          "files_pull" -> DeviceFiles.pull(args)
          "files_push" -> DeviceFiles.push(args)
          else -> return failure("unknown_tool", tool)
        }
        JSONObject().put("ok", true).put("result", result)
      } catch (e: FilesError) {
        failure(e.code, e.message)
      } catch (e: Exception) {
        failure("failed", e.message ?: e.javaClass.simpleName)
      }
    }
    val ability = when { tool.startsWith("calendar_") -> Ability.CALENDAR; tool.startsWith("photos_") -> Ability.PHOTOS; else -> null }
    if (ability != null) {
      if (!Store.enabled(ability)) return failure("off", "${ability.key} is off")
      if (!usable(ability)) return failure("denied", permission(ability))
      return try {
        val result = when (tool) {
          "calendar_calendars" -> DeviceCalendar.list()
          "calendar_events" -> DeviceCalendar.events(args)
          "calendar_create_event" -> DeviceCalendar.create(args)
          "photos_albums" -> DevicePhotos.albums()
          "photos_list" -> DevicePhotos.list(args)
          "photos_get" -> DevicePhotos.fetch(args)
          else -> return failure("unknown_tool", tool)
        }
        JSONObject().put("ok", true).put("result", result)
      } catch (e: ToolError) {
        failure(e.code, e.message)
      } catch (e: SecurityException) {
        failure("denied", e.message ?: "")
      } catch (e: Exception) {
        failure("failed", e.message ?: e.javaClass.simpleName)
      }
    }
    if (!tool.startsWith("browser_")) return failure("unknown_tool", tool)
    val latch = CountDownLatch(1)
    val answered = AtomicBoolean(false)
    var answer = failure("failed", "no answer")
    val done: BrowserDone = { result, error ->
      if (answered.compareAndSet(false, true)) {
        answer = if (error != null) failure(error.code, error.message) else JSONObject().put("ok", true).put("result", result ?: JSONObject())
        latch.countDown()
      }
    }
    main.post {
      try {
        when (tool) {
          "browser_open" -> AIBrowser.open(args.optString("url"), done)
          "browser_read" -> AIBrowser.read(done)
          "browser_click" -> AIBrowser.click(args.optString("ref"), done)
          "browser_type" -> AIBrowser.type(args.optString("ref"), args.optString("text"), args.optBoolean("submit", false), done)
          "browser_scroll" -> AIBrowser.scroll(args.optString("direction", "down"), done)
          "browser_back" -> AIBrowser.back(done)
          "browser_screenshot" -> AIBrowser.screenshot(done)
          "browser_request_human" -> AIBrowser.requestHuman(args.optString("reason"), done)
          else -> done(null, BrowserError("unknown_tool", tool))
        }
      } catch (e: BrowserError) {
        done(null, e)
      }
    }
    // A person asked to act gets ten minutes; anything else is a page, which answers well within two.
    latch.await(if (tool == "browser_request_human") 610 else 120, TimeUnit.SECONDS)
    return answer
  }

  /** The endpoints this app has (protocol 1); anything else is not found. */
  private fun answer(method: String, path: String, body: ByteArray): Pair<Int, JSONObject> {
    if (method == "GET" && path == "/env/manifest") return 200 to manifest()
    if (method == "POST" && path == "/env/call") {
      val request = try { JSONObject(String(body)) } catch (_: JSONException) { return 200 to failure("invalid", "not JSON") }
      val started = System.currentTimeMillis()
      val answer = call(request)
      // The tool and how it went, never what it returned.
      trace("env call ${request.optString("tool", "-")} ok=${answer.optBoolean("ok")} code=${answer.optString("code", "-")} ms=${System.currentTimeMillis() - started}")
      return 200 to answer
    }
    return 404 to JSONObject()
  }

  // The socket to the control plane

  /** One WebSocket to the device-link endpoint, answering its `req` frames (deviceLink.ts). Main thread, except where it says. */
  class Link : WebSocketListener() {
    var state = "off"
      private set
    private val client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private val calls = Executors.newCachedThreadPool()
    private var socket: WebSocket? = null
    private var retry = 1L
    private var inflight = 0
    /** Whether the console here is signed in as the link's account (nothing connects before it says so). */
    var wanted = false
      set(value) { field = value; if (value) connect() else disconnect("off") }

    private val url: String get() = (if (BuildConfig.DEBUG) testURL else null) ?: LINK_URL

    fun connect() {
      val token = Store.token
      if (!wanted || socket != null || token == null || !foreground) return
      val request = Request.Builder().url(url)
        .header("Authorization", "Bearer $token")
        .header("x-aio-device-name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
        .build()
      socket = client.newWebSocket(request, this)
      set("connecting")
    }

    private fun set(next: String) {
      if (state == next) return
      state = next
      trace("link $next")
      publish()
    }

    /** Something the server should know unasked (`manifest`: what this phone offers changed). */
    fun event(name: String, data: JSONObject) {
      if (state != "online") return
      socket?.send(JSONObject().put("t", "event").put("name", name).put("data", data).toString())
    }

    fun disconnect(next: String) {
      socket?.close(1000, null)
      socket = null
      set(next)
    }

    fun cameToFront() {
      if (!wanted) return
      // Back on screen while still connected: the agent's brief should say so now.
      if (socket != null) { event("manifest", manifest()); return }
      retry = 1
      connect()
    }

    /** In the background the socket closes, after the calls in flight are answered, so the server says "open the app" at once. */
    fun wentToBack() {
      if (socket == null) return
      if (inflight == 0) finishBackground() else main.postDelayed({ finishBackground() }, 5000)
    }

    private fun finishBackground() {
      if (foreground || socket == null) return
      disconnect(if (wanted) "offline" else "off")
    }

    private fun revoked() {
      Store.forget()
      disconnect("revoked")
    }

    private fun failed(which: WebSocket) {
      if (which !== socket) return
      disconnect(if (wanted) "offline" else "off")
      if (!wanted || !foreground) return
      val wait = retry
      retry = minOf(retry * 2, 30)
      main.postDelayed({ connect() }, wait * 1000)
    }

    // OkHttp's thread: each goes to the main thread, for the socket it is about.

    override fun onOpen(webSocket: WebSocket, response: Response) {
      main.post { if (webSocket === socket) { retry = 1; set("online") } }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      main.post { if (webSocket === socket) handle(text, webSocket) }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
      // 4001: the console removed this phone.
      main.post { if (webSocket === socket) { if (code == 4001) revoked() else failed(webSocket) } }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      // A token the server no longer knows (removed while this app was away).
      main.post { if (webSocket === socket) { if (response?.code == 401) revoked() else failed(webSocket) } }
    }

    private fun handle(text: String, webSocket: WebSocket) {
      val frame = try { JSONObject(text) } catch (_: JSONException) { return }
      // This app offers no channels (no live screen): any that is asked for closes at once.
      if (frame.optString("t") == "open" && frame.has("ch")) {
        webSocket.send(JSONObject().put("t", "closed").put("ch", frame.getInt("ch")).put("code", 1011).toString())
        return
      }
      if (frame.optString("t") != "req" || !frame.has("id")) return
      val id = frame.getInt("id")
      val body = try { Base64.decode(frame.optString("body", ""), Base64.DEFAULT) } catch (_: IllegalArgumentException) { ByteArray(0) }
      inflight++
      calls.execute {
        val (status, answer) = answer(frame.optString("method"), frame.optString("path"), body)
        val reply = JSONObject().put("t", "res").put("id", id).put("status", status)
          .put("headers", JSONObject().put("content-type", "application/json"))
          .put("body", Base64.encodeToString(answer.toString().toByteArray(), Base64.NO_WRAP))
        main.post {
          inflight--
          webSocket.send(reply.toString())
          if (inflight == 0 && !foreground) finishBackground()
        }
      }
    }
  }

  val link = Link()

  // The console's bridge

  private fun status(): JSONObject = JSONObject()
    .put("linked", Store.token != null)
    .put("linkId", Store.linkId ?: JSONObject.NULL)
    .put("state", if (Store.token == null) (if (link.state == "revoked") "revoked" else "off") else link.state)
    .put("name", name)
    .put("abilities", JSONObject().apply {
      for (ability in Ability.values()) put(ability.key, JSONObject().put("enabled", Store.enabled(ability)).put("permission", permission(ability)))
      getJSONObject("photos").put("shared", DevicePhotos.count)
    })
    .put("app", try { app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "" } catch (_: Exception) { "" })

  private fun onConsole(webView: WebView): Boolean = Uri.parse(webView.url ?: "").let { it.scheme == "https" && it.host == CONSOLE_HOST }

  /** The state as it changes, for a settings page that is open. */
  private fun publish() {
    val webView = console?.get() ?: return
    if (!onConsole(webView)) return
    webView.evaluateJavascript("if(location.origin==='https://$CONSOLE_HOST'){window.dispatchEvent(new CustomEvent('aio-device-tools',{detail:${status()}}));}", null)
  }

  fun attachConsole(webView: WebView) { console = WeakReference(webView) }

  /** One message from the console's main frame; `reply` gets the state after it, or `{error}`. */
  fun fromConsole(text: String?, reply: (JSONObject) -> Unit) {
    val body = try { JSONObject(text ?: "") } catch (_: JSONException) { return }
    val seq = body.optInt("seq")
    val answer = { reply(status().put("seq", seq)) }
    val refuse = { code: String -> reply(JSONObject().put("error", code).put("seq", seq)) }
    when (body.optString("type")) {
      "status" -> answer()
      "account" -> {
        // The console says who is signed in (nobody: null). Another account makes this phone forget the link.
        val account = if (body.isNull("account")) null else body.optString("account")
        if (testLink) return answer()
        val stored = Store.account
        if (stored != null && account != null && stored != account) {
          link.wanted = false
          Store.forget()
        }
        link.wanted = account != null && account == Store.account && Store.token != null
        answer()
      }
      "link" -> {
        val token = body.optString("token")
        val linkId = body.optString("linkId")
        val account = body.optString("account")
        if (!Regex("^dl_[A-Za-z0-9_-]{43}$").matches(token) || linkId.isEmpty() || account.isEmpty()) return refuse("invalid")
        link.wanted = false
        Store.token = token
        Store.linkId = linkId
        Store.account = account
        testLink = false
        link.wanted = true
        answer()
      }
      "unlink" -> {
        link.wanted = false
        Store.forget()
        answer()
      }
      "enable", "disable" -> {
        val ability = Ability.values().firstOrNull { it.key == body.optString("ability") } ?: return refuse("invalid")
        val changed = {
          link.event("manifest", manifest())
          answer()
        }
        if (body.optString("type") == "disable") { Store.setEnabled(ability, false); return changed() }
        // The calendar's permission is asked now, while the person is turning it on, and only if Android still asks.
        val host = activity?.get() as? DeviceToolsHost
        if (ability == Ability.CALENDAR && permission(ability) == "notDetermined" && host != null) {
          Store.askedCalendar = true
          host.askCalendar { Store.setEnabled(ability, usable(ability)); changed() }
        } else {
          Store.setEnabled(ability, usable(ability))
          changed()
        }
      }
      "settings" -> {
        app.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", app.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        answer()
      }
      "photosAdd" -> {
        val host = activity?.get() as? DeviceToolsHost ?: return refuse("failed")
        host.pickPhotos { uris ->
          work.execute {
            DevicePhotos.add(uris)
            main.post { link.event("manifest", manifest()); answer() }
          }
        }
      }
      "photosShared" -> work.execute {
        val thumbs = DevicePhotos.thumbnails()
        main.post { reply(status().put("photos", thumbs).put("seq", seq)) }
      }
      "photosRemove" -> {
        val ids = body.optJSONArray("ids") ?: return refuse("invalid")
        work.execute {
          DevicePhotos.remove((0 until ids.length()).map { ids.optString(it) }.toSet())
          main.post { link.event("manifest", manifest()); answer() }
        }
      }
      else -> refuse("unknown")
    }
  }
}
