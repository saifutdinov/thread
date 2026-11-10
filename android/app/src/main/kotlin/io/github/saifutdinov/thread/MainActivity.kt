package io.github.saifutdinov.thread

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature
import java.io.FileNotFoundException

// One window with the web interface, carried inside the app and served on
// the server's own origin: the session cookie, the WebSocket and the
// server's origin checks work as in a browser, and a broken server cannot
// hand the app altered code. Only /api, /lk and /healthz reach the server.
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var frame: FrameLayout
    private var bridge: Bridge? = null
    private var files: ValueCallback<Array<Uri>>? = null
    private var asked: PermissionRequest? = null
    private val host = Uri.parse(BuildConfig.ORIGIN).host!!

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        files?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        files = null
    }

    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        val req = asked ?: return@registerForActivityResult
        asked = null
        val allowed = req.resources.filter {
            (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && got[Manifest.permission.RECORD_AUDIO] != false && has(Manifest.permission.RECORD_AUDIO)) ||
                (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && got[Manifest.permission.CAMERA] != false && has(Manifest.permission.CAMERA))
        }
        if (allowed.isEmpty()) req.deny() else req.grant(allowed.toTypedArray())
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { fullScreen() }

    // The gallery for the attach sheet: asked for on its first opening.
    private var galleryWaiting: ((org.json.JSONArray?) -> Unit)? = null
    private val askGallery = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val done = galleryWaiting ?: return@registerForActivityResult
        galleryWaiting = null
        // Refused for good ("don't ask again"): the system shows no prompt any
        // more, so the app's own settings page, where it can be allowed.
        if (!Gallery.allowed(this) && Gallery.permissions().none { shouldShowRequestPermissionRationale(it) }) {
            runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        }
        listGallery(done)
    }

    fun gallery(done: (org.json.JSONArray?) -> Unit) {
        if (Gallery.allowed(this)) return listGallery(done)
        galleryWaiting?.invoke(null) // asked again while the prompt is up: the earlier one gets an answer too
        galleryWaiting = done
        askGallery.launch(Gallery.permissions())
    }

    private fun listGallery(done: (org.json.JSONArray?) -> Unit) {
        if (!Gallery.allowed(this)) return done(null)
        Thread { done(runCatching { Gallery.list(contentResolver) }.getOrNull()) }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        noServiceWorkers()
        web = WebView(this)
        bridge = Bridge(this, web).takeIf { it.install() }
        if (bridge == null) {
            // Too old a WebView for the bridge: the page would run without the
            // app's guards. Ask for an update instead of showing it.
            setContentView(TextView(this).apply { setText(R.string.no_webview); setPadding(48, 160, 48, 48); textSize = 18f })
            return
        }
        // The page sits between the system bars and above the keyboard. The
        // padding goes on a frame around the WebView: a WebView's own padding
        // does not move its page, which then ran under the status bar.
        frame = FrameLayout(this).apply { addView(web) }
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        bars(getColor(R.color.window))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // the ringtone and the call's sound start on their own
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        onBackPressedDispatcher.addCallback(this) {
            // Back walks the page's history; at its start the app goes to the
            // background instead of closing, so its socket stays a while.
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }

        web.loadUrl(BuildConfig.ORIGIN + "/")
        // Restored after the process died, or reopened from Recents: the tap
        // that once started it was handled already.
        if (savedInstanceState == null) {
            handle(intent)
            firstStart()
        }
    }

    // The page never registers one in the app (pwa.ts), and none may run:
    // a worker's own requests bypass shouldInterceptRequest and would bring
    // the server's files onto the app's origin.
    private fun noServiceWorkers() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
        val sw = ServiceWorkerControllerCompat.getInstance()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BLOCK_NETWORK_LOADS)) sw.serviceWorkerWebSettings.blockNetworkLoads = true
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            sw.setServiceWorkerClient(object : ServiceWorkerClientCompat() {
                override fun shouldInterceptRequest(request: WebResourceRequest) =
                    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
            })
        }
    }

    // The strips behind the system bars take the page's colour (its
    // theme-color, which follows the app's theme), with icons that read on it.
    fun bars(color: Int) {
        frame.setBackgroundColor(color)
        val light = androidx.core.graphics.ColorUtils.calculateLuminance(color) > 0.5
        WindowCompat.getInsetsController(window, frame).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
    }

    // The screen at full brightness for the front camera's ring light, or the system's own.
    fun brightness(on: Boolean) {
        window.attributes = window.attributes.apply {
            screenBrightness = if (on) 1f else android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
    }

    // Over the lock screen only while a call rings or goes on, like a phone
    // call; after it, the chats are behind the lock again.
    fun overLock(on: Boolean) {
        setShowWhenLocked(on)
        setTurnScreenOn(on)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    // A tap on one of the app's notifications.
    private fun handle(intent: Intent?) {
        val b = bridge ?: return
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        when (intent.action) {
            RING -> {
                overLock(true)
                intent.getStringExtra("url")?.let { b.open(it) }
                // The ring may end before the page connects and gets it.
                web.postDelayed({ if (!b.busy) overLock(false) }, 60_000)
            }
            OPEN -> intent.getStringExtra("url")?.takeIf { it.isNotEmpty() }?.let { b.open(it) }
            ANSWER -> {
                overLock(true)
                Notes.cancel(this, "call")
                val c = intent.getLongExtra("c", 0)
                b.open("/#/c/$c")
                b.message(org.json.JSONObject().put("t", "call").put("k", "answer").put("id", intent.getStringExtra("id")).put("c", c))
            }
            JOIN -> {
                Notes.cancel(this, "gcall")
                val c = intent.getLongExtra("c", 0)
                b.open("/#/c/$c")
                b.message(org.json.JSONObject().put("t", "gjoin").put("c", c).put("id", intent.getStringExtra("id")))
            }
        }
    }

    // The first start asks for notifications, then for rings over the lock screen.
    private fun firstStart() {
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            fullScreen()
        }
    }

    private fun fullScreen() {
        if (Build.VERSION.SDK_INT < 34) return
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        if (getSystemService(NotificationManager::class.java).canUseFullScreenIntent() || prefs.getBoolean("askedFullScreen", false)) return
        prefs.edit().putBoolean("askedFullScreen", true).apply()
        AlertDialog.Builder(this)
            .setTitle(R.string.fullscreen_title)
            .setMessage(R.string.fullscreen_text)
            .setPositiveButton(R.string.fullscreen_open) { _, _ ->
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            }
            .setNegativeButton(R.string.later, null)
            .show()
    }

    // A video call shrinks into a small window when the app is left.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        val b = bridge ?: return
        if (b.callOn && b.callVideo) {
            runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(3, 4)).build()) }
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush() // the session survives the app being killed
    }

    override fun onStop() {
        super.onStop()
        if (bridge?.callOn != true) overLock(false)
    }

    override fun onDestroy() {
        bridge?.let {
            it.detach()
            CallService.update(this, false, false)
        }
        web.destroy()
        super.onDestroy()
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
            val u = req.url
            if (u.scheme != "https" || u.host != host || u.port != -1) return null
            val path = u.path ?: "/"
            // The phone's own photos for the attach sheet's own requests:
            // never the server's, and never a page of their own.
            if (path.startsWith("/_gallery/")) return if (req.method == "GET" && !req.isForMainFrame) Gallery.serve(this@MainActivity, path) else notFound()
            if (Route.toServer(path)) {
                // The API for the page's requests, never as a page or a frame:
                // whatever the server answered would run on the app's origin.
                return if (req.isForMainFrame) notFound() else null
            }
            if (req.method != "GET") return WebResourceResponse("text/plain", "utf-8", 405, "Method Not Allowed", emptyMap(), null)
            val asset = Route.asset(path) ?: return notFound()
            val mime = Route.mime(asset)
            return try {
                WebResourceResponse(mime, if (Route.text(mime)) "utf-8" else null, 200, "OK", Route.headers(asset, host), assets.open(asset))
            } catch (e: FileNotFoundException) {
                notFound()
            }
        }

        private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)

        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            val u = req.url
            if (u.scheme == "https" && u.host == host && u.port == -1) {
                val path = u.path ?: "/"
                if (path.startsWith("/_gallery/")) return true // a link to a phone's photo opens nothing
                if (!Route.toServer(path)) return false
                // An installer goes to the browser, which downloads it (and
                // offers to install an APK); other server paths are not pages.
                if (path.startsWith("/api/downloads/")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
            // Links elsewhere open in the browser; other schemes are not followed.
            if (u.scheme in setOf("https", "http", "mailto", "tel")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            bridge?.reset()
        }

        // The page's renderer died (memory, a crash): start the window again.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(req: PermissionRequest) {
            runOnUiThread {
                if (req.origin.toString().trimEnd('/') != BuildConfig.ORIGIN) return@runOnUiThread req.deny()
                val need = req.resources.mapNotNull {
                    when (it) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                        else -> null
                    }
                }
                if (need.isEmpty()) return@runOnUiThread req.deny()
                asked?.deny()
                asked = req
                askMedia.launch(need.toTypedArray())
            }
        }

        override fun onPermissionRequestCanceled(req: PermissionRequest) {
            if (asked == req) asked = null
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            files?.onReceiveValue(null)
            files = callback
            return try {
                pickFiles.launch(params.createIntent())
                true
            } catch (e: Exception) {
                files = null
                false
            }
        }
    }

    companion object {
        const val OPEN = "io.github.saifutdinov.thread.OPEN"
        const val RING = "io.github.saifutdinov.thread.RING"
        const val ANSWER = "io.github.saifutdinov.thread.ANSWER"
        const val JOIN = "io.github.saifutdinov.thread.JOIN"
    }
}
