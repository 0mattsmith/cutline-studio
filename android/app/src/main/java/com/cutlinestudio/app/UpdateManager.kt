package com.cutlinestudio.app

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class UpdateManager(
  private val context: Context,
  private val onStateChanged: (JSONObject) -> Unit
) {
  companion object {
    private const val PREFS_NAME = "cutline_updater"
    private const val KEY_AUTO_UPDATE = "auto_update_wifi"
    private const val GITHUB_LATEST_API = "https://api.github.com/repos/0mattsmith/cutline-studio/releases/latest"
    private const val PAGES_VERSION_URL = "https://0mattsmith.github.io/cutline-studio/version.json"
    private const val RELEASES_BASE_DOWNLOAD = "https://github.com/0mattsmith/cutline-studio/releases/download"
    private const val AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000L
  }

  data class RemoteRelease(
    val version: String,
    val versionCode: Int?,
    val notes: String,
    val apkName: String,
    val apkUrl: String,
    val apkSize: Long
  )

  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }

  @Volatile private var lastAutoCheckMs = 0L
  @Volatile private var currentStatus = "idle"
  @Volatile private var latestRelease: RemoteRelease? = null
  @Volatile private var readyApkFile: File? = null
  @Volatile private var downloadProgress = 0
  @Volatile private var errorMessage = ""
  @Volatile private var isChecking = false
  @Volatile private var isDownloading = false
  @Volatile private var pendingInstallAfterDownload = false
  @Volatile private var awaitingInstallPermission = false
  @Volatile private var pendingPermissionApk: File? = null

  init {
    cleanupOldDownloads()
  }

  fun isAutoUpdateEnabled(): Boolean = prefs.getBoolean(KEY_AUTO_UPDATE, true)

  fun setAutoUpdateEnabled(enabled: Boolean) {
    prefs.edit().putBoolean(KEY_AUTO_UPDATE, enabled).apply()
    emitState()
  }

  fun checkForUpdates(manual: Boolean) {
    val now = System.currentTimeMillis()
    if (!manual && now - lastAutoCheckMs < AUTO_CHECK_INTERVAL_MS && currentStatus != "idle") {
      emitState()
      return
    }
    if (isChecking || isDownloading) {
      emitState()
      return
    }
    lastAutoCheckMs = now
    isChecking = true
    errorMessage = ""
    currentStatus = "checking"
    emitState()

    executor.execute {
      try {
        val remote = fetchLatestRelease()
        isChecking = false
        if (remote == null) {
          currentStatus = "up_to_date"
          emitState()
          return@execute
        }

        val newerByVersion = compareSemver(remote.version, BuildConfig.VERSION_NAME) > 0
        val newerByCode = remote.versionCode != null &&
          remote.versionCode > BuildConfig.VERSION_CODE &&
          compareSemver(remote.version, BuildConfig.VERSION_NAME) >= 0

        if (!newerByVersion && !newerByCode) {
          latestRelease = null
          readyApkFile = null
          currentStatus = "up_to_date"
          emitState()
          return@execute
        }

        latestRelease = remote
        val cachedApk = File(updatesDir, remote.apkName)
        if (cachedApk.exists() && cachedApk.length() > 100_000L &&
          (remote.apkSize <= 0L || cachedApk.length() == remote.apkSize)
        ) {
          readyApkFile = cachedApk
          currentStatus = "ready"
          emitState()
          if (pendingInstallAfterDownload) {
            pendingInstallAfterDownload = false
            mainHandler.post { launchInstaller(cachedApk) }
          }
          return@execute
        }

        val shouldAutoDownload = isAutoUpdateEnabled() && isUnmeteredNetwork()
        if (shouldAutoDownload || pendingInstallAfterDownload) {
          downloadReleaseSync(remote)
        } else {
          currentStatus = "available"
          emitState()
        }
      } catch (e: Exception) {
        isChecking = false
        isDownloading = false
        pendingInstallAfterDownload = false
        if (manual) {
          val msg = e.message.orEmpty()
          if (msg.contains("404")) {
            latestRelease = null
            readyApkFile = null
            currentStatus = "up_to_date"
            errorMessage = ""
          } else {
            currentStatus = "error"
            errorMessage = msg.ifBlank { "Could not reach GitHub for updates." }
          }
        } else {
          currentStatus = "idle"
          errorMessage = ""
        }
        emitState()
      }
    }
  }

  fun applyUpdate() {
    val ready = readyApkFile
    if (ready != null && ready.exists()) {
      launchInstaller(ready)
      return
    }
    val release = latestRelease
    if (release != null) {
      pendingInstallAfterDownload = true
      if (!isDownloading) {
        executor.execute {
          try {
            downloadReleaseSync(release)
          } catch (e: Exception) {
            isDownloading = false
            pendingInstallAfterDownload = false
            currentStatus = "error"
            errorMessage = e.message ?: "APK download failed."
            emitState()
          }
        }
      }
      return
    }
    pendingInstallAfterDownload = true
    checkForUpdates(true)
  }

  fun onHostResumed() {
    if (awaitingInstallPermission) {
      val pending = pendingPermissionApk
      if (pending != null && pending.exists() && context.packageManager.canRequestPackageInstalls()) {
        awaitingInstallPermission = false
        pendingPermissionApk = null
        launchInstaller(pending)
      }
    }
  }

  fun shutdown() {
    executor.shutdownNow()
  }

  private fun downloadReleaseSync(release: RemoteRelease) {
    if (isDownloading) return
    isDownloading = true
    downloadProgress = 0
    currentStatus = "downloading"
    emitState()

    val partFile = File(updatesDir, "${release.apkName}.part")
    val finalFile = File(updatesDir, release.apkName)
    if (partFile.exists()) partFile.delete()

    val conn = openWithRedirects(release.apkUrl)
    try {
      val code = conn.responseCode
      if (code !in 200..299) {
        throw IllegalStateException("Download failed (HTTP $code)")
      }
      val total = conn.contentLengthLong.let { if (it > 0L) it else release.apkSize }
      var downloaded = 0L
      var lastEmit = 0L

      BufferedInputStream(conn.inputStream, 32 * 1024).use { input ->
        FileOutputStream(partFile).use { output ->
          val buf = ByteArray(32 * 1024)
          while (true) {
            val read = input.read(buf)
            if (read == -1) break
            output.write(buf, 0, read)
            downloaded += read
            val now = System.currentTimeMillis()
            if (total > 0L && now - lastEmit > 200L) {
              lastEmit = now
              downloadProgress = ((downloaded * 100L) / total).toInt().coerceIn(0, 99)
              emitState()
            }
          }
          output.flush()
        }
      }

      if (partFile.length() < 100_000L) {
        partFile.delete()
        throw IllegalStateException("Downloaded APK appears incomplete.")
      }
      if (finalFile.exists()) finalFile.delete()
      if (!partFile.renameTo(finalFile)) {
        partFile.copyTo(finalFile, overwrite = true)
        partFile.delete()
      }

      readyApkFile = finalFile
      downloadProgress = 100
      isDownloading = false
      currentStatus = "ready"
      emitState()

      if (pendingInstallAfterDownload) {
        pendingInstallAfterDownload = false
        mainHandler.post { launchInstaller(finalFile) }
      }
    } catch (e: Exception) {
      isDownloading = false
      if (partFile.exists()) partFile.delete()
      throw e
    } finally {
      conn.disconnect()
    }
  }

  private fun launchInstaller(apkFile: File) {
    if (!apkFile.exists()) {
      readyApkFile = null
      checkForUpdates(true)
      return
    }
    if (!context.packageManager.canRequestPackageInstalls()) {
      awaitingInstallPermission = true
      pendingPermissionApk = apkFile
      val permIntent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}")
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(permIntent)
      return
    }

    val apkUri = FileProvider.getUriForFile(
      context,
      "${BuildConfig.APPLICATION_ID}.fileprovider",
      apkFile
    )
    val installIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(apkUri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(installIntent)
  }

  private fun fetchLatestRelease(): RemoteRelease? {
    // 1. Primary: GitHub Releases API (only lists releases with uploaded APK assets).
    try {
      val jsonText = fetchText(GITHUB_LATEST_API, "application/vnd.github+json")
      val rel = JSONObject(jsonText)
      val tag = rel.optString("tag_name", "").trim()
      val ver = tag.removePrefix("v").removePrefix("V")
      if (ver.isNotBlank()) {
        val assets = rel.optJSONArray("assets")
        if (assets != null) {
          for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            val name = a.optString("name", "")
            if (name.endsWith(".apk", ignoreCase = true)) {
              return RemoteRelease(
                version = ver,
                versionCode = null,
                notes = rel.optString("body", "").trim().take(280),
                apkName = name,
                apkUrl = a.optString("browser_download_url"),
                apkSize = a.optLong("size", 0L)
              )
            }
          }
        }
      }
    } catch (_: Exception) {
      // Fall through to GitHub Pages version.json fallback if API rate-limited.
    }

    // 2. Fallback: GitHub Pages version.json (no API rate limit), verify APK exists via HEAD.
    val pagesText = fetchText("$PAGES_VERSION_URL?t=${System.currentTimeMillis()}", "application/json")
    val meta = JSONObject(pagesText)
    val ver = meta.optString("version", "").removePrefix("v").removePrefix("V").trim()
    if (ver.isBlank()) return null
    val prefix = meta.optString("apkAssetPrefix", "CutlineStudio-")
    val apkName = "${prefix}v${ver}.apk"
    val apkUrl = meta.optString("apkUrl", "").ifBlank {
      "$RELEASES_BASE_DOWNLOAD/v$ver/$apkName"
    }
    val headSize = verifyRemoteApkSize(apkUrl) ?: return null
    return RemoteRelease(
      version = ver,
      versionCode = if (meta.has("versionCode")) meta.optInt("versionCode") else null,
      notes = meta.optString("notes", "").trim(),
      apkName = apkName,
      apkUrl = apkUrl,
      apkSize = headSize
    )
  }

  private fun verifyRemoteApkSize(url: String): Long? {
    val conn = openWithRedirects(url, method = "HEAD")
    return try {
      if (conn.responseCode in 200..299) conn.contentLengthLong.coerceAtLeast(0L) else null
    } finally {
      conn.disconnect()
    }
  }

  private fun fetchText(urlString: String, accept: String): String {
    val conn = openWithRedirects(urlString, accept = accept)
    return try {
      val code = conn.responseCode
      if (code !in 200..299) throw IllegalStateException("HTTP $code")
      conn.inputStream.bufferedReader().use { it.readText() }
    } finally {
      conn.disconnect()
    }
  }

  private fun openWithRedirects(
    urlString: String,
    method: String = "GET",
    accept: String = "*/*"
  ): HttpURLConnection {
    var current = urlString
    repeat(6) {
      val conn = (URL(current).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        instanceFollowRedirects = false
        connectTimeout = 15_000
        readTimeout = 30_000
        setRequestProperty("User-Agent", "CutlineStudio-Android/${BuildConfig.VERSION_NAME}")
        setRequestProperty("Accept", accept)
      }
      val code = conn.responseCode
      if (code in listOf(301, 302, 303, 307, 308)) {
        val location = conn.getHeaderField("Location")
        conn.disconnect()
        if (location.isNullOrBlank()) throw IllegalStateException("Empty redirect location")
        current = URL(URL(current), location).toString()
      } else {
        return conn
      }
    }
    throw IllegalStateException("Too many redirects")
  }

  private fun isUnmeteredNetwork(): Boolean {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val network = cm.activeNetwork ?: return false
    val caps = cm.getNetworkCapabilities(network) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
  }

  private fun cleanupOldDownloads() {
    val currentFile = "CutlineStudio-v${BuildConfig.VERSION_NAME}.apk"
    updatesDir.listFiles()?.forEach { f ->
      if (f.name.endsWith(".part") || (f.name.endsWith(".apk") && f.name == currentFile)) {
        f.delete()
      }
    }
  }

  private fun compareSemver(a: String, b: String): Int {
    val pa = a.removePrefix("v").removePrefix("V").split(".").map { it.toIntOrNull() ?: 0 }
    val pb = b.removePrefix("v").removePrefix("V").split(".").map { it.toIntOrNull() ?: 0 }
    val max = maxOf(pa.size, pb.size)
    for (i in 0 until max) {
      val da = pa.getOrElse(i) { 0 }
      val db = pb.getOrElse(i) { 0 }
      if (da > db) return 1
      if (da < db) return -1
    }
    return 0
  }

  private fun emitState() {
    val payload = JSONObject().apply {
      put("status", currentStatus)
      put("currentVersion", BuildConfig.VERSION_NAME)
      put("latestVersion", latestRelease?.version ?: JSONObject.NULL)
      put("notes", if (currentStatus == "error") errorMessage else (latestRelease?.notes ?: ""))
      put("progress", downloadProgress)
      put("autoDownload", isAutoUpdateEnabled())
    }
    mainHandler.post { onStateChanged(payload) }
  }
}
