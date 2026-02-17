package com.kurisu.assistant.domain.voice

import android.content.Context
import android.util.Log
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import dagger.hilt.android.qualifiers.ApplicationContext
import java.nio.FloatBuffer
import java.nio.LongBuffer
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Silero VAD using ONNX Runtime.
 * Processes 512-sample (32ms @ 16kHz) audio chunks and returns speech probability.
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
        private const val THRESHOLD = 0.5f
    }

    private var ortEnv: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var state: FloatArray = FloatArray(2 * 1 * 128) // [2, 1, 128]
    private var isInitialized = false

    fun initialize(): Boolean {
        if (isInitialized) return true
        return try {
            ortEnv = OrtEnvironment.getEnvironment()
            val modelBytes = context.assets.open(MODEL_FILE).readBytes()
            session = ortEnv!!.createSession(modelBytes)
            state = FloatArray(2 * 1 * 128)
            isInitialized = true
            Log.d(TAG, "Silero VAD initialized successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Silero VAD: ${e.message}")
            false
        }
    }

    /**
     * Process a 512-sample audio chunk and return speech probability (0.0 - 1.0).
     */
    fun processSamples(samples: ShortArray): Float {
        if (!isInitialized || session == null) return 0f

        val env = ortEnv ?: return 0f
        val sess = session ?: return 0f

        // Convert shorts to floats
        val floatSamples = FloatArray(WINDOW_SIZE)
        for (i in 0 until minOf(samples.size, WINDOW_SIZE)) {
            floatSamples[i] = samples[i].toFloat() / 32768f
        }

        return try {
            // Input tensor: [1, window_size]
            val inputBuffer = FloatBuffer.wrap(floatSamples)
            val inputTensor = OnnxTensor.createTensor(env, inputBuffer, longArrayOf(1, WINDOW_SIZE.toLong()))

            // State tensor: [2, 1, 128]
            val stateBuffer = FloatBuffer.wrap(state.copyOf())
            val stateTensor = OnnxTensor.createTensor(env, stateBuffer, longArrayOf(2, 1, 128))

            // Sample rate tensor: scalar int64
            val srTensor = OnnxTensor.createTensor(env, SAMPLE_RATE)

            val inputs = mapOf(
                "input" to inputTensor,
                "state" to stateTensor,
                "sr" to srTensor,
            )

            val results = sess.run(inputs)

            // Output probability: [1, 1]
            val outputTensor = results[0].value
            val probability = when (outputTensor) {
                is FloatArray -> outputTensor[0]
                is Array<*> -> {
                    @Suppress("UNCHECKED_CAST")
                    val arr = outputTensor as Array<FloatArray>
                    arr[0][0]
                }
                else -> 0f
            }

            // Update state from stateN output: [2, 1, 128]
            if (results.size() > 1) {
                val stateOut = results[1].value
                if (stateOut is Array<*>) {
                    @Suppress("UNCHECKED_CAST")
                    val stateArr = stateOut as Array<Array<FloatArray>>
                    var idx = 0
                    for (layer in stateArr) {
                        for (batch in layer) {
                            System.arraycopy(batch, 0, state, idx, batch.size)
                            idx += batch.size
                        }
                    }
                }
            }

            // Clean up
            inputTensor.close()
            stateTensor.close()
            srTensor.close()
            results.close()

            probability
        } catch (e: Exception) {
            Log.e(TAG, "VAD inference error: ${e.message}")
            0f
        }
    }

    fun isSpeech(probability: Float): Boolean = probability > THRESHOLD

    fun resetState() {
        state = FloatArray(2 * 1 * 128)
    }

    fun release() {
        session?.close()
        ortEnv?.close()
        session = null
        ortEnv = null
        isInitialized = false
    }
}
