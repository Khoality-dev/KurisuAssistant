# Kotlin Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.kurisu.assistant.**$$serializer { *; }
-keepclassmembers class com.kurisu.assistant.** { *** Companion; }
-keepclasseswithmembers class com.kurisu.assistant.** { kotlinx.serialization.KSerializer serializer(...); }

# ONNX Runtime
-keep class ai.onnxruntime.** { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

# Retrofit
-keepattributes Signature
-keepattributes Exceptions
