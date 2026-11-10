package io.github.saifutdinov.thread

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// What a push says, in the language chosen in the app (IndexedDB "lang",
// kept by android.ts): the texts and rules of web/public/sw.js, which shows
// the same pushes in a browser. Change both together.
class Words(en: Boolean) {
    private val t = if (en) EN else RU
    operator fun get(key: String): String = t.getValue(key)

    // A decrypted message, reduced to what a notification shows.
    data class Attachment(val type: String?, val name: String?, val title: String?, val artist: String?)
    data class Plain(val text: String?, val attachment: Attachment?, val call: String?) // call: the call log's status

    fun body(p: Plain): String {
        if (p.call != null) return if (p.call == "missed" || p.call == "busy") t.getValue("missed") else t.getValue("callLog")
        val text = (p.text ?: "").replace(MARKUP, "").replace(QUOTE, "").trim()
        if (text.isNotEmpty()) return text
        val a = p.attachment ?: return t.getValue("msg")
        return when (a.type) {
            "voice" -> t.getValue("voice")
            "video" -> t.getValue("video")
            "clip" -> t.getValue("clip")
            "file" -> if (!a.title.isNullOrEmpty()) "🎵 " + listOfNotNull(a.artist, a.title).filter { it.isNotEmpty() }.joinToString(" - ")
            else a.name?.takeIf { it.isNotEmpty() }?.let { "📎 $it" } ?: t.getValue("file")
            else -> t.getValue("photo")
        }
    }

    companion object {
        private val MARKUP = Regex("\\*\\*|__|~~|`")
        private val QUOTE = Regex("(?m)^>\\s?")

        // A message body: base64 of iv (12 bytes) || AES-GCM ciphertext, with
        // the chat's key for its epoch and AAD "m:<chat>:<epoch>" (ADR 0001).
        fun open(key: ByteArray, body: String, chat: Long, epoch: Long): String {
            val blob = Base64.getDecoder().decode(body)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, blob, 0, 12))
            c.updateAAD("m:$chat:$epoch".toByteArray())
            return String(c.doFinal(blob, 12, blob.size - 12))
        }

        private val RU = mapOf(
            "callEnded" to "Этот вызов больше не ожидает ответа",
            "call" to "Входящий звонок",
            "callVideo" to "Входящий видеозвонок",
            "groupCall" to "Зовёт в групповой звонок",
            "groupCallVideo" to "Зовёт в групповой видеозвонок",
            "answer" to "Ответить",
            "decline" to "Отклонить",
            "join" to "Присоединиться",
            "read" to "Прочитано",
            "more" to "новых: {n}",
            "test" to "Уведомления работают",
            "testBody" to "Так будут выглядеть сообщения и звонки.",
            "msg" to "Новое сообщение",
            "photo" to "📷 Фото",
            "voice" to "🎤 Голосовое сообщение",
            "video" to "📹 Видеосообщение",
            "clip" to "🎬 Видео",
            "callLog" to "📞 Звонок",
            "missed" to "📞 Пропущенный звонок",
            "file" to "📎 Файл",
            "login" to "Новый вход в аккаунт: {label}. Откройте Нитку, чтобы разрешить или запретить.",
        )
        private val EN = mapOf(
            "callEnded" to "This call is no longer ringing",
            "call" to "Incoming call",
            "callVideo" to "Incoming video call",
            "groupCall" to "Invites you to a group call",
            "groupCallVideo" to "Invites you to a group video call",
            "answer" to "Answer",
            "decline" to "Decline",
            "join" to "Join",
            "read" to "Mark as read",
            "more" to "{n} new",
            "test" to "Notifications work",
            "testBody" to "This is how messages and calls will look.",
            "msg" to "New message",
            "photo" to "📷 Photo",
            "voice" to "🎤 Voice message",
            "video" to "📹 Video message",
            "clip" to "🎬 Video",
            "callLog" to "📞 Call",
            "missed" to "📞 Missed call",
            "file" to "📎 File",
            "login" to "New sign-in to your account: {label}. Open Thread to allow or deny it.",
        )
    }
}
