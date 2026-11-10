package io.github.saifutdinov.thread

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

// Updates from this app's server (docs/updates.md): the newest APK in the
// release manifest, downloaded, checked against its SHA-256, then checked to
// be this very app (same package, same signing certificate) before
// Android's installer gets it and asks the person once more. A broken
// server cannot slip in an APK of its own, not even one that would install
// as another app with our name and icon.
object Update {
    private fun manifestApk(): JSONObject? {
        val c = URL(BuildConfig.ORIGIN + "/api/downloads/manifest.json").openConnection() as HttpURLConnection
        return try {
            c.connectTimeout = 10_000
            c.readTimeout = 10_000
            c.instanceFollowRedirects = false
            if (c.responseCode != 200) return null
            val files = JSONObject(c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }).optJSONArray("files") ?: return null
            (0 until files.length()).map { files.getJSONObject(it) }.firstOrNull { it.optString("platform") == "android" }
        } finally {
            c.disconnect()
        }
    }

    // The APK is this app: the same package, signed by the same certificates.
    private fun ours(ctx: Context, file: File): Boolean {
        val pm = ctx.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val theirs = pm.getPackageArchiveInfo(file.path, flags) ?: return false
        val mine = pm.getPackageInfo(ctx.packageName, flags)
        fun signers(i: PackageInfo) = i.signingInfo?.apkContentsSigners?.map { Base64.encodeToString(it.toByteArray(), Base64.NO_WRAP) }?.toSet()
        val want = signers(mine) ?: return false
        return theirs.packageName == ctx.packageName && want.isNotEmpty() && signers(theirs) == want
    }

    // a after b, both x.y.z.
    fun newer(a: String, b: String): Boolean {
        val pa = a.split('.').map { it.toIntOrNull() ?: return false }
        val pb = b.split('.').map { it.toIntOrNull() ?: return false }
        if (pa.size != 3 || pb.size != 3) return false
        for (i in 0..2) if (pa[i] != pb[i]) return pa[i] > pb[i]
        return false
    }

    // The newer version this server has for the app, or null.
    fun check(): String? = runCatching {
        manifestApk()?.optString("version")?.takeIf { newer(it, BuildConfig.VERSION_NAME) }
    }.getOrNull()

    // "permission": Android must first let this app install apps (the
    // settings page is open now); "installing": the installer is up.
    fun install(ctx: Context): String {
        if (!ctx.packageManager.canRequestPackageInstalls()) {
            ctx.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return "permission"
        }
        val apk = manifestApk() ?: error("no update")
        val name = apk.getString("name")
        require(Regex("^Thread-[0-9.]+\\.apk$").matches(name))
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // an older download
        val file = File(dir, name)
        val c = URL(BuildConfig.ORIGIN + "/api/downloads/" + name).openConnection() as HttpURLConnection
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            c.instanceFollowRedirects = false
            check(c.responseCode == 200) { "download ${c.responseCode}" }
            c.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
        } finally {
            c.disconnect()
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        if (hex != apk.optString("sha256") || !ours(ctx, file)) {
            file.delete()
            error("not this app's update")
        }
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return "installing"
    }
}
