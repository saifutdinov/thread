package io.github.saifutdinov.thread

// Which requests on the server's origin reach the server, and which file
// of the app's own copy of the interface answers the rest. The same rules
// as the desktop app (desktop/app/lib/route.js): the server answers unknown
// paths with its own index.html, whose code must never run on this origin.
object Route {
    fun toServer(path: String): Boolean =
        path.startsWith("/api/") || path == "/api" || path == "/healthz" || path == "/lk" || path.startsWith("/lk/")

    // The asset under www/ for a decoded request path, or null: a 404.
    fun asset(path: String): String? {
        if (!path.startsWith("/") || path.contains('\u0000') || path.contains('\\')) return null
        val name = if (path == "/") "/index.html" else path
        val parts = name.split('/').drop(1)
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return "www/" + parts.joinToString("/")
    }

    private val types = mapOf(
        "html" to "text/html",
        "js" to "text/javascript",
        "css" to "text/css",
        "json" to "application/json",
        "webmanifest" to "application/manifest+json",
        "wasm" to "application/wasm",
        "png" to "image/png",
        "svg" to "image/svg+xml",
        "txt" to "text/plain",
        "woff2" to "font/woff2",
        "mp3" to "audio/mpeg",
        "ogg" to "audio/ogg",
        "tflite" to "application/octet-stream",
        "task" to "application/octet-stream",
    )

    fun mime(asset: String): String = types[asset.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

    fun text(mime: String) = mime.startsWith("text/") || mime == "application/json" || mime == "application/manifest+json" || mime == "image/svg+xml"

    // The same policy the server sends (internal/server/server.go, secure).
    fun headers(asset: String, host: String): Map<String, String> = mapOf(
        "Cache-Control" to if (asset.startsWith("www/assets/")) "public, max-age=31536000, immutable" else "no-cache",
        "Content-Security-Policy" to
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://$host ws://$host; " +
            "worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
    )
}
