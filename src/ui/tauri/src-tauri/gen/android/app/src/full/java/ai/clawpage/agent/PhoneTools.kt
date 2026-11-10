package ai.clawpage.agent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Xml
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/** A tool that could not do what it was asked; the message is what the agent reads. */
class PhoneToolError(message: String) : Exception(message)

/**
 * aio_env's `apps` and `screen` tools on this phone, run through the shell helper (ShellHelper.kt) with the shell
 * commands mobile-mcp runs over USB. Every answer is worded as the Mac's adapter (bin/mac-env.mjs) passes on
 * mobile-mcp 1.0.9's (with mobilecli) for the same phone, so the agent reads the same thing either way;
 * tests/devices/android-full.e2e.test.ts asks both on the emulator and compares.
 */
class PhoneTools(private val app: Context, private val shell: (List<String>) -> HelperClient.Out) {
  private val main = Handler(Looper.getMainLooper())

  fun call(tool: String, args: JSONObject): JSONObject = when (tool) {
    "apps_list" -> text("Found these apps on device: ${apps().joinToString(", ") { "${it.second} (${it.first})" }}")
    "app_open" -> {
      val app = packageName(args)
      if (run("monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1").exit != 0) {
        throw PhoneToolError("Failed launching app with package name \"$app\", please make sure it exists")
      }
      text("Launched app $app")
    }
    "app_close" -> {
      val app = packageName(args)
      ok(run("am", "force-stop", app))
      text("Terminated app $app")
    }
    "screen_read" -> text(formatElements(dump().filter { it.listed }))
    "screen_tap" -> {
      val x = number(args, "x")
      val y = number(args, "y")
      val (px, py) = Pair(x.roundToInt().toString(), y.roundToInt().toString())
      when (args.optString("mode", "tap")) {
        "double" -> {
          ok(run("input", "tap", px, py))
          ok(run("input", "tap", px, py))
          text("Double-tapped on screen at coordinates: ${js(x)}, ${js(y)}")
        }
        "long" -> {
          ok(run("input", "swipe", px, py, px, py, "500"))
          text("Long pressed on screen at coordinates: ${js(x)}, ${js(y)} for 500ms")
        }
        else -> {
          ok(run("input", "tap", px, py))
          text("Clicked on screen at coordinates: ${js(x)}, ${js(y)}")
        }
      }
    }
    "screen_type" -> {
      val value = args.optString("text")
      refusal("screen_type", args)?.let { throw PhoneToolError(it) }
      type(value)
      if (args.optBoolean("submit", false)) ok(run("input", "keyevent", "KEYCODE_ENTER"))
      text("Typed text: $value")
    }
    "screen_swipe" -> swipe(args)
    "screen_key" -> {
      val key = args.optString("key")
      val code = KEYS[key] ?: throw PhoneToolError("Button \"$key\" is not supported")
      ok(run("input", "keyevent", code))
      text("Pressed the button: $key")
    }
    "screen_shot" -> screenshot()
    else -> throw PhoneToolError("unknown tool $tool")
  }

  /**
   * The one place a step is held back before it runs. Today: no typing into a password field (the person types
   * passwords; PHONE_POLICY tells the agent so). A confirmation on the phone for steps such as paying or sending
   * would go here.
   */
  private fun refusal(tool: String, args: JSONObject): String? {
    // Any focused password field, also an empty one (which screen_read does not list).
    if (tool == "screen_type" && dump().any { it.focused && it.password }) {
      return "This is a password field: the user types passwords themselves. Ask them to type it on the phone."
    }
    return null
  }

  // Apps

  /** (package, name) of each app with a launcher entry, in the order Android resolves them (mobilecli's order too). */
  private fun apps(): List<Pair<String, String>> {
    val pm = app.packageManager
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(launcher, 0).map { it.activityInfo.applicationInfo }.distinctBy { it.packageName }
      .map { it.packageName to pm.getApplicationLabel(it).toString().ifEmpty { it.packageName } }
  }

  private fun packageName(args: JSONObject): String {
    val app = args.optString("app")
    if (!Regex("^[a-zA-Z0-9._]+$").matches(app)) throw PhoneToolError("Invalid package name: \"$app\"")
    return app
  }

  // The screen

  private class Element(
    val type: String, val text: String, val label: String, val id: String,
    val x: Int, val y: Int, val width: Int, val height: Int,
    val focused: Boolean, val selected: Boolean, val checked: Boolean, val enabled: Boolean, val password: Boolean,
    /** What mobile-mcp lists: something to read or to name it by, and a size. */
    val listed: Boolean,
  )

