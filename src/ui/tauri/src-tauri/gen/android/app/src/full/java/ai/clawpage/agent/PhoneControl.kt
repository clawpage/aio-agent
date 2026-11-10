package ai.clawpage.agent

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import com.flyfishxu.kadb.Kadb
import com.flyfishxu.kadb.cert.KadbCert
import com.flyfishxu.kadb.cert.OkioFilePrivateKeyStore
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toOkioPath
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// The side-loaded app's control of its own phone (docs/EXEC-ENVS.md, "The side-loaded Android app"): other apps and
// the screen for the agent, as a phone on a Mac's USB has them, without the Mac.
//
// The person pairs the app once with the phone's own wireless debugging (Developer options → Wireless debugging →
// Pair device with pairing code; the code goes into this app's notification). The app is then its own adb client
// (Kadb, over 127.0.0.1): it reads the shell user's id, grants itself WRITE_SECURE_SETTINGS (so it can turn
// wireless debugging on and off from then on) and starts the shell helper (ShellHelper.kt) from its own APK. The
// tools (PhoneTools.kt) run through the helper; the adb connection is closed once it runs. While it runs a
// foreground service (ControlService.kt) keeps the device link up in the background and shows Stop, which ends the
// helper and turns wireless debugging off. Unlinking the phone also deletes the adb key and gives the permission back.

private const val TAG = "aio-control"
private const val CHANNEL = "control"
const val PAIRING_NOTIFICATION = 7401
const val CONTROL_NOTIFICATION = 7402
const val ACTION_PAIR = "ai.clawpage.agent.PAIR"
const val ACTION_STOP = "ai.clawpage.agent.STOP"
const val PAIR_CODE = "code"
private const val PAIRING_TYPE = "_adb-tls-pairing._tcp"
private const val CONNECT_TYPE = "_adb-tls-connect._tcp"
private const val SHELL_UID = 2000

private fun trace(message: String) { Log.i(TAG, message) }

object PhoneControl {
  private lateinit var app: Context
  private var changed: () -> Unit = {}
  private val work = Executors.newSingleThreadExecutor()
  @Volatile private var state = "off"
  @Volatile private var error: String? = null
  @Volatile private var shellUid: Int? = null
  @Volatile private var helper: HelperClient? = null
  @Volatile private var tools: PhoneTools? = null

  // What survives a restart of the app: whether it was paired, and the running helper's port, token and the phone's serial.

