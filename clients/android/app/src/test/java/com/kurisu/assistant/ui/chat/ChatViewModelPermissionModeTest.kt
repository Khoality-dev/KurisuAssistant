package com.kurisu.assistant.ui.chat

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ConversationDetail
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.PermissionMode
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

/**
 * The permission mode beside the input (#360): one setting for the account,
 * on `PATCH /assistant`. The chip must not lag a tap, so a pick is optimistic
 * and rolled back when the server refuses; opening the sheet refetches the
 * assistant, so a mode changed on another device shows.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatViewModelPermissionModeTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var personaRepo: PersonaRepository
    private lateinit var assistantRepo: AssistantRepository
    private lateinit var authRepo: AuthRepository
    private lateinit var convRepo: ConversationRepository
    private lateinit var prefs: PreferencesDataStore
    private lateinit var wsManager: WebSocketManager
    private lateinit var ttsQueueManager: TtsQueueManager
    private lateinit var voiceInteractionManager: VoiceInteractionManager
    private lateinit var coreState: CoreState
    private lateinit var application: Application

    private val kurisu = Persona(id = 1, name = "Kurisu")

    private fun assistant(mode: PermissionMode = PermissionMode.ASK) = Assistant(
        id = 1,
        modelName = "qwen3:8b",
        triggerWord = "kurisu",
        selectedPersonaId = kurisu.id,
        permissionMode = mode,
    )

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
        coreState = CoreState()
        voiceInteractionManager = VoiceInteractionManager(application)

        every { wsManager.events } returns MutableSharedFlow<ServerEvent>()
        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { prefs.getVoiceMode() } returns false
        coEvery { authRepo.loadUserProfile() } returns UserProfile(username = "kho")
        coEvery { assistantRepo.getAssistant() } returns assistant()
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu)
        // The Chats list chose this conversation: the chat opens on it.
        coreState.setConversationId(421)
        coEvery { convRepo.getConversation(421, 20, 0) } returns ConversationDetail(
            id = 421,
            title = "Halden invoice",
            createdAt = "2026-09-01T00:00:00Z",
            messages = listOf(Message(id = 1, role = "user", content = "hi")),
            totalMessages = 1,
            offset = 0,
            limit = 20,
            hasMore = false,
        )
    }

    @After
    fun tearDown() {
        voiceInteractionManager.release()
        Dispatchers.resetMain()
    }

    private fun newViewModel(): ChatViewModel = ChatViewModel(
        application = application,
        personaRepository = personaRepo,
        assistantRepository = assistantRepo,
        authRepository = authRepo,
        conversationRepository = convRepo,
        prefs = prefs,
        wsManager = wsManager,
        streamProcessor = ChatStreamProcessor(wsManager),
        ttsQueueManager = ttsQueueManager,
        voiceInteractionManager = voiceInteractionManager,
        coreState = coreState,
    )

    @Test
    fun `a new account is on Always ask`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        assertThat(vm.state.value.assistant?.permissionMode).isEqualTo(PermissionMode.ASK)
    }

    @Test
    fun `opening the sheet refetches, so a mode changed elsewhere shows`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        coEvery { assistantRepo.getAssistant() } returns assistant(PermissionMode.FULL)

        vm.openPermissionModeSheet()
        assertThat(vm.state.value.modal).isEqualTo(ChatModal.PermissionModePicker)
        advanceUntilIdle()

        assertThat(vm.state.value.assistant?.permissionMode).isEqualTo(PermissionMode.FULL)
    }

    @Test
    fun `picking a mode patches the assistant at once, and only that field`() = runTest(testDispatcher) {
        coEvery { assistantRepo.updateAssistant(any()) } returns assistant(PermissionMode.READ_ONLY)
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openPermissionModeSheet()
        advanceUntilIdle()

        vm.setPermissionMode(PermissionMode.READ_ONLY)
        // Optimistic: the chip reads the new mode before the server answers.
        assertThat(vm.state.value.assistant?.permissionMode).isEqualTo(PermissionMode.READ_ONLY)
        assertThat(vm.state.value.modal).isNull()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            assistantRepo.updateAssistant(AssistantUpdate(permissionMode = PermissionMode.READ_ONLY))
        }
        assertThat(vm.state.value.conversationId).isEqualTo(421)
    }

    @Test
    fun `picking the mode in use sends nothing`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.setPermissionMode(PermissionMode.ASK)
        advanceUntilIdle()

        coVerify(exactly = 0) { assistantRepo.updateAssistant(any()) }
    }

    @Test
    fun `a refused pick goes back and says so`() = runTest(testDispatcher) {
        coEvery { assistantRepo.updateAssistant(any()) } throws RuntimeException("500")
        val vm = newViewModel()
        advanceUntilIdle()

        vm.setPermissionMode(PermissionMode.FULL)
        advanceUntilIdle()

        assertThat(vm.state.value.assistant?.permissionMode).isEqualTo(PermissionMode.ASK)
        assertThat(vm.state.value.commandFeedback).isEqualTo("Could not change the permission mode")
    }
}
