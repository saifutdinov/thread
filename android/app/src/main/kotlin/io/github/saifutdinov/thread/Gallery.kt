package io.github.saifutdinov.thread

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.BaseColumns
import android.provider.MediaStore
import android.util.Size
import android.webkit.WebResourceResponse
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

// The phone's photos and videos for the attach sheet (web: AttachSheet.tsx),
// newest first. The page gets a list, then thumbnails and files from
// /_gallery/... on its own origin, answered here (MainActivity
// shouldInterceptRequest): nothing of it goes to the server until the person
// sends it, encrypted, like any attachment.
object Gallery {
    private const val LIMIT = 300

    // What to ask for: Android 14 can grant only the photos the person picks.
    fun permissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    fun allowed(ctx: Context): Boolean {
        fun has(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
        return when {
            Build.VERSION.SDK_INT >= 34 -> has(Manifest.permission.READ_MEDIA_IMAGES) || has(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            Build.VERSION.SDK_INT >= 33 -> has(Manifest.permission.READ_MEDIA_IMAGES) || has(Manifest.permission.READ_MEDIA_VIDEO)
            else -> has(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    // [{id, k: image|video, m, w, h, d (ms), s (bytes), n}]
    fun list(cr: ContentResolver): JSONArray {
        val out = JSONArray()
        // Columns by the interface that declares them: Kotlin does not reach
        // a Java interface's constants through an interface extending it.
        val cols = arrayOf(
            BaseColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.DURATION,
            MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DISPLAY_NAME,
        )
        val args = Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)")
            putStringArray(
                ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
                arrayOf("${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}", "${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO}"),
            )
            putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.MediaColumns.DATE_ADDED))
            putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
            putInt(ContentResolver.QUERY_ARG_LIMIT, LIMIT)
        }
        cr.query(MediaStore.Files.getContentUri("external"), cols, args, null)?.use { c ->
            // The limit again: an older MediaProvider may ignore QUERY_ARG_LIMIT.
            while (out.length() < LIMIT && c.moveToNext()) {
                val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                out.put(
                    JSONObject()
                        .put("id", c.getLong(0))
                        .put("k", if (video) "video" else "image")
                        .put("m", c.getString(2) ?: "")
                        .put("w", c.getInt(3))
                        .put("h", c.getInt(4))
                        .put("d", c.getLong(5))
                        .put("s", c.getLong(6))
                        .put("n", c.getString(7) ?: ""),
                )
            }
        }
        return out
    }

    private fun uri(kind: String, id: Long): Uri = ContentUris.withAppendedId(
        if (kind == "video") MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id,
    )

    // /_gallery/thumb/<kind>/<id> and /_gallery/file/<kind>/<id>.
    fun serve(ctx: Context, path: String): WebResourceResponse {
        val parts = path.split('/')
        val id = parts.getOrNull(4)?.toLongOrNull()
        val kind = parts.getOrNull(3)
        if (parts.size != 5 || id == null || (kind != "image" && kind != "video") || !allowed(ctx)) return missing()
        val cr = ctx.contentResolver
        val u = uri(kind, id)
        // Opened as anything but a picture or a video, it does nothing.
        val headers = mapOf(
            "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
            "Content-Security-Policy" to "default-src 'none'; sandbox",
        )
        return runCatching {
            when (parts[2]) {
                "thumb" -> {
                    val out = ByteArrayOutputStream()
                    cr.loadThumbnail(u, Size(320, 320), null).compress(Bitmap.CompressFormat.JPEG, 80, out)
                    WebResourceResponse("image/jpeg", null, 200, "OK", headers, ByteArrayInputStream(out.toByteArray()))
                }
                "file" -> {
                    // Pictures and videos only: an SVG in the collection could carry script.
                    val type = cr.getType(u) ?: ""
                    val media = (type.startsWith("image/") && type != "image/svg+xml") || type.startsWith("video/")
                    if (!media) missing() else WebResourceResponse(type, null, 200, "OK", headers, cr.openInputStream(u))
                }
                else -> missing()
            }
        }.getOrElse { missing() }
    }

    private fun missing() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
}
