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
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.domain.voice.VoiceInteractionManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import javax.inject.Inject

@AndroidEntryPoint
class ChatForegroundService : Service() {

    companion object {
        private const val TAG = "ChatForegroundService"
        private const val CHANNEL_ID = "kurisu_chat_channel"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.kurisu.assistant.ACTION_STOP_SERVICE"

        fun start(context: Context) {
            val intent = Intent(context, ChatForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ChatForegroundService::class.java))
        }
    }

    @Inject lateinit var wsManager: WebSocketManager
    @Inject lateinit var streamProcessor: ChatStreamProcessor
    @Inject lateinit var ttsQueueManager: TtsQueueManager
    @Inject lateinit var voiceInteractionManager: VoiceInteractionManager
    @Inject lateinit var agentRepository: AgentRepository
    @Inject lateinit var conversationRepository: ConversationRepository
    @Inject lateinit var prefs: PreferencesDataStore
    @Inject lateinit var serviceState: ServiceState

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    inner class LocalBinder : Binder() {
        val service: ChatForegroundService get() = this@ChatForegroundService
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
        serviceState.setServiceRunning(true)

        // Ensure WebSocket is connected while service is alive
        serviceScope.launch {
            try { wsManager.connect() } catch (e: Exception) {
                Log.e(TAG, "WebSocket connect failed: ${e.message}")
            }
        }

        // Start listening for trigger words / voice interaction
        voiceInteractionManager.startListening()

        Log.d(TAG, "Service started")
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "Service stopping")
        voiceInteractionManager.stopListening()
        unwireCallbacks()
        streamProcessor.stopCollecting()
        serviceState.setServiceRunning(false)
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun wireCallbacks() {
        streamProcessor.onSentenceBoundary = { text, voice ->
            ttsQueueManager.queueText(text, voice)
        }

        streamProcessor.onConversationId = { convId ->
            serviceScope.launch {
                serviceState.setConversationId(convId)
                val agentId = serviceState.state.value.selectedAgentId
                if (agentId != null) {
                    agentRepository.setConversationIdForAgent(agentId, convId)
                }
            }
        }

        streamProcessor.onStreamDone = {
            serviceScope.launch {
                val convId = serviceState.state.value.conversationId
                if (convId != null) {
                    try {
                        conversationRepository.getConversation(convId, 20, 0)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to refresh conversation on stream done", e)
                    }
                }
                streamProcessor.clearStreamingMessages()
                voiceInteractionManager.onStreamingComplete()
                voiceInteractionManager.onTTSAndStreamingIdle()
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

    private fun sendMessage(text: String) {
        if (text.isBlank()) return
        val state = serviceState.state.value

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

        val stopIntent = Intent(this, ChatForegroundService::class.java).apply {
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
