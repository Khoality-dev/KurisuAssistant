package com.kurisu.assistant.data.repository

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.util.Base64
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import dagger.hilt.android.qualifiers.ApplicationContext
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class VisionRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val wsManager: WebSocketManager,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var isActive = false
    private var lastFrameTime = 0L
    private val frameIntervalMs = 333L // ~3 FPS

    val imageAnalyzer = ImageAnalysis.Analyzer { imageProxy ->
        if (!isActive) {
            imageProxy.close()
            return@Analyzer
        }

        val now = System.currentTimeMillis()
        if (now - lastFrameTime < frameIntervalMs) {
            imageProxy.close()
            return@Analyzer
        }
        lastFrameTime = now

        scope.launch {
            try {
                val base64 = imageProxyToBase64Jpeg(imageProxy)
                if (base64 != null) {
                    wsManager.sendVisionFrame(base64)
                }
            } catch (_: Exception) {
            } finally {
                imageProxy.close()
            }
        }
    }

    suspend fun startVision() {
        isActive = true
        wsManager.sendVisionStart()
    }

    fun stopVision() {
        isActive = false
        wsManager.sendVisionStop()
    }

    fun release() {
        stopVision()
        scope.cancel()
    }

    private fun imageProxyToBase64Jpeg(imageProxy: ImageProxy): String? {
        val yBuffer = imageProxy.planes[0].buffer
        val uBuffer = imageProxy.planes[1].buffer
        val vBuffer = imageProxy.planes[2].buffer

        val ySize = yBuffer.remaining()
        val uSize = uBuffer.remaining()
        val vSize = vBuffer.remaining()

        val nv21 = ByteArray(ySize + uSize + vSize)
        yBuffer.get(nv21, 0, ySize)
        vBuffer.get(nv21, ySize, vSize)
        uBuffer.get(nv21, ySize + vSize, uSize)

        val yuvImage = YuvImage(nv21, ImageFormat.NV21, imageProxy.width, imageProxy.height, null)
        val out = ByteArrayOutputStream()
        yuvImage.compressToJpeg(Rect(0, 0, imageProxy.width, imageProxy.height), 70, out)
        val jpegBytes = out.toByteArray()

        return Base64.encodeToString(jpegBytes, Base64.NO_WRAP)
    }
}
