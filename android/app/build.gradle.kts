import groovy.json.JsonSlurper
import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
}

@Suppress("UNCHECKED_CAST")
val versionMeta = JsonSlurper().parse(rootProject.file("../version.json")) as Map<String, Any>
val appVersionName = versionMeta["version"].toString()
val appVersionCode = (versionMeta["versionCode"] as Number).toInt()

val keystoreProps = Properties().apply {
  val f = rootProject.file("keystore.properties")
  if (f.exists()) f.inputStream().use { load(it) }
}

fun signingProp(propKey: String, envKey: String): String? {
  return keystoreProps.getProperty(propKey)?.takeIf { it.isNotBlank() }
    ?: System.getenv(envKey)?.takeIf { it.isNotBlank() }
}

val releaseKeystorePath = signingProp("storeFile", "ANDROID_KEYSTORE_PATH")
val releaseKeystorePass = signingProp("storePassword", "ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingProp("keyAlias", "ANDROID_KEY_ALIAS")
val releaseKeyPass = signingProp("keyPassword", "ANDROID_KEY_PASSWORD")
val hasReleaseSigning = releaseKeystorePath != null &&
  releaseKeystorePass != null &&
  releaseKeyAlias != null &&
  releaseKeyPass != null

android {
  namespace = "com.cutlinestudio.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.cutlinestudio.app"
    minSdk = 26
    targetSdk = 35
    versionCode = appVersionCode
    versionName = appVersionName
  }

  signingConfigs {
    if (hasReleaseSigning) {
      create("release") {
        storeFile = rootProject.file(releaseKeystorePath!!)
        storePassword = releaseKeystorePass
        keyAlias = releaseKeyAlias
        keyPassword = releaseKeyPass
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (hasReleaseSigning) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = true
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

kotlin {
  jvmToolchain(17)
}

val syncWebAssets by tasks.registering(Sync::class) {
  from(rootProject.projectDir.parentFile) {
    include(
      "index.html",
      "styles.css",
      "app.js",
      "layout.js",
      "borders.js",
      "image-worker.js",
      "version.json",
      "manifest.webmanifest",
      "icon*.png",
      "icon*.svg",
      "apple-touch-icon.png",
      "vendor/**"
    )
  }
  into(layout.projectDirectory.dir("src/main/assets/web"))
}

tasks.named("preBuild") {
  dependsOn(syncWebAssets)
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.androidx.webkit)
  testImplementation(libs.junit)
}
