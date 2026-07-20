plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tauri.barcodescanner"
    compileSdk = 36

    defaultConfig {
        minSdk = 24

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    val camerax_version = "1.5.1"
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    implementation("androidx.camera:camera-core:${camerax_version}")
    implementation("androidx.camera:camera-camera2:${camerax_version}")
    implementation("androidx.camera:camera-lifecycle:${camerax_version}")
    implementation("androidx.camera:camera-view:${camerax_version}")
    // PATCHED vs upstream 2.4.5 (which used com.google.android.gms:play-services-mlkit-barcode-scanning,
    // the "thin" ML Kit that loads the recognition model through Google Play Services at runtime).
    // Switched to the bundled `com.google.mlkit:barcode-scanning` so the scanner works on devices WITHOUT
    // Google Play Services (Huawei / HarmonyOS — the domestic target), where the GMS variant cannot load
    // the model and scan() rejects with "Something went wrong configuring the BarcodeScanner". Identical
    // public API (com.google.mlkit.vision.barcode.*), so the Kotlin is unchanged. Cost: ~3MB larger APK
    // for the model bundled offline. See src-tauri/Cargo.toml [patch.crates-io] for the fork pointer.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    implementation(project(":tauri-android"))
}
