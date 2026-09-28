package com.kurisu.assistant.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.Manifest
import androidx.core.content.ContextCompat
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.kurisu.assistant.MainActivity
import com.kurisu.assistant.R
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.AsrRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.domain.audio.AudioRecorder
import com.kurisu.assistant.domain.audio.VoiceActivityDetector
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import javax.inject.Inject
import com.kurisu.assistant.domain.audio.AsrModelSelection
import com.kurisu.assistant.domain.tts.describeSpeechFailure
import com.kurisu.assistant.domain.voice.MicProblem

@AndroidEntryPoint
class CoreService : Service() {

    companion object {
        private const val TAG = "CoreService"
        private const val CHANNEL_ID = "kurisu_chat_channel"
        private const val NOTIFICATION_ID = 1
        private const val SILENCE_TIMEOUT_MS = 600L
        const val ACTION_STOP = "com.kurisu.assistant.ACTION_STOP_SERVICE"
        const val ACTION_SET_VOICE_MODE = "com.kurisu.assistant.ACTION_SET_VOICE_MODE"
        const val ACTION_RETRY_MIC = "com.kurisu.assistant.ACTION_RETRY_MIC"
        const val EXTRA_ON = "on"

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

        /**
         * Voice mode on or off (#341): on, the mic listens for the wake word; off,
         * it does not listen at all. The caller remembers the choice.
         */
        fun setVoiceMode(context: Context, on: Boolean) {
            val intent = Intent(context, CoreService::class.java).apply {
                action = ACTION_SET_VOICE_MODE
                putExtra(EXTRA_ON, on)
            }
            context.startService(intent)
        }

        /** Start the mic again after a problem: the voice bar's "Try again" and "Retry". */
        fun retryMic(context: Context) {
            context.startService(Intent(context, CoreService::class.java).apply { action = ACTION_RETRY_MIC })
        }

        fun hasMicPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        /**
         * Voice mode as the UI asks for it. Without mic access the service is not
         * touched — a microphone foreground service may not start without it, and
         * on Android 14+ trying throws — and the voice bar says access is off.
         */
        fun requestVoiceMode(context: Context, coreState: CoreState, on: Boolean) {
            if (!on) coreState.setMicProblem(null)
            if (on && !hasMicPermission(context)) {
                coreState.setMicProblem(MicProblem.BLOCKED)
                return
            }
            setVoiceMode(context, on)
        }

        /** "Try again" / "Retry", and the chat coming back from Android settings. */
        fun requestMicRetry(context: Context, coreState: CoreState) {
            if (!hasMicPermission(context)) {
                coreState.setMicProblem(MicProblem.BLOCKED)
                return
            }
            // The service never started while access was off; turning voice mode
            // on starts it and the mic together.
            if (coreState.state.value.isServiceRunning) retryMic(context) else setVoiceMode(context, true)
        }
    }

    @Inject lateinit var wsManager: WebSocketManager
    @Inject lateinit var streamProcessor: ChatStreamProcessor
    @Inject lateinit var ttsQueueManager: TtsQueueManager
    @Inject lateinit var voiceInteractionManager: VoiceInteractionManager
    @Inject lateinit var personaRepository: PersonaRepository
    @Inject lateinit var conversationRepository: ConversationRepository
    @Inject lateinit var asrRepository: AsrRepository
    @Inject lateinit var prefs: PreferencesDataStore
    @Inject lateinit var coreState: CoreState
    @Inject lateinit var audioRecorder: AudioRecorder
    @Inject lateinit var vad: VoiceActivityDetector

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private var vadJob: Job? = null
    private var silenceTimerJob: Job? = null
    private var ttsObserverJob: Job? = null
    private var isSpeaking = false
    private var started = false

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

        ensureStarted()

