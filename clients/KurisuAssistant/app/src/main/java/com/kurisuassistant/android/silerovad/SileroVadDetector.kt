package com.kurisuassistant.android.silerovad;

import ai.onnxruntime.OrtException;
import java.lang.System.*
import java.nio.ByteBuffer
import java.util.Calendar.getInstance

class SileroVadDetector(modelBuffer: ByteBuffer) {
    private val model : SileroVadOnnxModel = SileroVadOnnxModel(modelBuffer)
    private val threshold = 0.5f
    private val samplingRate = 16000
    private val windowSizeSample = 512
    // Wait time after the user stops speaking before firing an event
    // Reduced to 0.5 seconds for faster response
    private var minSilenceMsDuration = 500 // 0.5s
    private var lastDetectedTimeStamp: Long = 0
    var isSpeaking = false
    /**
     * Method to reset the state
     */
    fun reset() {
        model.resetStates();
        isSpeaking = false
        lastDetectedTimeStamp = 0
    }

    fun call(audioFloatArray: FloatArray): Int {
        val predictionScore = model.call(arrayOf(audioFloatArray), samplingRate)[0]

        var returnResult = 0
        if (predictionScore >= threshold)
        {
            lastDetectedTimeStamp = currentTimeMillis()
            if (!isSpeaking)
            {
                isSpeaking = true
                returnResult = 1
            }
        }
        else if (isSpeaking && currentTimeMillis() - lastDetectedTimeStamp >= minSilenceMsDuration)
        {
            returnResult = 2
            reset()
        }
        return returnResult
    }
}
