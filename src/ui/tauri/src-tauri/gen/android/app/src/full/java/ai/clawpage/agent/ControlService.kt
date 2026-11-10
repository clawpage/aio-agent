package ai.clawpage.agent

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * While the shell helper runs (PhoneControl.kt): keeps this app running in the background, so the agent can use the
 * phone's other apps, and shows that it does, with Stop. Started only while the person is using the app or its
 * notification (the moments Android lets an app start one).
 */
class ControlService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = PhoneControl.controlNotification()
    if (Build.VERSION.SDK_INT >= 34) startForeground(CONTROL_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(CONTROL_NOTIFICATION, notification)
    return START_NOT_STICKY
  }

  companion object {
    fun start(context: Context) {
      try { context.startForegroundService(Intent(context, ControlService::class.java)) } catch (e: Exception) {
        // Not allowed from the background now: the helper still runs, and the link stays while the app is on screen.
        Log.i("aio-control", "no foreground service: ${e.javaClass.simpleName}")
      }
    }

    fun stop(context: Context) { context.stopService(Intent(context, ControlService::class.java)) }
  }
}
