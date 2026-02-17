package com.kurisu.assistant.ui.character

import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import com.kurisu.assistant.domain.character.CharacterCompositor
import com.kurisu.assistant.domain.character.LoadedPatch

@Composable
fun CharacterCanvas(
    compositor: CharacterCompositor,
    modifier: Modifier = Modifier,
) {
    var lastFrameTimeNanos by remember { mutableLongStateOf(0L) }
    var tick by remember { mutableIntStateOf(0) }

    // 60fps animation loop
    LaunchedEffect(Unit) {
        while (true) {
            withFrameNanos { frameTimeNanos ->
                if (lastFrameTimeNanos != 0L) {
                    val dt = (frameTimeNanos - lastFrameTimeNanos) / 1_000_000f // ms
                    compositor.update(dt)
                }
                lastFrameTimeNanos = frameTimeNanos
                tick++ // triggers recomposition
            }
        }
    }

    // Read tick to trigger redraws
    val currentTick = tick

    Canvas(modifier = modifier) {
        val pose = compositor.pose ?: return@Canvas
        val canvasWidth = size.width
        val canvasHeight = size.height

        drawIntoCanvas { canvas ->
            val nativeCanvas = canvas.nativeCanvas
            nativeCanvas.save()

            // Uniform scale to preserve aspect ratio (objectFit: contain)
            val scale = minOf(
                canvasWidth / pose.baseImage.width,
                canvasHeight / pose.baseImage.height,
            )
            val scaledW = pose.baseImage.width * scale
            val scaledH = pose.baseImage.height * scale
            val offsetX = (canvasWidth - scaledW) / 2f
            val offsetY = (canvasHeight - scaledH) / 2f

            nativeCanvas.translate(offsetX, offsetY)

            // Breathing offset
            val breathingOffsetY = compositor.getBreathingOffsetY(scale)
            nativeCanvas.translate(0f, breathingOffsetY)

            val paint = Paint().apply { isAntiAlias = true }

            // Crossfade alpha
            if (compositor.crossfadeProgress < 1f) {
                paint.alpha = (compositor.crossfadeProgress * 255).toInt()
            }

            // Draw base image
            val dstRect = RectF(0f, 0f, scaledW, scaledH)
            nativeCanvas.drawBitmap(
                pose.baseImage,
                Rect(0, 0, pose.baseImage.width, pose.baseImage.height),
                dstRect,
                paint,
            )

            // Draw left eye patch
            val leftIdx = compositor.getLeftEyeIndex()
            if (leftIdx > 0 && leftIdx <= pose.leftEyePatches.size) {
                drawPatch(nativeCanvas, pose.leftEyePatches[leftIdx - 1], scale, scale, paint)
            }

            // Draw right eye patch
            val rightIdx = compositor.getRightEyeIndex()
            if (rightIdx > 0 && rightIdx <= pose.rightEyePatches.size) {
                drawPatch(nativeCanvas, pose.rightEyePatches[rightIdx - 1], scale, scale, paint)
            }

            // Draw mouth patch
            val mouthState = compositor.getMouthState()
            if (mouthState > 0 && mouthState <= pose.mouthPatches.size) {
                drawPatch(nativeCanvas, pose.mouthPatches[mouthState - 1], scale, scale, paint)
            }

            nativeCanvas.restore()
        }
    }
}

private fun drawPatch(
    canvas: android.graphics.Canvas,
    patch: LoadedPatch,
    scaleX: Float,
    scaleY: Float,
    paint: Paint,
) {
    val dst = RectF(
        patch.x * scaleX,
        patch.y * scaleY,
        (patch.x + patch.width) * scaleX,
        (patch.y + patch.height) * scaleY,
    )
    canvas.drawBitmap(
        patch.bitmap,
        Rect(0, 0, patch.bitmap.width, patch.bitmap.height),
        dst,
        paint,
    )
}
