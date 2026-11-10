package io.github.saifutdinov.thread

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat

// The app's notifications: the ones sw.js shows in a browser, by the same
// tags ("c<chat>", "call", "gcall", "test", "device"), so the page's own
// notes (bridge "notify") and pushes replace each other as they do there.
object Notes {
    const val MESSAGES = "messages"
    const val CALLS = "calls"
    const val ONGOING = "ongoing"
    const val OTHER = "other"
    private const val ID = 1
    private const val RING_MS = 45_000L // internal/server/calls.go ringFor

    fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ring = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(MESSAGES, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 120, 60, 120)
                },
                NotificationChannel(CALLS, ctx.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ring)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
                NotificationChannel(ONGOING, ctx.getString(R.string.channel_ongoing), NotificationManager.IMPORTANCE_LOW),
                NotificationChannel(OTHER, ctx.getString(R.string.channel_other), NotificationManager.IMPORTANCE_DEFAULT),
            ),
        )
    }

    // What is on screen per tag: the newest message and how many came since
    // the chat was last open (sw.js keeps this in the notification's data),
    // and which call rings.
    private fun shown(ctx: Context) = ctx.getSharedPreferences("shown", Context.MODE_PRIVATE)

    fun open(ctx: Context, url: String, code: Int): PendingIntent =
        PendingIntent.getActivity(
            ctx, code,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.OPEN).putExtra("url", url)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    fun icon(dataUrl: String?): Bitmap? = dataUrl?.substringAfter("base64,", "")?.takeIf { it.isNotEmpty() }?.let {
        runCatching { Base64.decode(it, Base64.DEFAULT).let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) } }.getOrNull()
    }

    @SuppressLint("MissingPermission") // without the permission, notify() shows nothing: nothing to do
    fun post(ctx: Context, tag: String, n: Notification) {
        if (NotificationManagerCompat.from(ctx).areNotificationsEnabled()) NotificationManagerCompat.from(ctx).notify(tag, ID, n)
    }

    fun cancel(ctx: Context, tag: String) {
        NotificationManagerCompat.from(ctx).cancel(tag, ID)
        shown(ctx).edit().remove(tag).apply()
        if (tag == "call" || tag == "gcall") shown(ctx).edit().remove("ring:$tag").apply()
    }

    fun active(ctx: Context, tag: String): Boolean =
        ctx.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == tag && it.id == ID }

    // A message: one notification per chat, "Name: text" under a group's title.
    fun message(ctx: Context, chat: Long, msg: Long, title: String, body: String, picture: String?, at: Long, quiet: Boolean) {
        val tag = "c$chat"
        val prev = shown(ctx).getString(tag, null)?.split(':')
        val n = (if (prev != null && active(ctx, tag)) prev[1].toIntOrNull() ?: 0 else 0) + 1
        shown(ctx).edit().putString(tag, "$msg:$n").apply()
        val w = Words(Kept.en())
        val read = PendingIntent.getBroadcast(
            ctx, tag.hashCode(),
            Intent(ctx, Actions::class.java).setAction(Actions.READ).putExtra("c", chat).putExtra("m", msg),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = NotificationCompat.Builder(ctx, if (quiet) OTHER else MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ctx.getColor(R.color.brand))
            .setContentTitle(if (n > 1) "$title · " + w["more"].replace("{n}", "$n") else title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setWhen(if (at > 0) at else System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(open(ctx, "/#/c/$chat", tag.hashCode()))
            .addAction(0, w["read"], read)
        icon(picture)?.let { b.setLargeIcon(it) }
        post(ctx, tag, b.build())
    }

    // The newest message a chat's notification shows, or null.
    fun newest(ctx: Context, chat: Long): Long? = shown(ctx).getString("c$chat", null)?.substringBefore(':')?.toLongOrNull()

    // A 1:1 ring: a phone call's notification, over the lock screen, with
    // the ringtone looping until it is answered, declined or over.
    fun ring(ctx: Context, chat: Long, id: String, name: String, picture: String?, video: Boolean) {
        val w = Words(Kept.en())
        shown(ctx).edit().putString("ring:call", "$chat:$id").apply()
        val answer = PendingIntent.getActivity(
            ctx, 2,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.ANSWER).putExtra("c", chat).putExtra("id", id)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val decline = PendingIntent.getBroadcast(
            ctx, 3,
            Intent(ctx, Actions::class.java).setAction(Actions.DECLINE).putExtra("c", chat).putExtra("id", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val who = Person.Builder().setName(name.ifEmpty { "Thread" }).setImportant(true)
        icon(picture)?.let { who.setIcon(IconCompat.createWithBitmap(it)) }
        val n = NotificationCompat.Builder(ctx, CALLS)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ctx.getColor(R.color.brand))
            .setContentText(if (video) w["callVideo"] else w["call"])
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(who.build(), decline, answer).setIsVideo(video))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(over(ctx, chat, 4))
            .setFullScreenIntent(over(ctx, chat, 5), true)
            .build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        post(ctx, "call", n)
    }

    // The ringing chat, shown over the lock screen with the screen turned on.
    private fun over(ctx: Context, chat: Long, code: Int): PendingIntent =
        PendingIntent.getActivity(
            ctx, code,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.RING).putExtra("url", "/#/c/$chat")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    // A group call: its chat opens on a tap, "Join" joins at once.
    fun groupRing(ctx: Context, chat: Long, id: String, title: String, body: String, picture: String?) {
        val w = Words(Kept.en())
        shown(ctx).edit().putString("ring:gcall", "$chat:$id").apply()
        val join = PendingIntent.getActivity(
            ctx, 6,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.JOIN).putExtra("c", chat).putExtra("id", id)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = NotificationCompat.Builder(ctx, MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ctx.getColor(R.color.brand))
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(open(ctx, "/#/c/$chat", 7))
            .addAction(0, w["join"], join)
        icon(picture)?.let { b.setLargeIcon(it) }
        post(ctx, "gcall", b.build())
    }

    // Which call rings under this tag: (chat, id), or null.
    fun ringing(ctx: Context, tag: String): Pair<Long, String>? =
        shown(ctx).getString("ring:$tag", null)?.split(':', limit = 2)?.let { (c, id) -> c.toLong() to id }

    // A plain one: a test, a new sign-in, or a note from the page itself.
    fun plain(ctx: Context, tag: String, title: String, body: String?, url: String, quiet: Boolean, sticky: Boolean = false) {
        val b = NotificationCompat.Builder(ctx, if (quiet) OTHER else MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ctx.getColor(R.color.brand))
            .setContentTitle(title)
            .setAutoCancel(!sticky)
            .setOngoing(sticky)
            .setContentIntent(open(ctx, url, tag.hashCode()))
        if (!body.isNullOrEmpty()) b.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        if (quiet) b.setSilent(true)
        post(ctx, tag, b.build())
    }
}
