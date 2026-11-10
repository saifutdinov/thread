package io.github.saifutdinov.thread

import android.content.ContentValues
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

// The page's window.connectApp in the Android app (web/src/lib/pwa.ts
// NativeApp). Messages go both ways as JSON over a web message listener
// that only the server's origin, in the main frame, can reach: no
// JavascriptInterface, which every frame of every origin would see.
class Bridge(private val activity: MainActivity, private val web: WebView) {
    private var proxy: JavaScriptReplyProxy? = null
    private val queue = ArrayList<String>() // for the page, until it says hello
    private val io = Executors.newSingleThreadExecutor()
    private val updates = Executors.newSingleThreadExecutor() // a long download must not hold up a file save
    private val saving = HashMap<Long, Pair<Uri, OutputStream>>()
    var callOn = false
        private set
    var callVideo = false
        private set
    private var rang = false // this page showed the ring itself: it may take the app's ring down
    var busy = false // a call rings or goes on in the page
        private set

    // false: this WebView is too old for it; the page then runs as in a
    // browser, without the app's notifications.
    fun install(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return false
        val origins = setOf(BuildConfig.ORIGIN)
        WebViewCompat.addWebMessageListener(web, "ThreadAndroid", origins) { _, message, origin, main, reply ->
            if (main && origin.toString().trimEnd('/') == BuildConfig.ORIGIN) receive(message, reply)
        }
        WebViewCompat.addDocumentStartJavaScript(web, shim(), origins)
        current = WeakReference(this)
        return true
    }

