package ai.clawpage.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/** This app's own notifications (not exported): the pairing code typed into one, and Stop on the other. */
class ControlReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    // The app may have been closed since the notification went up.
    PhoneControl.ensure(context)
    when (intent.action) {
      ACTION_PAIR -> RemoteInput.getResultsFromIntent(intent)?.getCharSequence(PAIR_CODE)?.let { PhoneControl.pairWith(it.toString()) }
      ACTION_STOP -> PhoneControl.stopSoon()
    }
  }
}
