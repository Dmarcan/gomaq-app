import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Llave de firma de la version publicada: la lee de android/key.properties (no se sube al repo; ver
// key.properties.example). Sin ese archivo el APK release se firma con la clave de depuracion, que sirve
// para probar pero no para publicar.
val propiedadesFirma = Properties().apply {
    val archivo = rootProject.file("key.properties")
    if (archivo.exists()) archivo.inputStream().use { load(it) }
}
val hayFirmaRelease = propiedadesFirma.getProperty("storeFile") != null

android {
    namespace = "cl.gomaq.gomaq_mecanico"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "cl.gomaq.gomaq_mecanico"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hayFirmaRelease) {
            create("release") {
                keyAlias = propiedadesFirma.getProperty("keyAlias")
                keyPassword = propiedadesFirma.getProperty("keyPassword")
                storeFile = rootProject.file(propiedadesFirma.getProperty("storeFile"))
                storePassword = propiedadesFirma.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            // Con key.properties se firma con la llave propia; sin el, con la de depuración.
            signingConfig = signingConfigs.getByName(if (hayFirmaRelease) "release" else "debug")
        }
    }
}

flutter {
    source = "../.."
}