        when (intent?.action) {
            ACTION_SET_VOICE_MODE -> applyVoiceMode(intent.getBooleanExtra(EXTRA_ON, false))
            ACTION_RETRY_MIC -> if (voiceInteractionManager.state.value.voiceMode) {
                stopRecordingAndVad()
                serviceScope.launch { startRecordingAndVad() }
            }
        }
        return START_STICKY
    }

    /** Foreground, callbacks, the socket and, if it was left on, voice mode — once. */
    private fun ensureStarted() {
        if (started) return
        started = true

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

        // Voice mode is the only time the mic listens (#341): it comes back on
        // with the app if this device left it on, and otherwise the mic stays off.
        serviceScope.launch {
            if (prefs.getVoiceMode()) applyVoiceMode(true)
        }

        Log.d(TAG, "Service started")
    }

    private fun applyVoiceMode(on: Boolean) {
        voiceInteractionManager.setVoiceMode(on)
        if (on) {
            if (!coreState.state.value.isRecording) serviceScope.launch { startRecordingAndVad() }
        } else {
            stopRecordingAndVad()
            coreState.setMicProblem(null)
        }
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

    /**
     * Start the mic for voice mode. A failure is a state the voice bar shows
     * until it is fixed, by its fix (#341): access that is off, speech
     * recognition that did not load, or a mic another app is holding.
     */
    private suspend fun startRecordingAndVad() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "Microphone permission not granted")
            coreState.setMicProblem(MicProblem.BLOCKED)
            return
        }
        if (!vad.initialize()) {
            Log.e(TAG, "Failed to initialize VAD")
            coreState.setMicProblem(MicProblem.ASR_UNAVAILABLE)
            return
        }

        audioRecorder.preferredDeviceType = prefs.getAudioInputDeviceType()
        val started = audioRecorder.start()
        if (!started) {
            Log.e(TAG, "AudioRecorder failed to start")
            coreState.setMicProblem(MicProblem.UNAVAILABLE)
            return
        }

        coreState.setMicProblem(null)
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
                        coreState.setUserTalking(true)
                        voiceInteractionManager.setUserTalking(true)
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
        coreState.setUserTalking(false)

        if (audioRecorder.isRecording) {
            audioRecorder.stop()
        }

        coreState.setRecording(false)
    }

    private suspend fun processCurrentRecording() {
        coreState.setProcessingAsr(true)
        coreState.setUserTalking(false)
        isSpeaking = false

        try {
            val pcmBytes = audioRecorder.takeAccumulatedPcm()
            val sampleCount = pcmBytes.size / 2
            Log.d(TAG, "Took PCM snapshot: ${pcmBytes.size} bytes ($sampleCount samples, ${String.format("%.1f", sampleCount / 16000.0)}s)")

            if (pcmBytes.isEmpty()) {
                Log.w(TAG, "Empty recording, skipping ASR")
            } else if (sampleCount < 8000) {
                // Skip audio too short to contain a trigger word (< 0.5s at 16kHz)
                Log.d(TAG, "Audio too short ($sampleCount samples), skipping ASR")
            } else {
                val asrLanguage = prefs.getAsrLanguage()
                val language = asrLanguage.ifBlank { null }
                val model = chooseAsrModel(pcmBytes)
                val result = asrRepository.transcribe(pcmBytes, language = language, model = model)
                Log.d(TAG, "ASR result: '${result.text}' (detected=${result.language}, selected=$asrLanguage, model=$model)")

                // Cache auto-detected language on first transcription
                if (asrLanguage.isBlank() && result.language.isNotBlank()) {
                    prefs.setAsrLanguage(result.language)
                    Log.d(TAG, "Cached auto-detected ASR language: ${result.language}")
                }

                // Drop result if detected language doesn't match selected language
                if (asrLanguage.isNotBlank() && result.language != asrLanguage) {
                    Log.d(TAG, "ASR language mismatch, dropping result")
                } else if (result.text.isNotBlank()) {
                    val trimmed = result.text.trim()
                    coreState.emitTranscript(trimmed)
                    // Sent in an interaction, or started one with the wake word;
                    // anything else is ignored — there is no dictation (#341).
                    voiceInteractionManager.handleTranscript(trimmed)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "ASR transcription error: ${e.message}", e)
            coreState.emitSpeechError(describeSpeechFailure("Transcription", e))
        }

        coreState.setProcessingAsr(false)
        // What was said is transcribed: the 30-second window may open again.
        withContext(Dispatchers.Main) { voiceInteractionManager.setUserTalking(false) }
        vad.resetState()
    }

    /**
     * The ASR model the Speech settings ask for: the fixed one, or — in routing
     * mode — the one mapped to the language the server hears in this clip. Null
     * is the server's default. The settings existed but were never sent (#200).
     */
    private suspend fun chooseAsrModel(pcmBytes: ByteArray): String? {
        val mode = prefs.getAsrMode()
        val fixed = prefs.getAsrFixedModel()
        val map = prefs.getAsrModelMap()
        val detected = if (AsrModelSelection.needsLanguageDetection(mode, map)) {
            try {
                asrRepository.detectLanguage(pcmBytes)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Detection is an optimisation; transcribing with the default is
                // still better than dropping the clip.
                Log.w(TAG, "ASR language detection failed, using the default model: ${e.message}")
                null
            }
        } else {
            null
        }
        return AsrModelSelection.resolve(mode, fixed, map, detected)
    }

    // ── Callback wiring ──────────────────────────────────────────────

    private fun wireCallbacks() {
        // "Generate TTS during responses" is a setting the user can turn off; the
        // sentence still reaches the queue only when it is on (#200).
        streamProcessor.onSentenceBoundary = { text, voice ->
            serviceScope.launch {
                if (prefs.getTTSAutoPlay()) ttsQueueManager.queueText(text, voice)
            }
        }
        ttsQueueManager.onError = { message -> coreState.emitSpeechError(message) }

        streamProcessor.onConversationId = { convId ->
            serviceScope.launch {
                coreState.setConversationId(convId)
                // Null is the assistant answering as itself (#302), cached apart.
                personaRepository.setConversationIdForPersona(coreState.state.value.currentPersonaId, convId)
            }
        }

        // Compaction is in place since #99: the server trims the conversation it
        // is already in and reports it with `context_info`, so there is no new
        // conversation to adopt and the persona mapping stays valid.

        streamProcessor.onStreamDone = {
            serviceScope.launch {
                voiceInteractionManager.isStreaming = false
                voiceInteractionManager.onStreamingComplete()
                // Wait for TTS to finish before starting idle timer
                if (!ttsQueueManager.state.value.isQueueActive) {
                    voiceInteractionManager.onTTSAndStreamingIdle()
                }
                coreState.emitStreamDone()
            }
        }

        voiceInteractionManager.onTranscriptSend = { text, newConversation ->
            sendMessage(text, newConversation)
        }

        // Observe TTS state to notify VoiceInteractionManager when TTS finishes
        ttsObserverJob = serviceScope.launch {
            ttsQueueManager.state.collect { ttsState ->
                voiceInteractionManager.isTTSActive = ttsState.isQueueActive
                if (!ttsState.isQueueActive && !streamProcessor.state.value.isStreaming) {
                    voiceInteractionManager.onTTSAndStreamingIdle()
                }
            }
        }
    }

    private fun unwireCallbacks() {
        streamProcessor.onSentenceBoundary = null
        streamProcessor.onConversationId = null
        streamProcessor.onStreamDone = null
        voiceInteractionManager.onTranscriptSend = null
        ttsObserverJob?.cancel()
        ttsObserverJob = null
    }

    // ── Send message ─────────────────────────────────────────────────

    private fun sendMessage(text: String, newConversation: Boolean = false) {
        if (text.isBlank()) return
        if (streamProcessor.state.value.isStreaming) return
        // Each interaction is a new conversation (#341): its first message leaves
        // the one on screen, which stays in Chats.
        if (newConversation) {
            coreState.startNewInteraction(voiceInteractionManager.state.value.wokeAtMs ?: System.currentTimeMillis())
        }
        val state = coreState.state.value

        voiceInteractionManager.isStreaming = true
        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(text)

        serviceScope.launch {
            // The conversation left behind stays in Chats; the cache that reopens
            // it for this persona forgets it, as `/clear` does.
            if (newConversation) personaRepository.clearConversationIdForPersona(state.currentPersonaId)
            try {
                // Backend uses the assistant's configured model_name when modelName is empty.
                wsManager.sendChatRequest(
                    text = text,
                    modelName = "",
                    conversationId = state.conversationId,
                    // Only a chat that does not exist yet names who answers it;
                    // an existing one is bound on the server (see ChatViewModel).
                    personaId = if (state.conversationId == null) state.currentPersonaId else null,
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
            .setContentText("Voice mode")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(openPending)
            .setOngoing(true)
            .addAction(0, "Stop", stopPending)
            .build()
    }
}
