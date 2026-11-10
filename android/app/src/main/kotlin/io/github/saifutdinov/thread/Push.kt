package io.github.saifutdinov.thread

import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

// Pushes from the server through FCM (internal/server/fcm.go): the same
// JSON a browser's service worker gets, shown the way web/public/sw.js
// shows it. Ciphertext only; the text is decrypted here with the chat key
// the page left in Kept.
class Push : FirebaseMessagingService() {
    // A new token reaches the server at once if the session is there, else
    // the page sends it on its next start (pwa.ts subscribe).
    override fun onNewToken(token: String) {
        Net.send("POST", "/api/push/app", JSONObject().put("token", token).toString())
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = runCatching { JSONObject(message.data["p"] ?: "{}") }.getOrElse { JSONObject() }
        show(applicationContext, d)
    }

    companion object {
        fun show(ctx: Context, d: JSONObject) {
            val w = Words(Kept.en())
            when (d.optString("t")) {
                // Silent ones: read on another device, the call taken there.
                "read" -> {
                    val c = d.optLong("c")
                    val newest = Notes.newest(ctx, c)
                    if (newest == null || newest <= d.optLong("id")) Notes.cancel(ctx, "c$c")
                }
                "callEnd" -> {
                    val tag = if (d.optBoolean("g")) "gcall" else "call"
                    val id = d.optString("id")
                    if (id.isNotEmpty() && Notes.ringing(ctx, tag)?.second == id) Notes.cancel(ctx, tag)
                }
                "test" -> Notes.plain(ctx, "test", w["test"], w["testBody"], "/#/settings", quiet = false)
                "device" -> Notes.plain(
                    ctx, "device", "Thread", w["login"].replace("{label}", d.optString("label").ifEmpty { "?" }),
                    "/#/settings", quiet = false,
                )
                "call" -> call(ctx, d, w)
                "msg" -> message(ctx, d, w)
            }
        }

        // Who wrote, by the name I gave them, else their own.
        private fun from(d: JSONObject): String =
            Kept.obj("names")?.optString(d.optLong("u").toString())?.takeIf { it.isNotEmpty() }
                ?: d.optString("n").ifEmpty { "Thread" }

        private fun call(ctx: Context, d: JSONObject, w: Words) {
            val c = d.optLong("c")
            val id = d.optString("id")
            val group = d.optBoolean("g")
            // A ring that waited for an offline phone may be over already.
            if (Net.ringing(c, id) == false) {
                val tag = if (group) "gcall" else "call"
                if (Notes.ringing(ctx, tag)?.second == id) Notes.cancel(ctx, tag)
                return
            }
            val hide = Kept.flag("hidePreview")
            val note = Kept.obj("push:$c") ?: JSONObject()
            val picture = if (hide) null else note.optString("i").ifEmpty { null }
            if (group) {
                val from = from(d)
                val what = w[if (d.optBoolean("v")) "groupCallVideo" else "groupCall"]
                Notes.groupRing(
                    ctx, c, id,
                    if (hide) "Thread" else "📞 " + note.optString("t").ifEmpty { from },
                    if (hide) w["groupCall"] else "$from · " + what.lowercase(),
                    picture,
                )
            } else {
                val name = if (hide) "Thread" else note.optString("t").ifEmpty { d.optString("n").ifEmpty { "Thread" } }
                Notes.ring(ctx, c, id, name, picture, d.optBoolean("v"))
            }
        }

        private fun message(ctx: Context, d: JSONObject, w: Words) {
            val c = d.optLong("c")
            val e = d.optLong("e")
            val key = Kept.bytes("k:$c:$e")
            val body = d.optString("b")
            // No key on this device yet, or no body (too big for a push): generic text.
            val p = if (key != null && body.isNotEmpty()) runCatching { JSONObject(Words.open(key, body, c, e)) }.getOrNull() else null
            if (p?.has("cl") == true) {
                // A call's log can arrive late: stop this chat's ring only if
                // its exact call is confirmed over.
                Notes.ringing(ctx, "call")?.let { (rc, rid) -> if (rc == c && Net.ringing(rc, rid) == false) Notes.cancel(ctx, "call") }
            }
            // Hidden previews: say nothing about who or what, not even how many.
            if (Kept.flag("hidePreview")) {
                Notes.plain(ctx, "c$c", "Thread", w["msg"], "/#/c/$c", quiet = false)
                return
            }
            val text = if (p == null) w["msg"] else w.body(
                Words.Plain(
                    text = p.optString("t"),
                    attachment = p.optJSONArray("a")?.optJSONObject(0)?.let {
                        Words.Attachment(it.optString("t"), it.optString("n"), it.optString("ti"), it.optString("ar"))
                    },
                    call = p.optJSONObject("cl")?.optString("s"),
                ),
            )
            val note = Kept.obj("push:$c") ?: JSONObject()
            val from = from(d)
            val group = note.optBoolean("g")
            val title = if (group) note.optString("t").ifEmpty { from } else from
            Notes.message(
                ctx, c, d.optLong("m"), title, if (group) "$from: $text" else text,
                note.optString("i").ifEmpty { null }, d.optLong("at"), quiet = false,
            )
        }
    }
}
