package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.kurisuassistant.android.silerovad.SileroVadOnnxModel
import com.kurisuassistant.android.utils.Util
import java.nio.ByteBuffer
import java.nio.ByteOrder

class MainActivity : AppCompatActivity() {
    companion object {
        private const val REQUEST_RECORD_AUDIO = 1001
        private const val TAG = "MainActivity"
    }
    val SAMPLE_RATE: Int = 16000
    val THRESHOLD: Float = 0.5f
    val MIN_SPEECH_DURATION_MS: Int = 250
    val MAX_SPEECH_DURATION_SECONDS: Float = Float.POSITIVE_INFINITY
    val MIN_SILENCE_DURATION_MS: Int = 100
    val SPEECH_PAD_MS: Int = 30
    lateinit var vadModel: SileroVadOnnxModel
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        Util.checkPermissions(this)
        val modelBytes  = resources.openRawResource(R.raw.silero_vad).readBytes()
        val modelBuffer: ByteBuffer = ByteBuffer
            .allocateDirect(modelBytes.size)
            .order(ByteOrder.nativeOrder())
            .put(modelBytes)
            .apply { flip() }
        vadModel =
            SileroVadOnnxModel(modelBuffer)

        val audioData: Array<FloatArray> = arrayOf(
            FloatArray(512)
        )
        val result = vadModel.call(audioData, SAMPLE_RATE)
        val textView : TextView = findViewById(R.id.main_text)
        val printOutResult = "My result: " + result[0].toString()
        textView.text = printOutResult
        Toast.makeText(this, printOutResult, Toast.LENGTH_SHORT).show()
        startRecordingService()
        Log.d(TAG, "Start Activity")
    }

    private fun startRecordingService() {
        val intent = Intent(this, RecordingService::class.java)
        ContextCompat.startForegroundService(this, intent)  // start service :contentReference[oaicite:9]{index=9}
        Log.d(TAG, "RecordingService spawned")             // debug log :contentReference[oaicite:10]{index=10}
        Toast.makeText(this, "RecordingService spawned", Toast.LENGTH_SHORT).show()
    }
}