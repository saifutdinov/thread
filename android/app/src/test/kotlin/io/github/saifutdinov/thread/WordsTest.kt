package io.github.saifutdinov.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class WordsTest {
    private val ru = Words(en = false)
    private val en = Words(en = true)

    // As the page seals a message (web/src/lib/crypto.ts): iv || AES-GCM, AAD "m:<chat>:<epoch>".
    private fun seal(key: ByteArray, text: String, aad: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad.toByteArray())
        return Base64.getEncoder().encodeToString(iv + c.doFinal(text.toByteArray()))
    }

    @Test
    fun opensWhatThePageSealed() {
        val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val body = seal(key, """{"t":"привет"}""", "m:7:3")
        assertEquals("""{"t":"привет"}""", Words.open(key, body, 7, 3))
        // Another chat's or epoch's AAD: not this message.
        assertThrows(AEADBadTagException::class.java) { Words.open(key, body, 8, 3) }
        assertThrows(AEADBadTagException::class.java) { Words.open(key, body, 7, 2) }
    }

    @Test
    fun summariesMatchTheServiceWorker() {
        fun plain(text: String? = null, a: Words.Attachment? = null, call: String? = null) = Words.Plain(text, a, call)
        assertEquals("жирный и\nцитата", ru.body(plain("**жирный** и\n> цитата")))
        assertEquals("line", ru.body(plain("> line")))
        assertEquals("Новое сообщение", ru.body(plain("")))
        assertEquals("🎤 Голосовое сообщение", ru.body(plain(a = Words.Attachment("voice", "", "", ""))))
        assertEquals("📎 report.pdf", ru.body(plain(a = Words.Attachment("file", "report.pdf", "", ""))))
        assertEquals("📎 File", en.body(plain(a = Words.Attachment("file", "", "", ""))))
        assertEquals("🎵 Artist - Song", ru.body(plain(a = Words.Attachment("file", "x.mp3", "Song", "Artist"))))
        assertEquals("🎵 Song", ru.body(plain(a = Words.Attachment("file", "x.mp3", "Song", ""))))
        assertEquals("📷 Photo", en.body(plain(a = Words.Attachment("image", "", "", ""))))
        assertEquals("📞 Пропущенный звонок", ru.body(plain(call = "missed")))
        assertEquals("📞 Missed call", en.body(plain(call = "busy")))
        assertEquals("📞 Звонок", ru.body(plain(text = "ignored", call = "")))
    }
}