  private object Store {
    private val file get() = File(app.noBackupFilesDir, "control.json")
    private fun read(): JSONObject = try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }
    private fun write(next: JSONObject) { val part = File(file.path + ".part"); part.writeText(next.toString()); part.renameTo(file) }
    var paired: Boolean get() = read().optBoolean("paired"); set(v) = write(read().put("paired", v))
    var serial: String? get() = read().optString("serial", "").ifEmpty { null }; set(v) = write(read().put("serial", v ?: ""))
    fun helper(): Pair<Int, String>? = read().let { if (it.optInt("port") > 0 && it.optString("token").isNotEmpty()) it.getInt("port") to it.getString("token") else null }
    fun setHelper(port: Int, token: String?) = write(read().put("port", port).put("token", token ?: ""))
    fun clear() { file.delete() }
  }

  private val keyFile get() = File(app.noBackupFilesDir, "adb/adbkey.pem")

  fun init(app: Context, changed: () -> Unit) {
    this.changed = changed
    if (::app.isInitialized) return
    this.app = app
    // Kadb keeps this app's adb key here (no backup: a key restored on another phone would be paired with nothing).
    KadbCert.configure(OkioFilePrivateKeyStore(keyFile.toOkioPath()))
    state = if (Store.paired) "stopped" else "off"
    // A helper started before the app was last closed is used again if it still runs.
    if (Store.helper() != null) work.execute { attach() }
    if (BuildConfig.DEBUG) debugPairing()
  }

  /** For the notification's receiver in a process the activity has not started. */
  fun ensure(context: Context) { if (!::app.isInitialized) init(context.applicationContext) { } }

  fun stopSoon() = work.execute { stop() }

  val keepsLink: Boolean get() = helper != null

  fun capabilities(): List<String> = if (helper != null) listOf("apps", "screen") else emptyList()

  /** The phone's adb serial: a Mac it is plugged into lists it by that, and the control plane makes the two one environment. */
  fun aliases(): List<String> = Store.serial?.let { listOf(it) } ?: emptyList()

  fun call(tool: String, args: JSONObject): JSONObject {
    val tools = tools ?: return failure("off", "this phone's apps and screen are off: ask the user to start them in the 一站 app (Settings → Android phone)")
    return try {
      JSONObject().put("ok", true).put("result", tools.call(tool, args))
    } catch (e: PhoneToolError) {
      failure("failed", e.message ?: "")
    } catch (e: Exception) {
      // The helper is gone (Stop, a reboot): say so, and stop offering the tools.
      trace("helper failed: ${e.javaClass.simpleName}")
      work.execute { if (helper != null && !alive()) detach("stopped") }
      failure("failed", e.message ?: e.javaClass.simpleName)
    }
  }

  private fun failure(code: String, message: String) = JSONObject().put("ok", false).put("code", code).put("message", message)

  fun status(): JSONObject = JSONObject()
    .put("state", state)
    .put("paired", Store.paired)
    .put("error", error ?: JSONObject.NULL)
    .put("shellUid", shellUid ?: JSONObject.NULL)
    .put("wirelessDebugging", Settings.Global.getInt(app.contentResolver, "adb_wifi_enabled", 0) == 1)

  fun fromConsole(body: JSONObject, activity: Activity?, done: () -> Unit): Boolean {
    when (body.optString("action")) {
      "pair" -> {
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          activity?.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7303)
        }
        set("pairing")
        Discovery.watch(PAIRING_TYPE)
        Discovery.watch(CONNECT_TYPE)
        pairingNotification()
        openWirelessDebugging(activity)
      }
      "start" -> { ControlService.start(app); set("connecting"); work.execute { start(null) } }
      "stop" -> work.execute { stop() }
      "settings" -> openWirelessDebugging(activity)
      else -> return false
    }
    done()
    return true
  }

  /** The code the person typed into the notification (and, if mDNS shows no pairing port, the port from the same dialog). */
  fun pairWith(reply: String) {
    val code = Regex("\\b(\\d{6})\\b").find(reply)?.groupValues?.get(1)
    val port = Regex("(?:[:\\s])(\\d{4,5})\\b").findAll(reply).map { it.groupValues[1] }.firstOrNull { it != code }?.toIntOrNull()
    if (code == null) { fail("code"); pairingNotification(); return }
    // Now, while Android still counts the notification's action as the person's: pairing and starting the helper
    // can take longer than that allowance lasts.
    ControlService.start(app)
    set("connecting")
    work.execute { start(code to port) }
  }

  fun forget() {
    work.execute {
      // Wireless debugging off first, while the app may still change that setting.
      wirelessDebugging(false)
      // The permission goes back through the shell user (the app cannot give it back itself), a moment after
      // everything here is done: Android may end the app when it loses a permission.
      val granted = app.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED
      if (granted) {
        val revoke = "(sleep 3; pm revoke ${app.packageName} ${Manifest.permission.WRITE_SECURE_SETTINGS}) </dev/null >/dev/null 2>&1 &"
        try { helper?.exec(listOf("sh", "-c", revoke)) ?: trace("no helper to give the permission back") } catch (e: Exception) { trace("revoke failed: $e") }
      }
      stop()
      try { KadbCert.clear() } catch (_: Exception) { keyFile.delete() }
      keyFile.delete()
      Store.clear()
      shellUid = null
      error = null
      set("off")
    }
  }

  // The work (one at a time, off the main thread)

  /** Pairs if given a code, then connects to this phone's adb, checks it is the shell user and starts the helper. */
  private fun start(pairing: Pair<String, Int?>?) {
    error = null
    if (helper != null && alive()) return set("running")
    var adb: Kadb? = null
    try {
      if (pairing != null) {
        val port = pairing.second ?: Discovery.port(PAIRING_TYPE, 10_000) ?: return fail("pairing_port")
        try { runBlocking { Kadb.pair("127.0.0.1", port, pairing.first) } } catch (e: Exception) { trace("pairing failed: $e"); return fail("pairing") }
        Store.paired = true
        notifications().cancel(PAIRING_NOTIFICATION)
        trace("paired")
      }
      if (!Store.paired) return fail("not_paired")
      if (Settings.Global.getInt(app.contentResolver, "adb_wifi_enabled", 0) != 1 && !wirelessDebugging(true)) return fail("wireless_debugging")
      adb = connectAdb() ?: return fail("no_adb")
      val uid = adb.shell("id -u").output.trim().toIntOrNull()
      shellUid = uid
      trace("adb shell uid=$uid")
      if (uid != SHELL_UID) return fail("not_shell")
      if (app.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) != PackageManager.PERMISSION_GRANTED) {
        adb.shell("pm grant ${app.packageName} ${Manifest.permission.WRITE_SECURE_SETTINGS}")
      }
      Store.serial = adb.shell("getprop ro.serialno").output.trim().ifEmpty { null }
      launchHelper(adb)
    } catch (e: Exception) {
      trace("start failed: $e")
      fail("adb")
    } finally {
      try { adb?.close() } catch (_: Exception) { }
      Discovery.stop()
    }
  }

  /**
   * This phone's adbd, as this app's adb client. Its port changes each time wireless debugging is turned on, and mDNS
   * may still answer with the last one for a moment: a port that refuses is dropped and the next announcement awaited;
   * without any, the loopback ports are tried.
   */
  private fun connectAdb(): Kadb? {
    Discovery.watch(CONNECT_TYPE)
    var end = System.currentTimeMillis() + 8_000
    while (System.currentTimeMillis() < end) {
      val port = Discovery.port(CONNECT_TYPE, end - System.currentTimeMillis()) ?: break
      val adb = Kadb.create("127.0.0.1", port, 5000, 30_000)
      try { adb.shell("true"); return adb } catch (e: Exception) {
        trace("adb not on $port: ${e.javaClass.simpleName}")
        try { adb.close() } catch (_: Exception) { }
        Discovery.drop(CONNECT_TYPE, port)
        // A fresh announcement comes at once or not soon: then the scan is quicker.
        end = minOf(end, System.currentTimeMillis() + 2_000)
      }
    }
    return scanForAdb()?.let { Kadb.create("127.0.0.1", it, 5000, 30_000) }
  }

  /** Starts the helper from this APK as the shell user, detached from the adb connection, and connects to it. */
  private fun launchHelper(adb: Kadb) {
    val port = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
    val token = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val apk = app.applicationInfo.sourceDir
    require(Regex("^[A-Za-z0-9/._=+~-]+$").matches(apk)) { "unexpected APK path" }
    adb.shell("AIO_HELPER_TOKEN=$token CLASSPATH=$apk setsid app_process /system/bin ${ShellHelper::class.java.name} $port ${app.applicationInfo.uid} </dev/null >/dev/null 2>&1 &")
    Store.setHelper(port, token)
    for (attempt in 0 until 40) {
      if (attach()) return
      Thread.sleep(250)
    }
    fail("helper")
  }

  /** Connects to the helper the store names; true when it answers as the shell user. */
  private fun attach(): Boolean {
    val (port, token) = Store.helper() ?: return false
    val client = try { HelperClient(port, token.toByteArray()) } catch (_: Exception) { return false }
    if (client.exec(listOf("id", "-u")).text.trim() != SHELL_UID.toString()) { client.close(); return false }
    helper = client
    tools = PhoneTools(app) { argv -> client.exec(argv) }
    shellUid = SHELL_UID
    trace("helper running on $port")
    ControlService.start(app)
    set("running")
    return true
  }

  private fun alive(): Boolean = try { helper?.exec(listOf("true"))?.exit == 0 } catch (_: Exception) { false }

  private fun detach(next: String) {
    try { helper?.close() } catch (_: Exception) { }
    helper = null
    tools = null
    Store.setHelper(0, null)
    ControlService.stop(app)
    set(next)
  }

  /** Stop: the helper ends and wireless debugging goes off (this app can turn it on again when it starts). */
  fun stop() {
    try { helper?.exit() } catch (_: Exception) { }
    wirelessDebugging(false)
    notifications().cancel(PAIRING_NOTIFICATION)
    Discovery.stop()
    detach(if (Store.paired) "stopped" else "off")
    trace("stopped")
  }

  /** Turns this phone's wireless debugging on or off (WRITE_SECURE_SETTINGS, which the app granted itself); false if it may not. */
  private fun wirelessDebugging(on: Boolean): Boolean = try {
    Settings.Global.putInt(app.contentResolver, "adb_wifi_enabled", if (on) 1 else 0)
  } catch (e: SecurityException) {
    trace("wireless debugging not changed: ${e.javaClass.simpleName}")
    false
  }

  private fun fail(code: String) {
    error = code
    if (helper == null) ControlService.stop(app)
    trace("failed: $code")
    set(if (Store.paired) "stopped" else "off")
  }

  private fun set(next: String) {
    state = next
    changed()
  }

  /** Every port on 127.0.0.1 that answers as adbd (when mDNS shows none): adbd picks a free port at random. */
  private fun scanForAdb(): Int? {
    val open = ConcurrentHashMap.newKeySet<Int>()
    val next = AtomicInteger(32768)
    val threads = (0 until 16).map {
      Thread {
        while (true) {
          val port = next.getAndIncrement()
          if (port > 60999) break
          try { Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 100); open.add(port) } } catch (_: Exception) { }
        }
      }.also { it.start() }
    }
    threads.forEach { it.join() }
    trace("scan: ${open.size} open")
    return open.sorted().firstOrNull { port ->
      try { Kadb.create("127.0.0.1", port, 2000, 3000).use { it.shell("true"); true } } catch (_: Exception) { false }
    }
  }

  // Notifications

  private fun notifications(): NotificationManager {
    val manager = app.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, app.getString(R.string.control_channel), NotificationManager.IMPORTANCE_HIGH))
    }
    return manager
  }

  fun controlNotification() = NotificationCompat.Builder(app, CHANNEL)
    .setSmallIcon(R.mipmap.ic_launcher)
    .setContentTitle(app.getString(R.string.control_running_title))
    .setContentText(app.getString(R.string.control_running_text))
    .setOngoing(true)
    .setSilent(true)
    .setContentIntent(PendingIntent.getActivity(app, 0, app.packageManager.getLaunchIntentForPackage(app.packageName), PendingIntent.FLAG_IMMUTABLE))
    .addAction(0, app.getString(R.string.control_stop), PendingIntent.getBroadcast(app, 1, Intent(app, ControlReceiver::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE))
    .build()
    .also { notifications() }

  /** The notification the pairing code goes into, while the person has the pairing dialog open in Settings. */
  private fun pairingNotification() {
    val reply = PendingIntent.getBroadcast(app, 2, Intent(app, ControlReceiver::class.java).setAction(ACTION_PAIR), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val input = RemoteInput.Builder(PAIR_CODE).setLabel(app.getString(R.string.control_pair_label)).build()
    val notification = NotificationCompat.Builder(app, CHANNEL)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(app.getString(R.string.control_pair_title))
      .setContentText(app.getString(if (error == "code" || error == "pairing") R.string.control_pair_again else R.string.control_pair_text))
      .setStyle(NotificationCompat.BigTextStyle().bigText(app.getString(if (error == "code" || error == "pairing") R.string.control_pair_again else R.string.control_pair_text)))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .addAction(NotificationCompat.Action.Builder(0, app.getString(R.string.control_pair_action), reply).addRemoteInput(input).build())
      .build()
    try { notifications().notify(PAIRING_NOTIFICATION, notification) } catch (_: SecurityException) { trace("no notification permission") }
  }

  /** Developer options, at Wireless debugging (Settings highlights the entry named by the fragment argument). */
  private fun openWirelessDebugging(activity: Activity?) {
    val intent = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
      .putExtra(":settings:fragment_args_key", "toggle_adb_wireless")
      // From the top of Developer options, not wherever Settings was left.
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    try { (activity ?: app).startActivity(intent) } catch (_: Exception) {
      (activity ?: app).startActivity(Intent(Settings.ACTION_DEVICE_INFO_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  /**
   * Debug builds only (BuildConfig.DEBUG is a constant, so R8 removes this from a release build): the emulator test
   * hands in the pairing code with `adb shell am broadcast -a ai.clawpage.agent.DEBUG_PAIR -p <package> --es code 123456`
   * while the pairing dialog stays open, as typing it into the notification would.
   */
  private fun debugPairing() {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) { intent.getStringExtra("code")?.let { pairWith(it) } }
    }
    val filter = IntentFilter("ai.clawpage.agent.DEBUG_PAIR")
    if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED) else app.registerReceiver(receiver, filter)
  }

  // mDNS: the ports this phone's adbd announces (pairing while the dialog is open, connect while wireless debugging is on)

  private object Discovery {
    private val ports = ConcurrentHashMap<String, Int>()
    private val listeners = ConcurrentHashMap<String, NsdManager.DiscoveryListener>()
    private val resolving = Semaphore(1)
    private val nsd get() = app.getSystemService(NsdManager::class.java)

    fun watch(type: String) {
      if (listeners.containsKey(type)) return
      val listener = object : NsdManager.DiscoveryListener {
        override fun onServiceFound(info: NsdServiceInfo) { resolve(type, info) }
        override fun onServiceLost(info: NsdServiceInfo) { }
        override fun onDiscoveryStarted(serviceType: String) { }
        override fun onDiscoveryStopped(serviceType: String) { }
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { listeners.remove(type); trace("mdns $type failed $errorCode") }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { }
      }
      listeners[type] = listener
      nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    @Suppress("DEPRECATION")
    private fun resolve(type: String, info: NsdServiceInfo) {
      Thread {
        if (!resolving.tryAcquire(10, TimeUnit.SECONDS)) return@Thread
        nsd.resolveService(info, object : NsdManager.ResolveListener {
          override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { resolving.release() }
          override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
            resolving.release()
            // Only this phone's own adbd: other phones on the network announce theirs too.
            val own = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }
            if (own.any { it == serviceInfo.host }) { ports[type] = serviceInfo.port; trace("mdns $type port ${serviceInfo.port}") }
          }
        })
      }.start()
    }

    /** The port last announced for `type`, waiting up to `ms` for one. */
    fun port(type: String, ms: Long): Int? {
      val end = System.currentTimeMillis() + ms
      while (System.currentTimeMillis() < end) { ports[type]?.let { return it }; Thread.sleep(100) }
      return ports[type]
    }

    /** Forgets a port that did not answer. */
    fun drop(type: String, port: Int) { ports.remove(type, port) }

    fun stop() {
      for ((_, listener) in listeners) try { nsd.stopServiceDiscovery(listener) } catch (_: Exception) { }
      listeners.clear()
      ports.clear()
    }
  }
}
