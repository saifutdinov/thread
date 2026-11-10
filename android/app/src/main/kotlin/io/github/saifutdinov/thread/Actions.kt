package io.github.saifutdinov.thread

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import kotlin.concurrent.thread

// The buttons that work without opening the app: Decline on a ring and
// "Mark as read" on a message (sw.js notificationclick does the same).
class Actions : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val app = ctx.applicationContext
        val done = goAsync()
        thread {
            try {
                when (intent.action) {
                    DECLINE -> {
                        val c = intent.getLongExtra("c", 0)
                        val id = intent.getStringExtra("id") ?: ""
                        Notes.cancel(app, "call")
                        // A page awake in the background stops ringing at once;
                        // the server tells the caller either way.
                        Bridge.post(JSONObject().put("t", "call").put("k", "decline").put("id", id).put("c", c))
                        Net.send("POST", "/api/calls/decline", JSONObject().put("c", c).put("id", id).toString())
                    }
                    // The page ends the call it has (android.ts), 1:1 or group.
                    HANGUP -> Bridge.post(JSONObject().put("t", "hangup"))
                    READ -> {
                        val c = intent.getLongExtra("c", 0)
                        val m = intent.getLongExtra("m", 0)
                        val res = Net.send("POST", "/api/chats/$c/read", JSONObject().put("id", m).toString())
                        // Not marked (offline, signed out): the notification stays.
                        if (res != null && res.first in 200..299) Notes.cancel(app, "c$c")
                    }
                }
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val DECLINE = "io.github.saifutdinov.thread.DECLINE"
        const val READ = "io.github.saifutdinov.thread.READ"
        const val HANGUP = "io.github.saifutdinov.thread.HANGUP"
    }
}
