package com.kurisuassistant.android


import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.widget.Toast
import androidx.annotation.RequiresPermission
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.collection.MutableFloatList
import androidx.collection.MutableIntList
import com.kurisuassistant.android.silerovad.SileroVadDetector
import com.kurisuassistant.android.silerovad.SileroVadOnnxModel
import com.kurisuassistant.android.utils.CircularQueue
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.ChatRepository
import okhttp3.MediaType.Companion.toMediaType
import java.nio.ByteBuffer
import java.nio.ByteOrder
import okhttp3.Request
import okio.IOException
import okhttp3.RequestBody.Companion.toRequestBody

private const val CHANNEL_ID = "RecordingServiceChannel"
private const val TAG = "RecordingService"
private fun createNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Audio Recording",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Channel for recording service"
        }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }
}

class RecordingService : Service() {
    private val sampleRate = 16_000
    private val outSampleRate = 32_000
    private val sileroVADWindowSize = 512
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val encoding = AudioFormat.ENCODING_PCM_16BIT
    private val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, encoding)
    private var recorder: AudioRecord? = null
    private var recordingJob: Job? = null
    private var player: AudioTrack? = null
    private val audioBuffer: CircularQueue = CircularQueue(16000000)
    private val asrBuffer: MutableIntList = MutableIntList()
    private lateinit var vadModel : SileroVadDetector
    private lateinit var agent: Agent
    private val conversationTimeout = 10 * 1000 // 10s
    private lateinit var startSFX : ShortArray
    private lateinit var stopSFX : ShortArray



    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    override fun onCreate() {
        super.onCreate()
        startSFX = Util.loadWavFile(this, R.raw.start_effect)
        stopSFX = Util.loadWavFile(this, R.raw.stop_effect)
        createNotificationChannel(this)
        startForeground(NOTIFICATION_ID, buildNotification())
        initRecorder()
        // REST agent requires a valid AudioTrack instance for playback
        player?.let {
            agent = Agent(it)
        }
        initSileroVAD()
        startRecordingLoop()
        ChatRepository.setConversationActive(false)
        Log.d(TAG, "onCreate")
    }



    private fun buildNotification(): Notification {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                PendingIntent.FLAG_MUTABLE else 0
        )
        Log.d(TAG, "buildNotification")
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Recording Audio")
            .setContentText("Microphone is being recorded")
            .setContentIntent(pendingIntent)
            .setSmallIcon(R.drawable.ic_launcher_background)
            .build()
    }

    private fun initSileroVAD() {
        val modelBytes  = resources.openRawResource(R.raw.silero_vad).readBytes()
        val modelBuffer: ByteBuffer = ByteBuffer
            .allocateDirect(modelBytes.size)
            .order(ByteOrder.nativeOrder())
            .put(modelBytes)
            .apply { flip() }
        vadModel = SileroVadDetector(modelBuffer)
    }

    @RequiresApi(Build.VERSION_CODES.S)
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    private fun initRecorder() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isBluetoothScoOn = true
        val devices = audioManager.availableCommunicationDevices
        val bleDevice = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO  }
        if (bleDevice != null)
        {
            audioManager.setCommunicationDevice(bleDevice)
        }
        recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            sampleRate,
            channelConfig,
            encoding,
            bufferSize,

        )

        player = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(encoding)
                    .setSampleRate(outSampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        player?.play()
    }

    private fun startRecordingLoop() {
        recorder?.startRecording()
        recordingJob = CoroutineScope(Dispatchers.IO).launch {
            val tempBuffer = ShortArray(bufferSize / 2)
            var previousIsSpeaking = vadModel.isSpeaking
            // Track whether the assistant is currently in a conversation
            var isInteracting = false
            var lastInteractionTimeStamp: Long = 0
            var playedStartSFX = false

            while (isActive) {
                val readCount = recorder!!.read(tempBuffer, 0, tempBuffer.size)
                if (readCount > 0) {
                    val floatFrame = FloatArray(readCount) { i ->
                        // Short ranges –32768..32767, so divide by max value
                        tempBuffer[i] / 32767.0f
                    }
                    val intFrame = IntArray(readCount) { i ->
                        tempBuffer[i].toInt()
                    }
                    audioBuffer.addAll(floatFrame.toList())

                    asrBuffer.addAll(intFrame)
                }


                while (audioBuffer.size() >= sileroVADWindowSize)
                {
                    val inputBuffer = audioBuffer.topFirst(sileroVADWindowSize)
                    audioBuffer.dropFirst(sileroVADWindowSize)
                    vadModel.call(inputBuffer.toFloatArray())

                }

                if (vadModel.isSpeaking == false) {
                    if (previousIsSpeaking == false) {
                        if (asrBuffer.size > 16000) {
                            asrBuffer.removeRange(0, asrBuffer.size - 16000)
                        }
                    } else {
                        if (playedStartSFX) {
                            player?.write(stopSFX, 0, stopSFX.size)
                            playedStartSFX = false
                        }

                        val text = agent.stt(asrBuffer)
                        asrBuffer.clear()
                        Log.d(TAG, "Transcription: $text")

                        if (!isInteracting) {
                            if (text.contains("Kurisu", ignoreCase = true)) {
                                isInteracting = true
                                ChatRepository.setConversationActive(true)
                                lastInteractionTimeStamp = System.currentTimeMillis()
                                player?.write(startSFX, 0, startSFX.size)

                                Log.d(TAG, "User: $text")
                                ChatRepository.sendMessage(text)
                                lastInteractionTimeStamp = System.currentTimeMillis()
                            }
                        } else {
                            lastInteractionTimeStamp = System.currentTimeMillis()
                            Log.d(TAG, "User: $text")
                            ChatRepository.sendMessage(text)
                            // audio replies are fetched via REST and played automatically
                            lastInteractionTimeStamp = System.currentTimeMillis()
                        }
                    }
                } else {
                    if (!previousIsSpeaking && isInteracting) {
                        player?.write(startSFX, 0, startSFX.size)
                        playedStartSFX = true
                    }
                }

                if (isInteracting &&
                    System.currentTimeMillis() - lastInteractionTimeStamp > conversationTimeout &&
                    !vadModel.isSpeaking) {
                    isInteracting = false
                    ChatRepository.setConversationActive(false)
                    player?.write(stopSFX, 0, stopSFX.size)
                }

                previousIsSpeaking = vadModel.isSpeaking
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        recordingJob?.cancel()
        recorder?.apply {
            stop()
            release()
        }
        recorder = null
        player?.apply {
            stop()
            release()
        }
        player = null
        ChatRepository.setConversationActive(false)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // If killed, restart with same Intent
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val NOTIFICATION_ID = 1
    }
}