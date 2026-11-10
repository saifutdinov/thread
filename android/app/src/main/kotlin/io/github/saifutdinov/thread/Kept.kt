package io.github.saifutdinov.thread

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Kept: the app's copy of what pushes need from the page's IndexedDB (chat
// keys, chat names and pictures, my names for people, language, hidden
// previews; web/src/lib/android.ts sends them). Values are kept as their
// JSON text. The file is encrypted with an AES key that never leaves the
// Android Keystore, and is excluded from backups (xml/no_backup.xml).
object Kept {
    private const val ALIAS = "thread-kept"
    private lateinit var file: AtomicFile
    private val map = HashMap<String, String>()
    private val writer = Executors.newSingleThreadScheduledExecutor()
    private var dirty = false

    fun init(ctx: Context) {
        file = AtomicFile(File(ctx.noBackupFilesDir, "kept.bin"))
        synchronized(this) { load() }
    }

    @Synchronized
    fun get(key: String): String? = map[key]

    // A JSON value, or null to forget the key; "*" forgets everything (logout).
    @Synchronized
    fun put(key: String, json: String?) {
        if (key == "*") map.clear()
        else if (json == null || json == "null") {
            if (map.remove(key) == null) return
        } else if (map.put(key, json) == json) return
        if (key == "*") {
            writer.execute { save() } // a sign-out leaves no keys behind, not even for a moment
            return
        }
        // Many writes come at once (the page sends everything it has at
        // start): one write of the file a moment later.
        if (!dirty) {
            dirty = true
            writer.schedule({ save() }, 500, TimeUnit.MILLISECONDS)
        }
    }

    // A chat key: kept as {"$b": base64} (android.ts plain()).
    fun bytes(key: String): ByteArray? = get(key)?.let {
        runCatching { Base64.decode(JSONObject(it).getString("\$b"), Base64.DEFAULT) }.getOrNull()
    }

    fun obj(key: String): JSONObject? = get(key)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun flag(key: String): Boolean = get(key) == "true"

    fun en(): Boolean = get("lang") == "\"en\""

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun load() {
        val blob = runCatching { file.readFully() }.getOrNull() ?: return
        runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, 12))
            val json = JSONObject(String(c.doFinal(blob, 12, blob.size - 12)))
            for (k in json.keys()) map[k] = json.getString(k)
        }
        // Unreadable (the keystore key was reset): start empty, the page
        // sends everything again on its next start.
    }

    private fun save() {
        val plain = synchronized(this) {
            dirty = false
            JSONObject(map as Map<*, *>).toString().toByteArray()
        }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val sealed = c.iv + c.doFinal(plain)
        val out = file.startWrite()
        try {
            out.write(sealed)
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
        }
    }
}
