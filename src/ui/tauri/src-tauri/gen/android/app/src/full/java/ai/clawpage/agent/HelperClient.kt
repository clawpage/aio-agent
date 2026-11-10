package ai.clawpage.agent

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/** The app's end of the shell helper's connection (ShellHelper.kt): proves the token both ways, then runs commands one at a time. */
class HelperClient(port: Int, private val token: ByteArray) : Closeable {
  class Out(val exit: Int, val out: ByteArray, val err: String) { val text: String get() = String(out) }

  private val socket = Socket()
  private val input: BufferedInputStream
  private val output get() = socket.getOutputStream()

  init {
    try {
      socket.connect(InetSocketAddress("127.0.0.1", port), 3000)
      socket.soTimeout = 90_000
      input = BufferedInputStream(socket.getInputStream())
      val mine = ShellHelper.nonce()
      ShellHelper.line(output, mine)
      val answer = ShellHelper.readLine(input)?.split(" ") ?: throw IOException("the helper closed the connection")
      // Something else on that port, or a helper that does not know the token.
      if (answer.size != 2 || !ShellHelper.same(answer[0], ShellHelper.proof(token, "helper", mine))) throw IOException("not our helper: ${answer.firstOrNull()}")
      ShellHelper.line(output, ShellHelper.proof(token, "app", answer[1]))
      if (ShellHelper.readLine(input) != "ok") throw IOException("the helper refused this app")
    } catch (e: Exception) {
      socket.close()
      throw e
    }
  }

  @Synchronized
  fun exec(argv: List<String>): Out {
    ShellHelper.line(output, JSONObject().put("argv", JSONArray(argv)).toString())
    val head = JSONObject(ShellHelper.readLine(input) ?: throw IOException("the helper is gone"))
    val size = head.getInt("size")
    val bytes = ByteArray(size)
    var read = 0
    while (read < size) {
      val n = input.read(bytes, read, size - read)
      if (n < 0) throw IOException("the helper is gone")
      read += n
    }
    return Out(head.getInt("exit"), bytes, head.optString("err"))
  }

  /** The helper ends. */
  @Synchronized
  fun exit() {
    try { ShellHelper.line(output, JSONObject().put("exit", true).toString()); ShellHelper.readLine(input) } catch (_: IOException) { }
    close()
  }

  override fun close() = socket.close()
}
