package io.github.saifutdinov.thread

import android.Manifest
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// While a call is on, the app is a foreground service holding the
// microphone (and the camera in a video call), so Android neither freezes
// the page nor cuts the microphone when the screen goes off or another app
// comes to the front. The page says when (android.ts, bridge "call").
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val video = intent?.getBooleanExtra("video", false) == true
        val n = NotificationCompat.Builder(this, Notes.ONGOING)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(getColor(R.color.brand))
            .setContentTitle(getString(R.string.ongoing))
            .setContentText(getString(R.string.ongoing_hint))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(Notes.open(this, "", 8))
            // Hang up from the notification shade, without opening the app.
            .addAction(
                0, getString(R.string.hangup),
                PendingIntent.getBroadcast(
                    this, 9, Intent(this, Actions::class.java).setAction(Actions.HANGUP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .build()
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (video && granted(this, Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        try {
            ServiceCompat.startForeground(this, 2, n, type)
        } catch (e: Exception) {
            // Not allowed now (no microphone permission, or started from the
            // background): the call goes on as long as the app stays open.
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

        fun update(ctx: Context, on: Boolean, video: Boolean) {
            val intent = Intent(ctx, CallService::class.java).putExtra("video", video)
            if (!on) {
                ctx.stopService(intent)
                return
            }
            if (!granted(ctx, Manifest.permission.RECORD_AUDIO)) return
            runCatching { ContextCompat.startForegroundService(ctx, intent) }
        }
    }
}
