package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.kurisuassistant.android.silerovad.SileroVadOnnxModel
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.AvatarManager
import com.google.android.material.appbar.MaterialToolbar


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
    private val viewModel: ChatViewModel by viewModels()
    private lateinit var adapter: ChatAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        AvatarManager.init(this)
        Util.checkPermissions(this)

        val recyclerView = findViewById<RecyclerView>(R.id.recyclerView)
        adapter = ChatAdapter(this, viewModel.messages.value ?: emptyList())
        recyclerView.adapter = adapter
        recyclerView.layoutManager = LinearLayoutManager(this)

        val editText = findViewById<EditText>(R.id.editTextMessage)
        val sendButton = findViewById<ImageButton>(R.id.buttonSend)
        val recordButton = findViewById<ImageButton>(R.id.buttonRecord)
        val recordIndicator = findViewById<TextView>(R.id.recordIndicator)
        val typingIndicator = findViewById<TextView>(R.id.typingIndicator)
        val speakingIndicator = findViewById<TextView>(R.id.speakingIndicator)
        val connectionIndicator = findViewById<ImageView>(R.id.connectionIndicator)
        var isRecording = false

        viewModel.messages.observe(this) {
            adapter.update(it)
            recyclerView.scrollToPosition(adapter.itemCount - 1)
        }

        viewModel.connected.observe(this) { connected ->
            val res = if (connected) android.R.drawable.presence_online
            else android.R.drawable.presence_offline
            connectionIndicator.setImageResource(res)
        }

        viewModel.typing.observe(this) { typing ->
            typingIndicator.visibility = if (typing) View.VISIBLE else View.GONE
        }

        viewModel.speaking.observe(this) { speaking ->
            speakingIndicator.visibility = if (speaking) View.VISIBLE else View.GONE
        }

        sendButton.setOnClickListener {
            val text = editText.text.toString().trim()
            if (text.isNotEmpty()) {
                viewModel.sendMessage(text)
                editText.text.clear()
            }
        }

        recordButton.setOnClickListener {
            if (isRecording) {
                stopRecordingService()
                recordIndicator.visibility = View.GONE
            } else {
                startRecordingService()
                recordIndicator.visibility = View.VISIBLE
            }
            isRecording = !isRecording
        }
    }

    private fun startRecordingService() {
        val intent = Intent(this, RecordingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        Log.d(TAG, "RecordingService spawned")
        Toast.makeText(this, "Recording started", Toast.LENGTH_SHORT).show()
    }

    private fun stopRecordingService() {
        val intent = Intent(this, RecordingService::class.java)
        stopService(intent)
        Log.d(TAG, "RecordingService stopped")
        Toast.makeText(this, "Recording stopped", Toast.LENGTH_SHORT).show()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return if (item.itemId == R.id.action_settings) {
            startActivity(Intent(this, SettingsActivity::class.java))
            true
        } else super.onOptionsItemSelected(item)
    }
}