    private fun receive(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val m = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        // A new page: its first message, "hello" or not (a load and its
        // messages are not ordered with onPageStarted).
        if (reply != proxy) {
            proxy = reply
            rang = false
            queue.forEach { reply.postMessage(it) }
            queue.clear()
        }
        when (m.optString("op")) {
            "notify" -> note(m.optJSONObject("note") ?: return)
            "bars" -> runCatching { android.graphics.Color.parseColor(m.optString("color")) }.getOrNull()?.let { activity.bars(it) }
            "clear" -> {
                val tag = m.optString("tag")
                // A page starting up clears rings left from before (call.ts
                // quiet()); the app's own ring stays until this page rings.
                if ((tag == "call" || tag == "gcall") && !rang) return
                if (tag.isNotEmpty()) Notes.cancel(activity, tag)
            }
            "token" -> token(m.optLong("id"))
            "brightness" -> activity.brightness(m.optBoolean("on"))
            "checkUpdate" -> {
                val id = m.optLong("id")
                updates.execute {
                    val v = Update.check()
                    send(JSONObject().put("op", "reply").put("id", id).put("value", if (v == null) JSONObject.NULL else JSONObject().put("version", v)))
                }
            }
            "installUpdate" -> {
                val id = m.optLong("id")
                updates.execute {
                    val r = runCatching { Update.install(activity) }.getOrElse { "failed" }
                    send(JSONObject().put("op", "reply").put("id", id).put("value", r))
                }
            }
            "gallery" -> {
                val id = m.optLong("id")
                activity.gallery { list -> send(JSONObject().put("op", "reply").put("id", id).put("value", list ?: JSONObject.NULL)) }
            }
            "notifications" -> send(
                JSONObject().put("op", "reply").put("id", m.optLong("id"))
                    .put("value", androidx.core.app.NotificationManagerCompat.from(activity).areNotificationsEnabled()),
            )
            "keep" -> Kept.put(m.optString("key"), json(m.opt("value")))
            "call" -> {
                val on = m.optBoolean("on")
                val video = m.optBoolean("video")
                val ringing = m.optBoolean("ringing")
                if (ringing) rang = true
                // Over: back behind the lock screen. Not on the page's first
                // report, which comes before a ring that opened the app arrives.
                if (busy && !on && !ringing) activity.overLock(false)
                busy = on || ringing
                if (on == callOn && video == callVideo) return // the page tells on every change of the call
                callOn = on
                callVideo = video
                CallService.update(activity, on, video)
                // While a call is on, the page's renderer keeps its priority
                // in the background too.
                web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !on)
            }
            "saveStart" -> io.execute { saveStart(m.optLong("id"), m.optString("name"), m.optString("type")) }
            "savePart" -> io.execute { savePart(m.optLong("id"), m.optString("data")) }
            "saveEnd" -> io.execute { saveEnd(m.optLong("id")) }
        }
    }

    // A note from the page itself (notify.ts). A ring this app already
    // shows from a push keeps its buttons and its ringtone.
    private fun note(n: JSONObject) {
        val tag = n.optString("tag").ifEmpty { "note" }
        if ((tag == "call" || tag == "gcall") && Notes.active(activity, tag) && Notes.ringing(activity, tag) != null) return
        Notes.plain(
            activity, tag, n.optString("title", "Thread"), n.optString("body"),
            n.optString("url").ifEmpty { "/" }, quiet = n.optBoolean("silent"), sticky = n.optBoolean("sticky"),
        )
    }

    private fun token(id: Long) {
        val answer = { t: String -> send(JSONObject().put("op", "reply").put("id", id).put("value", t)) }
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { answer(if (it.isSuccessful) it.result ?: "" else "") }
        } catch (e: IllegalStateException) {
            answer("") // built without the Firebase file: no pushes
        }
    }

    // Tells the page to route to a notification's URL.
    fun open(url: String) = send(JSONObject().put("op", "open").put("url", url))

    // Hands the page a message as sw.js would post it (android.ts onMessage).
    fun message(m: JSONObject) = send(JSONObject().put("op", "msg").put("m", m))

    private fun send(m: JSONObject) {
        main.post {
            val text = m.toString()
            proxy?.postMessage(text) ?: queue.add(text)
        }
    }

    fun reset() {
        proxy = null // a new page load says hello again
    }

    fun detach() {
        if (current?.get() == this) current = null
    }

    private fun saveStart(id: Long, name: String, type: String) {
        runCatching {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name.ifEmpty { "file" })
                put(MediaStore.Downloads.MIME_TYPE, type.ifEmpty { "application/octet-stream" })
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
            saving[id] = uri to activity.contentResolver.openOutputStream(uri)!!
        }.onFailure { toast(activity.getString(R.string.save_failed)) }
    }

    private fun savePart(id: Long, data: String) {
        val (uri, out) = saving[id] ?: return
        runCatching { out.write(Base64.decode(data, Base64.DEFAULT)) }.onFailure {
            saving.remove(id)
            runCatching { out.close() }
            activity.contentResolver.delete(uri, null, null)
            toast(activity.getString(R.string.save_failed))
        }
    }

    private fun saveEnd(id: Long) {
        val (uri, out) = saving.remove(id) ?: return
        runCatching {
            out.close()
            activity.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            val name = activity.contentResolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
            toast(activity.getString(R.string.saved, name ?: ""))
        }.onFailure { toast(activity.getString(R.string.save_failed)) }
    }

    private fun toast(text: String) = main.post { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }

    private fun shim(): String = SHIM.replace("__VERSION__", JSONObject.quote(BuildConfig.VERSION_NAME))

    companion object {
        private val main = Handler(Looper.getMainLooper())
        @Volatile
        private var current: WeakReference<Bridge>? = null

        // From a notification button, with or without a page awake.
        fun post(m: JSONObject) {
            current?.get()?.message(m)
        }

        // The value of a "keep" as JSON text, null to forget the key.
        fun json(v: Any?): String? = when (v) {
            null, JSONObject.NULL -> null
            is JSONObject, is JSONArray -> v.toString()
            is String -> JSONObject.quote(v)
            else -> v.toString()
        }

        // Runs before the page's own scripts, on the server's origin only.
        // Files go to Downloads in pieces: a WebView ignores <a download>,
        // and one message the size of a video would not fit.
        private const val SHIM = """(() => {
  const port = window.ThreadAndroid;
  if (!port || window.connectApp) return;
  const send = (m) => port.postMessage(JSON.stringify(m));
  let seq = 0, opener = null, handler = null;
  const waiting = new Map(), queue = [];
  const flush = () => {
    const rest = [];
    for (const m of queue.splice(0)) {
      if (m.op === 'open' && opener) opener(m.url);
      else if (m.op === 'msg' && handler) handler(m.m);
      else rest.push(m);
    }
    queue.push(...rest);
  };
  port.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.op === 'reply') {
      const ok = waiting.get(m.id);
      waiting.delete(m.id);
      if (ok) ok(m.value);
      return;
    }
    queue.push(m);
    flush();
  };
  const ask = (m) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); send({ ...m, id }); });
  window.connectApp = {
    version: __VERSION__,
    platform: 'android',
    show() {},
    notify(note) { send({ op: 'notify', note }); },
    clear(tag) { send({ op: 'clear', tag }); },
    onOpen(fn) { opener = fn; flush(); },
    onMessage(fn) { handler = fn; flush(); },
    pushToken() { return ask({ op: 'token' }); },
    gallery() { return ask({ op: 'gallery' }); },
    brightness(on) { send({ op: 'brightness', on }); },
    checkUpdate() { return ask({ op: 'checkUpdate' }); },
    installUpdate() { return ask({ op: 'installUpdate' }); },
    keep(key, value) { send({ op: 'keep', key, value: value === undefined ? null : value }); },
    callState(on, video, ringing) { send({ op: 'call', on, video, ringing }); },
    notificationsOn() { return ask({ op: 'notifications' }); },
    async save(url, name) {
      const blob = await (await fetch(url)).blob();
      const id = ++seq, step = 512 * 1024;
      send({ op: 'saveStart', id, name, type: blob.type });
      for (let i = 0; i < blob.size; i += step) {
        const b = new Uint8Array(await blob.slice(i, i + step).arrayBuffer());
        let s = '';
        for (let j = 0; j < b.length; j += 0x8000) s += String.fromCharCode.apply(null, b.subarray(j, j + 0x8000));
        send({ op: 'savePart', id, data: btoa(s) });
      }
      send({ op: 'saveEnd', id });
    },
  };
  send({ op: 'hello' });
  // The system bars follow the page's theme-color (prefs.ts keeps it in step with the theme).
  const bars = () => {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) send({ op: 'bars', color: m.content });
  };
  document.addEventListener('DOMContentLoaded', () => {
    bars();
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) new MutationObserver(bars).observe(m, { attributes: true });
  });
})();"""
    }
}
