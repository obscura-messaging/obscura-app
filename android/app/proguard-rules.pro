# AGP 9 only accepts proguard-android-optimize.txt. Until release builds are
# verified on devices with R8 optimization on, keep the shrink-only behavior
# the old proguard-android.txt gave.
-dontoptimize

# ---------------------------------------------------------------------------
# Obscura Android R8 / ProGuard rules.
#
# React Native, AndroidX, OkHttp, Hermes, etc. ship their own consumer rules
# through the AAR pipeline — we only declare what's *not* already covered.
# ---------------------------------------------------------------------------

# ----- JNA + UniFFI (obscura-core) -----------------------------------------
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-dontwarn java.awt.**
-keep class uniffi.** { *; }

# ----- Our own bridge -----------------------------------------------------
# RN looks up ReactPackage / ReactModule classes by name. Keep them, their
# @ReactMethod handlers, and the Session singleton (called from native FCM
# service via reflection of Kotlin object companions).
-keep class dev.barrelmaker.obscura.ObscuraSession { *; }
-keep class dev.barrelmaker.obscura.ObscuraSession$* { *; }
-keep class dev.barrelmaker.obscura.ObscuraBridgeModule { *; }
-keep class dev.barrelmaker.obscura.ObscuraBridgePackage { *; }
-keep class dev.barrelmaker.obscura.ObscuraMessagingService { *; }
-keep class dev.barrelmaker.obscura.MainApplication { *; }
-keep class dev.barrelmaker.obscura.MainActivity { *; }

# Kotlin metadata is needed for the kit's coroutine continuations to be
# preserved across the suspend-bridge boundary.
-keep class kotlin.Metadata { *; }
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault

# ----- Quality-of-life ----------------------------------------------------
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn org.slf4j.**
-dontwarn java.sql.**
