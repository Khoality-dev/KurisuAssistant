package com.kurisu.assistant.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.kurisu.assistant.MainActivity
import com.kurisu.assistant.R
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.AsrRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.domain.audio.AudioRecorder
import com.kurisu.assistant.domain.audio.VoiceActivityDetector
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import javax.inject.Inject

@AndroidEntryPoint
class CoreService : Service() {

    companion object {
        private const val TAG = "CoreService"
        private const val CHANNEL_ID = "kurisu_chat_channel"
        private const val NOTIFICATION_ID = 1
        private const val SILENCE_TIMEOUT_MS = 1500L
        const val ACTION_STOP = "com.kurisu.assistant.ACTION_STOP_SERVICE"

        fun start(context: Context) {
            val intent = Intent(context, CoreService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CoreService::class.java))
        }
    }

    @Inject lateinit var wsManager: WebSocketManager
    @Inject lateinit var streamProcessor: ChatStreamProcessor
    @Inject lateinit var ttsQueueManager: TtsQueueManager
    @Inject lateinit var voiceInteractionManager: VoiceInteractionManager
    @Inject lateinit var agentRepository: AgentRepository
    @Inject lateinit var conversationRepository: ConversationRepository
    @Inject lateinit var asrRepository: AsrRepository
    @Inject lateinit var prefs: PreferencesDataStore
    @Inject lateinit var coreState: CoreState
    @Inject lateinit var audioRecorder: AudioRecorder
    @Inject lateinit var vad: VoiceActivityDetector

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private var vadJob: Job? = null
    private var silenceTimerJob: Job? = null
    private var isSpeaking = false

    inner class LocalBinder : Binder() {
        val service: CoreService get() = this@CoreService
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        wireCallbacks()
        streamProcessor.startCollecting()
        coreState.setServiceRunning(true)

        // Connect WebSocket
        serviceScope.launch {
            try { wsManager.connect() } catch (e: Exception) {
                Log.e(TAG, "WebSocket connect failed: ${e.message}")
            }
        }

        // Initialize VAD and start recording + VAD loop
        serviceScope.launch {
            audioRecorder.preferredDeviceType = prefs.getAudioInputDeviceType()
            startRecordingAndVad()
        }

        Log.d(TAG, "Service started")
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "Service stopping")
        stopRecordingAndVad()
        unwireCallbacks()
        streamProcessor.stopCollecting()
        coreState.setServiceRunning(false)
        coreState.setRecording(false)
        serviceScope.cancel()
        super.onDestroy()
    }

    // ── Recording & VAD ──────────────────────────────────────────────

    private fun startRecordingAndVad() {
        if (!vad.initialize()) {
            Log.e(TAG, "Failed to initialize VAD")
            return
        }

        val started = audioRecorder.start()
        if (!started) {
            Log.e(TAG, "AudioRecorder failed to start")
            return
        }

        coreState.setRecording(true)
        Log.d(TAG, "Recording started, collecting audio chunks for VAD")

        vadJob = serviceScope.launch(Dispatchers.IO) {
            var chunkCount = 0
            audioRecorder.audioChunks.collect { chunk ->
                chunkCount++
                if (chunkCount == 1) {
                    Log.d(TAG, "VAD first chunk: size=${chunk.size} samples")
                }
                val probability = vad.processSamples(chunk)
                val isSpeechDetected = vad.isSpeech(probability)

                // Log periodically + any chunk with elevated probability
                if (chunkCount % 100 == 0 || probability > 0.01f) {
                    var sum = 0.0
                    for (s in chunk) { sum += s.toDouble() * s.toDouble() }
                    val rms = kotlin.math.sqrt(sum / chunk.size)
                    Log.d(TAG, "VAD #$chunkCount prob=${String.format("%.4f", probability)} rms=${String.format("%.0f", rms)} maxIn=${String.format("%.4f", vad.lastMaxInput)}")
                }

                if (isSpeechDetected) {
                    if (!isSpeaking) {
                        Log.d(TAG, "Speech started at chunk #$chunkCount")
                    }
                    isSpeaking = true
                    silenceTimerJob?.cancel()
                    silenceTimerJob = null
                } else if (isSpeaking && silenceTimerJob == null) {
                    Log.d(TAG, "Speech ended, starting silence timer (${SILENCE_TIMEOUT_MS}ms)")
                    silenceTimerJob = launch {
                        delay(SILENCE_TIMEOUT_MS)
                        // Launch ASR in serviceScope so it survives silenceTimerJob cancellation
                        serviceScope.launch(Dispatchers.IO) { processCurrentRecording() }
                    }
                }
            }
        }
    }

    private fun stopRecordingAndVad() {
        vadJob?.cancel()
        silenceTimerJob?.cancel()
        isSpeaking = false

        if (audioRecorder.isRecording) {
            audioRecorder.stop()
        }

        coreState.setRecording(false)
    }

    private suspend fun processCurrentRecording() {
        coreState.setProcessingAsr(true)
        isSpeaking = false

        try {
            val pcmBytes = audioRecorder.takeAccumulatedPcm()
            Log.d(TAG, "Took PCM snapshot: ${pcmBytes.size} bytes (${pcmBytes.size / 2} samples, ${String.format("%.1f", pcmBytes.size / 2 / 16000.0)}s)")

            if (pcmBytes.isEmpty()) {
                Log.w(TAG, "Empty recording, skipping ASR")
            } else {
                val text = asrRepository.transcribe(pcmBytes)
                Log.d(TAG, "ASR result: '$text'")

                if (text.isNotBlank()) {
                    val trimmed = text.trim()
                    coreState.emitTranscript(trimmed)
                    voiceInteractionManager.handleTranscript(trimmed)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "ASR transcription error: ${e.message}", e)
        }

        coreState.setProcessingAsr(false)
        vad.resetState()
    }

    // ── Callback wiring ──────────────────────────────────────────────

    private fun wireCallbacks() {
        streamProcessor.onSentenceBoundary = { text, voice ->
            ttsQueueManager.queueText(text, voice)
        }

        streamProcessor.onConversationId = { convId ->
            serviceScope.launch {
                coreState.setConversationId(convId)
                val agentId = coreState.state.value.selectedAgentId
                if (agentId != null) {
                    agentRepository.setConversationIdForAgent(agentId, convId)
                }
            }
        }

        streamProcessor.onStreamDone = {
            serviceScope.launch {
                voiceInteractionManager.onStreamingComplete()
                voiceInteractionManager.onTTSAndStreamingIdle()
                coreState.emitStreamDone()
            }
        }

        voiceInteractionManager.onTranscriptSend = { text ->
            sendMessage(text)
        }
    }

    private fun unwireCallbacks() {
        streamProcessor.onSentenceBoundary = null
        streamProcessor.onConversationId = null
        streamProcessor.onStreamDone = null
        voiceInteractionManager.onTranscriptSend = null
    }

    // ── Send message ─────────────────────────────────────────────────

    private fun sendMessage(text: String) {
        if (text.isBlank()) return
        if (streamProcessor.state.value.isStreaming) return
        val state = coreState.state.value

        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(text)

        serviceScope.launch {
            try {
                val modelName = prefs.getSelectedModel() ?: ""
                wsManager.sendChatRequest(
                    text = text,
                    modelName = modelName,
                    conversationId = state.conversationId,
                    agentId = state.selectedAgentId,
                )
            } catch (e: Exception) {
                streamProcessor.setError(e.message ?: "Failed to send message")
            }
        }
    }

    // ── Notification ─────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Kurisu Assistant",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Active voice interaction"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openPending = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = Intent(this, CoreService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Kurisu Assistant")
            .setContentText("Voice interaction active")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(openPending)
            .setOngoing(true)
            .addAction(0, "Stop", stopPending)
            .build()
    }
}
