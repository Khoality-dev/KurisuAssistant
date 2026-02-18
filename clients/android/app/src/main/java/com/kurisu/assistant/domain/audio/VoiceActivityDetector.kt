package com.kurisu.assistant.domain.audio

import android.content.Context
import android.util.Log
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import dagger.hilt.android.qualifiers.ApplicationContext
import java.nio.LongBuffer
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Silero VAD using ONNX Runtime.
 * Based on the working SileroVadOnnxModel.java implementation.
 * Processes 512-sample (32ms @ 16kHz) audio chunks and returns speech probability.
 *
 * The model expects input with a 64-sample context prepended, so the actual
 * input tensor shape is [1, 576] (64 context + 512 new samples).
 */
@Singleton
class VoiceActivityDetector @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "VoiceActivityDetector"
        private const val MODEL_FILE = "silero_vad.onnx"
        private const val SAMPLE_RATE = 16000L
        private const val WINDOW_SIZE = 512
        private const val CONTEXT_SIZE = 64 // at 16kHz
        private const val THRESHOLD = 0.5f
    }

    private var ortEnv: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var isInitialized = false

    // LSTM state: shape [2, 1, 128] = 256 floats
    private var state = Array(2) { Array(1) { FloatArray(128) } }

    // Rolling context window (last 64 samples from previous call)
    private var contextBuffer = FloatArray(CONTEXT_SIZE)

    var lastMaxInput: Float = 0f
        private set

    fun initialize(): Boolean {
        if (isInitialized) return true
        return try {
            ortEnv = OrtEnvironment.getEnvironment()
            val modelBytes = context.assets.open(MODEL_FILE).readBytes()
            val opts = OrtSession.SessionOptions().apply {
                setInterOpNumThreads(1)
                setIntraOpNumThreads(1)
                addCPU(true)
            }
            session = ortEnv!!.createSession(modelBytes, opts)
            resetState()
            isInitialized = true
            Log.d(TAG, "Silero VAD initialized — inputs: ${session!!.inputNames}, outputs: ${session!!.outputNames}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Silero VAD: ${e.message}")
            false
        }
    }

    fun processSamples(samples: ShortArray): Float {
        if (!isInitialized || session == null) return 0f

        val env = ortEnv ?: return 0f
        val sess = session ?: return 0f

        // Convert shorts to floats normalized to [-1, 1]
        val floatSamples = FloatArray(WINDOW_SIZE)
        for (i in 0 until minOf(samples.size, WINDOW_SIZE)) {
            floatSamples[i] = samples[i].toFloat() / 32767f
        }
        lastMaxInput = floatSamples.max()

        return try {
            // Prepend context to input: [context(64) + samples(512)] = [576]
            val inputWithContext = FloatArray(CONTEXT_SIZE + WINDOW_SIZE)
            System.arraycopy(contextBuffer, 0, inputWithContext, 0, CONTEXT_SIZE)
            System.arraycopy(floatSamples, 0, inputWithContext, CONTEXT_SIZE, WINDOW_SIZE)

            // Update context with last 64 samples for next call
            System.arraycopy(floatSamples, WINDOW_SIZE - CONTEXT_SIZE, contextBuffer, 0, CONTEXT_SIZE)

            // input: [1, 576]
            val inputTensor = OnnxTensor.createTensor(
                env, arrayOf(inputWithContext),
            )
            // state: [2, 1, 128]
            val stateTensor = OnnxTensor.createTensor(env, state)
            // sr: long[1] = {16000}
            val srTensor = OnnxTensor.createTensor(
                env, LongBuffer.wrap(longArrayOf(SAMPLE_RATE)), longArrayOf(1),
            )

            val inputs = mapOf(
                "input" to inputTensor,
                "state" to stateTensor,
                "sr" to srTensor,
            )

            val results = sess.run(inputs)

            // Extract probability: output shape [1, 1]
            val probArr = results[0].value
            val probability = when (probArr) {
                is Array<*> -> {
                    @Suppress("UNCHECKED_CAST")
                    (probArr as Array<FloatArray>)[0][0]
                }
                is FloatArray -> probArr[0]
                else -> 0f
            }

            // Read updated LSTM state
            val stateOut = results[1].value
            if (stateOut is Array<*>) {
                @Suppress("UNCHECKED_CAST")
                state = stateOut as Array<Array<FloatArray>>
            }

            inputTensor.close()
            stateTensor.close()
            srTensor.close()
            results.close()

            probability
        } catch (e: Exception) {
            Log.e(TAG, "VAD inference error: ${e.message}", e)
            0f
        }
    }

    fun isSpeech(probability: Float): Boolean = probability > THRESHOLD

    fun resetState() {
        state = Array(2) { Array(1) { FloatArray(128) } }
        contextBuffer = FloatArray(CONTEXT_SIZE)
    }

    fun release() {
        session?.close()
        ortEnv?.close()
        session = null
        ortEnv = null
        isInitialized = false
    }
}