  /**
   * Every node in every window of the main display, as mobilecli reads the screen: the other windows (status bar,
   * keyboard) as `uiautomator dump --windows` has them, and the window in use as a plain `uiautomator dump` has it,
   * which also keeps the views not marked important for accessibility.
   */
  private fun dump(): List<Element> {
    val all = "/data/local/tmp/aio-ui-windows.xml"
    val active = "/data/local/tmp/aio-ui.xml"
    var windows = ""
    var main = ""
    // uiautomator answers "null root node" while the screen changes; mobile-mcp tries ten times too.
    for (attempt in 0 until 10) {
      val out = run("sh", "-c", "uiautomator dump --windows $all >/dev/null 2>&1; uiautomator dump $active >/dev/null 2>&1; cat $all; echo '$SPLIT'; cat $active; rm -f $all $active").text
      windows = xmlIn(out.substringBefore(SPLIT))
      main = xmlIn(out.substringAfter(SPLIT, ""))
      if (windows.isNotEmpty() && main.isNotEmpty()) break
    }
    if (windows.isEmpty() || main.isEmpty()) throw PhoneToolError("No UI hierarchy was returned for this device - its screen is most likely off or locked. Wake it up (for example with mobile_press_button using HOME, or POWER when that is supported) and try again")
    val elements = mutableListOf<Element>()
    var display = "0"
    var skipping = false
    val parser = Xml.newPullParser()
    parser.setInput(StringReader(windows))
    while (parser.next() != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.END_TAG && parser.name == "window") skipping = false
      if (parser.eventType != XmlPullParser.START_TAG) continue
      when (parser.name) {
        "display" -> display = parser.getAttributeValue(null, "id") ?: "0"
        "window" -> if (display == "0" && parser.getAttributeValue(null, "active") == "true") { skipping = true; elements += nodes(main) }
        "node" -> if (display == "0" && !skipping) element(parser)?.let { elements += it }
      }
    }
    return elements
  }

  private fun xmlIn(text: String) = text.substringAfter("<?xml", "").let { if (it.isEmpty()) "" else "<?xml$it" }

  private fun nodes(xml: String): List<Element> {
    val parser = Xml.newPullParser()
    parser.setInput(StringReader(xml))
    val elements = mutableListOf<Element>()
    while (parser.next() != XmlPullParser.END_DOCUMENT) {
      if (parser.eventType == XmlPullParser.START_TAG && parser.name == "node") element(parser)?.let { elements += it }
    }
    return elements
  }

  private fun element(parser: XmlPullParser): Element? {
    val a = { name: String -> parser.getAttributeValue(null, name) ?: "" }
    val bounds = Regex("^\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]$").find(a("bounds"))?.groupValues?.drop(1)?.map { it.toInt() } ?: return null
    val text = a("text")
    val label = a("content-desc").ifEmpty { a("hint") }
    val id = a("resource-id")
    val width = bounds[2] - bounds[0]
    val height = bounds[3] - bounds[1]
    return Element(
      type = a("class").ifEmpty { "text" }, text = text, label = label, id = id,
      x = bounds[0], y = bounds[1], width = width, height = height,
      focused = a("focused") == "true", selected = a("selected") == "true", checked = a("checked") == "true",
      enabled = a("enabled") != "false", password = a("password") == "true",
      listed = (text.isNotEmpty() || label.isNotEmpty() || id.isNotEmpty() || a("checkable") == "true" || a("clickable") == "true") && width > 0 && height > 0,
    )
  }

  private fun formatElements(elements: List<Element>): String {
    val lines = elements.mapIndexed { i, e ->
      buildList {
        add("@e${i + 1}")
        add(e.type.substringAfterLast('.'))
        if (e.text.isNotEmpty()) add("text=${quote(e.text)}")
        if (e.label.isNotEmpty()) add("label=${quote(e.label)}")
        if (e.id.isNotEmpty()) add("id=${quote(e.id)}")
        add("at=${e.x},${e.y}")
        add("size=${e.width}x${e.height}")
        if (e.focused) add("focused")
        if (e.selected) add("selected")
        if (e.checked) add("checked")
        if (!e.enabled) add("disabled")
      }.joinToString(" ")
    }
    return (listOf(ELEMENTS_HEADER) + lines).joinToString("\n")
  }

  /** mobilecli's swipes: 400 pixels through the middle of the screen, or from a point (distance 400 unless given). */
  private fun swipe(args: JSONObject): JSONObject {
    val direction = args.optString("direction")
    if (direction !in listOf("up", "down", "left", "right")) throw PhoneToolError("Swipe direction \"$direction\" is not supported")
    val hasPoint = args.has("x") && args.has("y")
    val distance = if (args.has("distance")) number(args, "distance") else 0.0
    val (sx, sy) = if (hasPoint) number(args, "x") to number(args, "y") else screenSize().let { (w, h) -> (w / 2).toDouble() to (h / 2).toDouble() }
    val reach = if (hasPoint) (if (distance != 0.0) distance else 400.0) else 200.0
    val (fromX, fromY) = if (hasPoint) sx to sy else when (direction) {
      "up" -> sx to sy + reach; "down" -> sx to sy - reach; "left" -> sx + reach to sy; else -> sx - reach to sy
    }
    val span = if (hasPoint) reach else reach * 2
    val (toX, toY) = when (direction) {
      "up" -> fromX to fromY - span; "down" -> fromX to fromY + span; "left" -> fromX - span to fromY; else -> fromX + span to fromY
    }
    ok(run("input", "swipe", fromX.roundToInt().toString(), fromY.roundToInt().toString(), toX.roundToInt().toString(), toY.roundToInt().toString(), "300"))
    return if (hasPoint) text("Swiped $direction${if (distance != 0.0) " ${js(distance)} pixels" else ""} from coordinates: ${js(sx)}, ${js(sy)}")
    else text("Swiped $direction on screen")
  }

  /** ASCII goes in as key presses; anything else through the clipboard and a paste, as mobile-mcp's device kit does. */
  private fun type(value: String) {
    if (value.isEmpty()) return
    if (value.all { it.code < 128 }) { ok(run("input", "text", value)); return }
    val set = CountDownLatch(1)
    main.post {
      (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("", value))
      set.countDown()
    }
    set.await(5, TimeUnit.SECONDS)
    ok(run("input", "keyevent", "KEYCODE_PASTE"))
  }

  /** The screen's size in pixels (an override, as from `wm size`, wins). */
  private fun screenSize(): Pair<Int, Int> {
    val size = ok(run("wm", "size")).trim().lines().last().substringAfterLast(' ')
    val (w, h) = size.split('x').map { it.trim().toIntOrNull() ?: 0 }.let { (it.getOrElse(0) { 0 }) to (it.getOrElse(1) { 0 }) }
    return w to h
  }

  /** A JPEG at most 1024 pixels on its long side (quality 75), and how its positions map to the screen's. */
  private fun screenshot(): JSONObject {
    val png = run("screencap", "-p")
    val bitmap = BitmapFactory.decodeByteArray(png.out, 0, png.out.size) ?: throw PhoneToolError("Screenshot is invalid. Please try again.")
    val scale = minOf(1.0, SHOT_MAX / maxOf(bitmap.width, bitmap.height).toDouble())
    val width = (bitmap.width * scale).roundToInt()
    val height = (bitmap.height * scale).roundToInt()
    val small = if (scale < 1.0) Bitmap.createScaledBitmap(bitmap, width, height, true) else bitmap
    val jpeg = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 75, it) }.toByteArray()
    val (sw, sh) = screenSize()
    val mapping = when {
      width <= 0 || height <= 0 || sw <= 0 || sh <= 0 -> null
      width == sw && height == sh -> "Screenshot is ${width}x$height and its coordinates match the screen."
      else -> "Screenshot is ${width}x$height. Screen coordinates are ${sw}x$sh. To tap something you see in this screenshot, multiply its x by ${ratio(sw.toDouble() / width)} and y by ${ratio(sh.toDouble() / height)}."
    }
    val result = JSONObject().put("image", Base64.encodeToString(jpeg, Base64.NO_WRAP)).put("mimeType", "image/jpeg")
    if (mapping != null) result.put("text", mapping)
    return result
  }

  // Plumbing

  private fun run(vararg argv: String) = shell(argv.toList())

  private fun ok(out: HelperClient.Out): String {
    if (out.exit != 0) throw PhoneToolError(out.err.trim().ifEmpty { out.text.trim() }.ifEmpty { "the command failed (${out.exit})" })
    return out.text
  }

  private fun text(value: String) = JSONObject().put("text", value)

  private fun number(args: JSONObject, key: String): Double {
    val v = args.opt(key)
    return (v as? Number)?.toDouble() ?: v?.toString()?.toDoubleOrNull() ?: throw PhoneToolError("$key must be a number")
  }

  companion object {
    private const val SHOT_MAX = 1024.0
    private const val SPLIT = "<!-- aio: active window -->"
    const val ELEMENTS_HEADER = "One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]"
    private val KEYS = mapOf(
      "BACK" to "KEYCODE_BACK", "HOME" to "KEYCODE_HOME", "VOLUME_UP" to "KEYCODE_VOLUME_UP",
      "VOLUME_DOWN" to "KEYCODE_VOLUME_DOWN", "ENTER" to "KEYCODE_ENTER",
    )

    /** A number as JavaScript prints it (120, 120.5): mobile-mcp's texts are template strings. */
    fun js(value: Double): String = if (value == Math.floor(value) && !value.isInfinite() && Math.abs(value) < 1e15) value.toLong().toString() else value.toString()

    /** `Number(r.toFixed(3)).toString()`. */
    fun ratio(value: Double): String = java.math.BigDecimal(value).setScale(3, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    /** JSON.stringify of a string (org.json's quote escapes more, such as the hyphen in "Wi‑Fi"). */
    fun quote(value: String): String = buildString {
      append('"')
      for ((i, c) in value.withIndex()) {
        when {
          c == '"' -> append("\\\"")
          c == '\\' -> append("\\\\")
          c == '\b' -> append("\\b")
          c == '\u000C' -> append("\\f")
          c == '\n' -> append("\\n")
          c == '\r' -> append("\\r")
          c == '\t' -> append("\\t")
          c.code < 0x20 -> append("\\u%04x".format(c.code))
          c.isHighSurrogate() && !(value.getOrNull(i + 1)?.isLowSurrogate() ?: false) -> append("\\u%04x".format(c.code))
          c.isLowSurrogate() && !(value.getOrNull(i - 1)?.isHighSurrogate() ?: false) -> append("\\u%04x".format(c.code))
          else -> append(c)
        }
      }
      append('"')
    }
  }
}
