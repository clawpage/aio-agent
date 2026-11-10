package ai.clawpage.agent

import android.app.Activity
import android.content.Context
import org.json.JSONObject

// The Play build's stand-in for the side-loaded app's control of this phone (src/full, docs/EXEC-ENVS.md): no adb,
// no shell helper, so no `apps` or `screen`, and the link closes in the background as before. DeviceTools.kt calls
// the same functions in both builds; app/build.gradle.kts picks one of the two files.
object PhoneControl {
  fun init(app: Context, changed: () -> Unit) {}

  /** What it adds to this phone's environment now. */
  fun capabilities(): List<String> = emptyList()

  /** Other names for this phone (its adb serial). */
  fun aliases(): List<String> = emptyList()

  /** Whether the device link stays up while the app is not on screen. */
  val keepsLink: Boolean get() = false

  /** One `apps_*` / `app_*` / `screen_*` call; null: this build has no such tool. */
  fun call(tool: String, args: JSONObject): JSONObject? = null

  /** Its part of the console's state; null: none in this build. */
  fun status(): JSONObject? = null

  /** A `control` message from the console; false: this build has none. */
  fun fromConsole(body: JSONObject, activity: Activity?, done: () -> Unit): Boolean = false

  /** The link to the account is gone: nothing of the control may stay. */
  fun forget() {}
}
