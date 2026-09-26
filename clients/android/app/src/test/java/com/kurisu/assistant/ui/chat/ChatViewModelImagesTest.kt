package com.kurisu.assistant.ui.chat

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.ConversationDetail
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.ServerEvent
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.service.VoiceInteractionManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Base64

/**
 * An image attached in the composer travels with the message (#308).
 *
 * The composer collected images and `sendMessage` then threw them away — the
 * list it sent was always empty — so a picked image was never uploaded, never
 * reached the assistant and never showed in the bubble. The backend takes
 * `chat_request.images` as base64, as the desktop sends it, and answers with
 * the stored uuids once the turn is saved.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatViewModelImagesTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var personaRepo: PersonaRepository
    private lateinit var assistantRepo: AssistantRepository
    private lateinit var authRepo: AuthRepository
    private lateinit var convRepo: ConversationRepository
    private lateinit var prefs: PreferencesDataStore
    private lateinit var wsManager: WebSocketManager
    private lateinit var ttsQueueManager: TtsQueueManager
    private lateinit var voiceInteractionManager: VoiceInteractionManager
    private lateinit var application: Application
    private lateinit var processor: ChatStreamProcessor

    private val kurisu = Persona(id = 1, name = "Kurisu")

    /** A PNG's signature and a few more bytes: the ViewModel sends bytes, it does not decode them. */
    private val pngBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)

    private fun imageFile(name: String, bytes: ByteArray = pngBytes): Uri {
        val file = File(application.cacheDir, name)
        file.writeBytes(bytes)
        return Uri.fromFile(file)
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        application = ApplicationProvider.getApplicationContext()

        personaRepo = mockk(relaxed = true)
        assistantRepo = mockk(relaxed = true)
        authRepo = mockk(relaxed = true)
        convRepo = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        wsManager = mockk(relaxed = true)
        ttsQueueManager = mockk(relaxed = true)
        voiceInteractionManager = VoiceInteractionManager(application)

        every { wsManager.events } returns MutableSharedFlow<ServerEvent>()
        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { authRepo.loadUserProfile() } returns UserProfile(username = "kho")
        coEvery { assistantRepo.getAssistant() } returns Assistant(id = 1, modelName = "m", defaultPersonaId = kurisu.id)
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu)
        coEvery { personaRepo.getConversationIdForPersona(kurisu.id) } returns 421
        coEvery { convRepo.getConversation(421, 20, 0) } returns ConversationDetail(
            id = 421, title = "t", createdAt = "2026-09-01T00:00:00Z",
            messages = listOf(Message(id = 1, role = "user", content = "hi")),
            totalMessages = 1, offset = 0, limit = 20, hasMore = false, personaId = kurisu.id,
        )
    }

    @After
    fun tearDown() {
        voiceInteractionManager.release()
        Dispatchers.resetMain()
    }

    private fun newViewModel(): ChatViewModel {
        processor = ChatStreamProcessor(wsManager)
        return ChatViewModel(
            application = application,
            personaRepository = personaRepo,
            assistantRepository = assistantRepo,
            authRepository = authRepo,
            conversationRepository = convRepo,
            prefs = prefs,
            wsManager = wsManager,
            streamProcessor = processor,
            ttsQueueManager = ttsQueueManager,
            voiceInteractionManager = voiceInteractionManager,
            coreState = CoreState(),
        ).also { it.ioDispatcher = testDispatcher }
    }

    private val pngBase64 get() = Base64.getEncoder().encodeToString(pngBytes)

    @Test
    fun `an attached image is sent with the message as base64`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.addImage(imageFile("cat.png"))
        vm.sendMessage("what is this?")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            wsManager.sendChatRequest(
                text = "what is this?", modelName = "", conversationId = 421, personaId = null,
                images = listOf(pngBase64),
            )
        }
        assertThat(vm.state.value.selectedImages).isEmpty()
    }

    @Test
    fun `an image with no text is sent`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.addImage(imageFile("only.png"))
        vm.sendMessage("")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            wsManager.sendChatRequest(text = "", modelName = "", conversationId = 421, personaId = null, images = listOf(pngBase64))
        }
    }

    @Test
    fun `every attached image is sent, in order`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        val second = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 9, 9)

        vm.addImage(imageFile("a.png"))
        vm.addImage(imageFile("b.jpg", second))
        vm.sendMessage("two")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            wsManager.sendChatRequest(
                text = "two", modelName = "", conversationId = 421, personaId = null,
                images = listOf(pngBase64, Base64.getEncoder().encodeToString(second)),
            )
        }
    }

    @Test
    fun `my bubble shows the image straight away, before the server has stored it`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        val uri = imageFile("now.png")

        vm.addImage(uri)
        vm.sendMessage("look")
        advanceUntilIdle()

        val mine = processor.state.value.streamingMessages.last { it.role == "user" }
        assertThat(mine.images).containsExactly(uri.toString())
    }

    @Test
    fun `text only still sends no images`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.sendMessage("plain")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            wsManager.sendChatRequest(text = "plain", modelName = "", conversationId = 421, personaId = null, images = emptyList())
        }
    }

    @Test
    fun `an image that cannot be read is reported and nothing is sent`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.addImage(Uri.fromFile(File(application.cacheDir, "gone.png")))
        vm.sendMessage("missing")
        advanceUntilIdle()

        coVerify(exactly = 0) { wsManager.sendChatRequest(any(), any(), any(), any(), any()) }
        assertThat(processor.state.value.streamError).contains("image")
    }
}
