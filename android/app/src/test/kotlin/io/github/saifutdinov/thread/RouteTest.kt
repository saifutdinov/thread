package io.github.saifutdinov.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteTest {
    @Test
    fun onlyTheApiReachesTheServer() {
        for (p in listOf("/api", "/api/chats", "/api/push/app", "/healthz", "/lk", "/lk/rtc")) assertTrue(p, Route.toServer(p))
        for (p in listOf("/", "/index.html", "/apix", "/api.js", "/lkx", "/healthz/x", "/assets/app.js")) assertFalse(p, Route.toServer(p))
    }

    @Test
    fun assetsStayInsideTheBundle() {
        assertEquals("www/index.html", Route.asset("/"))
        assertEquals("www/assets/index-1a2b.js", Route.asset("/assets/index-1a2b.js"))
        for (p in listOf("/../secret", "/assets/../../x", "/a//b", "/./x", "x", "/a\\b", "/a\u0000b", "/assets/")) assertNull(p, Route.asset(p))
    }

    @Test
    fun typesAndPolicy() {
        assertEquals("application/wasm", Route.mime("www/assets/a.wasm"))
        assertEquals("text/javascript", Route.mime("www/audio/rnnoise-worklet.js"))
        assertEquals("application/octet-stream", Route.mime("www/unknown.bin"))
        val h = Route.headers("www/assets/a.js", "chat.example.org")
        assertEquals("public, max-age=31536000, immutable", h["Cache-Control"])
        assertTrue(h.getValue("Content-Security-Policy").contains("connect-src 'self' wss://chat.example.org ws://chat.example.org;"))
        assertEquals("no-cache", Route.headers("www/index.html", "h")["Cache-Control"])
    }
}
