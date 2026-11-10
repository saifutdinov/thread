package io.github.saifutdinov.thread

import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

// Requests a notification makes with no page open (sw.js does the same with
// fetch): the call's status, declining it, marking a chat read. They carry
// the page's session cookie from the WebView.
object Net {
    // The HTTP status, or null when the server was not reached.
    fun send(method: String, path: String, json: String? = null, timeoutMs: Int = 8000): Pair<Int, String>? = runCatching {
        val c = URL(BuildConfig.ORIGIN + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.instanceFollowRedirects = false
            CookieManager.getInstance().getCookie(BuildConfig.ORIGIN)?.let { c.setRequestProperty("Cookie", it) }
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toByteArray()) }
            }
            val code = c.responseCode
            val body = (if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            code to body
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    // Whether the call still rings: true, false, or null when unknown (then
    // it rings: a missed call is worse than a ring that stops by itself).
    fun ringing(chat: Long, id: String): Boolean? {
        if (chat <= 0 || id.isEmpty() || id.length > 64) return false
        val (code, body) = send("GET", "/api/chats/$chat/call-status?call=" + java.net.URLEncoder.encode(id, "UTF-8"), timeoutMs = 2500) ?: return null
        if (code != 200) return null
        return runCatching { org.json.JSONObject(body).getBoolean("ringing") }.getOrNull()
    }
}
