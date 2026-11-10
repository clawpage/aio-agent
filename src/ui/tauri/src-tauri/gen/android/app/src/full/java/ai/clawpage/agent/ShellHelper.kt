package ai.clawpage.agent

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread
import kotlin.system.exitProcess

// The shell helper (docs/EXEC-ENVS.md, "The side-loaded Android app"): this class runs from the app's own APK as the
// shell user (uid 2000), started by PhoneControl.kt over the app's adb connection to its own phone:
//
//   AIO_HELPER_TOKEN=<hex> CLASSPATH=<base.apk> setsid app_process /system/bin ai.clawpage.agent.ShellHelper <port> <app uid>
//
// It listens on 127.0.0.1:<port> and runs the commands the app sends (each an argv, never a shell line it builds).
// Only the app may use it: a connection from any other uid is closed before a byte is read (the kernel's
// /proc/net/tcp says whose socket it is), and both sides then prove they hold the token from the command line's
// environment without sending it (HMAC over each other's nonce), so a program that took the port first cannot pass
// for the helper either. It ends when the app says so, or after IDLE_MS without the app.

object ShellHelper {
  private const val IDLE_MS = 30 * 60 * 1000L
  private const val COMMAND_MS = 60 * 1000L
  private val sessions = AtomicInteger(0)
  private val lastSeen = AtomicLong(System.currentTimeMillis())

  @JvmStatic
  fun main(args: Array<String>) {
    val port = args.getOrNull(0)?.toIntOrNull() ?: exitProcess(2)
    val appUid = args.getOrNull(1)?.toIntOrNull() ?: exitProcess(2)
    val token = System.getenv("AIO_HELPER_TOKEN")?.takeIf { it.length >= 32 } ?: exitProcess(2)
    val server = try { ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")) } catch (_: Exception) { exitProcess(3) }
    server.soTimeout = 60_000
    while (true) {
      val socket = try { server.accept() } catch (_: SocketTimeoutException) {
        if (sessions.get() == 0 && System.currentTimeMillis() - lastSeen.get() > IDLE_MS) exitProcess(0)
        continue
      }
      // Whatever goes wrong with one connection ends that connection, never the helper.
      thread(isDaemon = true) { try { serve(socket, port, appUid, token.toByteArray()) } catch (_: Exception) { } }
    }
  }

  private fun serve(socket: Socket, port: Int, appUid: Int, token: ByteArray) {
    socket.use {
      val input = BufferedInputStream(socket.getInputStream())
      val output = socket.getOutputStream()
      // Whose socket this is, before anything it sends is read.
      if (uidOf(socket.port, port) != appUid) { line(output, "refused uid"); return }
      val theirNonce = readLine(input) ?: return
      val mine = nonce()
      line(output, "${proof(token, "helper", theirNonce)} $mine")
      if (!same(readLine(input) ?: "", proof(token, "app", mine))) { line(output, "refused token"); return }
      line(output, "ok")
      sessions.incrementAndGet()
      try {
        while (true) {
          val request = JSONObject(readLine(input) ?: return)
          lastSeen.set(System.currentTimeMillis())
          if (request.optBoolean("exit")) { line(output, "{}"); exitProcess(0) }
          val argv = request.optJSONArray("argv") ?: return
          run(argv, output)
        }
      } finally {
        sessions.decrementAndGet()
        lastSeen.set(System.currentTimeMillis())
      }
    }
  }

  /** One command: a header line (exit code, standard error, size) and then its standard output as it is. */
  private fun run(argv: JSONArray, output: OutputStream) {
    val command = (0 until argv.length()).map { argv.getString(it) }
    val (exit, out, err) = try {
      val process = ProcessBuilder(command).start()
      process.outputStream.close()
      // A command that hangs is ended, which closes its output and so the reads below.
      val watchdog = thread(isDaemon = true) {
        try { if (!process.waitFor(COMMAND_MS, TimeUnit.MILLISECONDS)) process.destroyForcibly() } catch (_: InterruptedException) { }
      }
      var errors = ByteArray(0)
      val reader = thread { errors = process.errorStream.readBytes() }
      val bytes = process.inputStream.readBytes()
      reader.join()
      process.waitFor()
      watchdog.interrupt()
      Triple(process.exitValue(), bytes, String(errors))
    } catch (e: Exception) {
      Triple(127, ByteArray(0), e.message ?: e.javaClass.simpleName)
    }
    line(output, JSONObject().put("exit", exit).put("err", err.take(4000)).put("size", out.size).toString())
    output.write(out)
    output.flush()
  }

  /**
   * The uid owning the client end of a loopback connection to this port (its port is `remote`), from the kernel's
   * table: `sl local rem st tx:rx tr:when retrnsmt uid …`, addresses as hex `ADDR:PORT`.
   */
  fun uidOf(remote: Int, port: Int): Int? {
    for (table in listOf("/proc/net/tcp6", "/proc/net/tcp")) {
      val lines = try { File(table).readLines() } catch (_: Exception) { continue }
      for (row in lines.drop(1)) {
        val f = row.trim().split(Regex("\\s+"))
        if (f.size < 8) continue
        if (portOf(f[1]) == remote && portOf(f[2]) == port) return f[7].toIntOrNull()
      }
    }
    return null
  }

  private fun portOf(address: String) = address.substringAfterLast(':').toIntOrNull(16)

  fun proof(token: ByteArray, side: String, nonce: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(token, "HmacSHA256"))
    return mac.doFinal("$side:$nonce".toByteArray()).joinToString("") { "%02x".format(it) }
  }

  fun nonce(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

  /** Constant-time comparison of two proofs. */
  fun same(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

  fun line(output: OutputStream, text: String) {
    output.write("$text\n".toByteArray())
    output.flush()
  }

  /** One line of at most 1 MB, without its newline; null at the end of the stream. */
  fun readLine(input: InputStream): String? {
    val bytes = ByteArrayOutputStream()
    while (true) {
      val b = input.read()
      if (b < 0) return if (bytes.size() == 0) null else bytes.toString("UTF-8")
      if (b == '\n'.code) return bytes.toString("UTF-8")
      if (bytes.size() > 1 shl 20) return null
      bytes.write(b)
    }
  }
}
