package com.cutlinestudio.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class MainActivity : ComponentActivity() {

  private lateinit var rootLayout: FrameLayout
  private lateinit var webView: WebView
  private lateinit var updateManager: UpdateManager

  private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
  private var lastExportUri: Uri? = null
  private var lastExportMime: String = "application/pdf"
  private var lastExportName: String = "CutlineStudio.pdf"

  private val filePickerLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val callback = pendingFileChooserCallback
    pendingFileChooserCallback = null
    if (callback == null) return@registerForActivityResult

    if (result.resultCode != RESULT_OK || result.data == null) {
      callback.onReceiveValue(null)
      return@registerForActivityResult
    }

    val uris = mutableListOf<Uri>()
    val data = result.data!!
    val clip = data.clipData
    if (clip != null) {
      for (i in 0 until clip.itemCount) {
        clip.getItemAt(i)?.uri?.let { uris.add(it) }
      }
    } else {
      data.data?.let { uris.add(it) }
    }
    callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
  }

  private val legacyStorageLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { /* Export helper gracefully falls back to app external folder if denied */ }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    val nightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val barColor = if (nightMode) Color.parseColor("#111215") else Color.parseColor("#EBECF0")
    val barStyle = if (nightMode) SystemBarStyle.dark(barColor) else SystemBarStyle.light(barColor, barColor)
    enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)

    super.onCreate(savedInstanceState)

    rootLayout = FrameLayout(this).apply {
      setBackgroundColor(barColor)
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }

    webView = WebView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    rootLayout.addView(webView)
    setContentView(rootLayout)

    ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { v, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      WindowInsetsCompat.CONSUMED
    }

    updateManager = UpdateManager(this) { stateJson ->
      val escaped = JSONObject.quote(stateJson.toString())
      webView.evaluateJavascript(
        "if (typeof window.__cutlineOnUpdateState === 'function') window.__cutlineOnUpdateState($escaped);",
        null
      )
    }

    val assetLoader = WebViewAssetLoader.Builder()
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
      .build()

    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = true
      useWideViewPort = true
      loadWithOverviewMode = true
      builtInZoomControls = false
      displayZoomControls = false
      textZoom = 100
      mediaPlaybackRequiresUserGesture = true
      cacheMode = WebSettings.LOAD_DEFAULT
    }

    webView.addJavascriptInterface(AndroidBridge(), "CutlineAndroid")

    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest
      ): WebResourceResponse? {
        val resp = assetLoader.shouldInterceptRequest(request.url) ?: return null
        val path = request.url.path.orEmpty().lowercase()
        val mime = when {
          path.endsWith(".html") -> "text/html"
          path.endsWith(".js") || path.endsWith(".mjs") -> "application/javascript"
          path.endsWith(".css") -> "text/css"
          path.endsWith(".json") || path.endsWith(".webmanifest") -> "application/json"
          path.endsWith(".svg") -> "image/svg+xml"
          path.endsWith(".png") -> "image/png"
          path.endsWith(".wasm") -> "application/wasm"
          else -> resp.mimeType
        }
        if (mime != null) resp.mimeType = mime
        return resp
      }

      override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest
      ): Boolean {
        val uri = request.url
        if (uri.host == WebViewAssetLoader.DEFAULT_DOMAIN) {
          return false
        }
        return try {
          startActivity(Intent(Intent.ACTION_VIEW, uri))
          true
        } catch (_: Exception) {
          true
        }
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?
      ): Boolean {
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = filePathCallback

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
          putExtra(
            Intent.EXTRA_MIME_TYPES,
            arrayOf("image/*", "image/heic", "image/heif", "image/avif")
          )
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return try {
          filePickerLauncher.launch(intent)
          true
        } catch (_: Exception) {
          pendingFileChooserCallback?.onReceiveValue(null)
          pendingFileChooserCallback = null
          false
        }
      }
    }

    val backCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "window.__cutlineOnBackPressed ? Boolean(window.__cutlineOnBackPressed()) : false"
        ) { result ->
          if (result != "true") {
            if (webView.canGoBack()) {
              webView.goBack()
            } else {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, backCallback)

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      val perm = Manifest.permission.WRITE_EXTERNAL_STORAGE
      if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
        legacyStorageLauncher.launch(perm)
      }
    }

    webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
  }

  override fun onResume() {
    super.onResume()
    updateManager.onHostResumed()
  }

  override fun onDestroy() {
    pendingFileChooserCallback?.onReceiveValue(null)
    pendingFileChooserCallback = null
    updateManager.shutdown()
    webView.destroy()
    super.onDestroy()
  }

  inner class AndroidBridge {
    @JavascriptInterface
    fun getInstalledVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun isAutoUpdateEnabled(): Boolean = updateManager.isAutoUpdateEnabled()

    @JavascriptInterface
    fun setAutoUpdateEnabled(enabled: Boolean) {
      updateManager.setAutoUpdateEnabled(enabled)
    }

    @JavascriptInterface
    fun checkForUpdates(manual: Boolean) {
      updateManager.checkForUpdates(manual)
    }

    @JavascriptInterface
    fun applyUpdate() {
      updateManager.applyUpdate()
    }

    @JavascriptInterface
    fun saveExportedFile(base64Data: String, fileName: String, mimeType: String): String {
      return try {
        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
        val safeName = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "CutlineStudio.pdf" }
        val mime = mimeType.ifBlank { "application/octet-stream" }

        val saved = writeToDeviceDownloads(bytes, safeName, mime)
        lastExportUri = saved.first
        lastExportMime = mime
        lastExportName = safeName

        JSONObject().apply {
          put("ok", true)
          put("path", saved.second)
        }.toString()
      } catch (e: Exception) {
        JSONObject().apply {
          put("ok", false)
          put("error", e.message ?: "Failed to save file")
        }.toString()
      }
    }

    @JavascriptInterface
    fun shareLastExport() {
      val uri = lastExportUri ?: return
      runOnUiThread {
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
          type = lastExportMime
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_TITLE, lastExportName)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, lastExportMime)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(shareIntent, "Open or share $lastExportName").apply {
          putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(viewIntent))
        }
        startActivity(chooser)
      }
    }
  }

  private fun writeToDeviceDownloads(bytes: ByteArray, fileName: String, mimeType: String): Pair<Uri, String> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, fileName)
        put(MediaStore.Downloads.MIME_TYPE, mimeType)
        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Cutline Studio")
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("Could not create file in Downloads")
      try {
        contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
          ?: throw IllegalStateException("Could not open Downloads output stream")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        contentResolver.update(uri, values, null, null)
      } catch (e: Exception) {
        contentResolver.delete(uri, null, null)
        throw e
      }
      return uri to "Downloads/Cutline Studio/$fileName"
    }

    val canWritePublic = ContextCompat.checkSelfPermission(
      this,
      Manifest.permission.WRITE_EXTERNAL_STORAGE
    ) == PackageManager.PERMISSION_GRANTED

    val dir = if (canWritePublic) {
      File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Cutline Studio")
    } else {
      File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: filesDir, "exports")
    }
    if (!dir.exists()) dir.mkdirs()

    val outFile = uniqueTargetFile(dir, fileName)
    FileOutputStream(outFile).use { it.write(bytes) }
    val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.fileprovider", outFile)
    val label = if (canWritePublic) "Downloads/Cutline Studio/${outFile.name}" else outFile.name
    return uri to label
  }

  private fun uniqueTargetFile(dir: File, name: String): File {
    val first = File(dir, name)
    if (!first.exists()) return first
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var n = 2
    while (true) {
      val candidate = File(dir, "$stem ($n)$ext")
      if (!candidate.exists()) return candidate
      n++
    }
  }
}
