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

# ----- libsignal -----------------------------------------------------------
# Everything under org.signal.libsignal is touched by JNI from native code.
# The native side resolves Java classes/methods by name via reflection.
-keep class org.signal.libsignal.** { *; }
-keepclassmembers class org.signal.libsignal.** {
    native <methods>;
}
-dontwarn org.signal.libsignal.**

# ----- Google protobuf-java (full runtime) ---------------------------------
# Proto descriptors are loaded reflectively; keep generated message classes.
-keep class com.google.protobuf.** { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageV3 { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite { *; }
-dontwarn com.google.protobuf.**

# ----- ObscuraKit ----------------------------------------------------------
# The kit exposes a small Kotlin/SQLDelight API; keep its public surface so
# the bridge (which goes through reflection in some places) and our own
# Kotlin call sites continue to resolve after R8 renames.
-keep class dev.barrelmaker.obscura.kit.** { *; }
-keepclassmembers class dev.barrelmaker.obscura.kit.** { *; }
-dontwarn dev.barrelmaker.obscura.kit.**

# ----- SQLDelight + sqlite ------------------------------------------------
-dontwarn app.cash.sqldelight.**

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

# ----- Rust core spike (obscura-core over UniFFI + JNA) ---------------------
# Inert unless -PobscuraRustCore packages the core into a release build.
# libjnidispatch looks JNA classes up by name (Structure, CallbackReference, ...),
# and JNA lays out Structures from @FieldOrder strings that must still match the
# field names, so neither JNA nor the generated bindings may be renamed. The JNA
# AAR ships no consumer rules; its desktop-only java.awt references never run.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class uniffi.obscura_core.** { *; }
-dontwarn java.awt.**
