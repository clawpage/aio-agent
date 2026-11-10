package ai.clawpage.agent

import java.io.BufferedInputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Debug builds of the side-loaded app only: knocks on the shell helper as whoever runs it and prints what the helper
 * said (`refused uid`, `refused token` or `ok`). tests/devices/android-full.e2e.test.ts runs it as the shell user and
 * as other apps' users:
 *
 *   CLASSPATH=<the app's base.apk> app_process /system/bin ai.clawpage.agent.HelperProbe <port> <token>
 */
object HelperProbe {
  @JvmStatic
  fun main(args: Array<String>) {
    val token = args[1].toByteArray()
    Socket().use { socket ->
      socket.connect(InetSocketAddress("127.0.0.1", args[0].toInt()), 3000)
      socket.soTimeout = 10_000
      val input = BufferedInputStream(socket.getInputStream())
      val output = socket.getOutputStream()
      val mine = ShellHelper.nonce()
      ShellHelper.line(output, mine)
      val answer = ShellHelper.readLine(input) ?: return println("closed")
      if (answer.startsWith("refused")) return println(answer)
      val (proof, theirs) = answer.split(" ")
      if (!ShellHelper.same(proof, ShellHelper.proof(token, "helper", mine))) return println("not the helper")
      ShellHelper.line(output, ShellHelper.proof(token, "app", theirs))
      println(ShellHelper.readLine(input) ?: "closed")
    }
  }
}
