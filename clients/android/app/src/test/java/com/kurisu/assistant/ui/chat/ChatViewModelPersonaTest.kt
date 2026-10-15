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
 * One persona, or none, is in use for the whole ACCOUNT (#354), and a persona is
 * optional: with none, the assistant answers as itself (#302).
 *
 * The chat header's persona switch writes `assistants.selected_persona_id` — it
 * changes who answers every conversation, this one included, on every device.
 * A conversation is not tied to a persona: opening one never adopts a persona
 * from it, and a turn never names one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatViewModelPersonaTest {

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

    private val kurisu = Persona(id = 1, name = "Kurisu", voiceReference = "kurisu_neutral.wav")
    private val coach = Persona(id = 3, name = "Coach", voiceReference = "coach_warm.wav")

    private fun assistant(selected: Int? = kurisu.id) = Assistant(
        id = 1,
        modelName = "gpt-4o-mini",
        triggerWord = "kurisu",
        selectedPersonaId = selected,
    )

    private fun detail(id: Int) = ConversationDetail(
        id = id,
        title = "Halden invoice",
        createdAt = "2026-09-01T00:00:00Z",
        messages = listOf(Message(id = 1, role = "user", content = "hi")),
        totalMessages = 1,
        offset = 0,
        limit = 20,
        hasMore = false,
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
        coEvery { assistantRepo.updateAssistant(AssistantUpdate(selectedPersonaId = coach.id)) } returns assistant(coach.id)
        coEvery { assistantRepo.clearSelectedPersona() } returns assistant(null)
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu, coach)
        coEvery { convRepo.getConversation(421, 20, 0) } returns detail(421)
        // The Chats list chose this conversation: the chat opens on it.
        coreState.setConversationId(421)
    }

    @After
    fun tearDown() {
        voiceInteractionManager.release()
        Dispatchers.resetMain()
    }

    private fun newViewModel(): ChatViewModel {
        val processor = ChatStreamProcessor(wsManager)
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
            coreState = coreState,
        )
    }

    @Test
    fun `switching persona changes who answers for the whole account`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)

        vm.switchPersona(coach)
        advanceUntilIdle()

        coVerify(exactly = 1) { assistantRepo.updateAssistant(AssistantUpdate(selectedPersonaId = coach.id)) }
        assertThat(vm.state.value.persona?.id).isEqualTo(coach.id)
        assertThat(vm.state.value.assistant?.selectedPersonaId).isEqualTo(coach.id)
    }

    @Test
    fun `switching persona keeps the open conversation and its transcript`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.switchPersona(coach)
        advanceUntilIdle()

        // The conversation continues as the persona in use now.
        assertThat(vm.state.value.conversationId).isEqualTo(421)
        assertThat(vm.state.value.messages).hasSize(1)
    }

    @Test
    fun `a failed switch reverts the header instead of lying about who answers`() = runTest(testDispatcher) {
        coEvery { assistantRepo.updateAssistant(any<AssistantUpdate>()) } throws RuntimeException("500")

        val vm = newViewModel()
        advanceUntilIdle()

        vm.switchPersona(coach)
        advanceUntilIdle()

        assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)
        assertThat(vm.state.value.assistant?.selectedPersonaId).isEqualTo(kurisu.id)
        assertThat(vm.state.value.commandFeedback).isEqualTo("Could not switch persona")
    }

    @Test
    fun `switching to the assistant clears the selection on the server`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.switchPersona(null)
        advanceUntilIdle()

        coVerify(exactly = 1) { assistantRepo.clearSelectedPersona() }
        assertThat(vm.state.value.persona).isNull()
        assertThat(vm.state.value.conversationId).isEqualTo(421)
    }

    @Test
    fun `the chat opens the conversation the Chats list chose, and nothing else`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.conversationId).isEqualTo(421)
        // No per-persona cache, and no guessing from the server's newest.
        coVerify(exactly = 0) { convRepo.getConversations() }
    }

    @Test
    fun `a new chat from the Chats list opens empty`() = runTest(testDispatcher) {
        coreState.setConversationId(null)

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.conversationId).isNull()
        assertThat(vm.state.value.messages).isEmpty()
        assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)
    }

    @Test
    fun `deleting a conversation asks first and deletes nothing until confirmed`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.requestDeleteConversation()
        assertThat(vm.state.value.deleteConfirmOpen).isTrue()
        coVerify(exactly = 0) { convRepo.deleteConversation(any()) }

        vm.cancelDeleteConversation()
        advanceUntilIdle()
        assertThat(vm.state.value.deleteConfirmOpen).isFalse()
        coVerify(exactly = 0) { convRepo.deleteConversation(any()) }

        vm.requestDeleteConversation()
        vm.confirmDeleteConversation()
        advanceUntilIdle()
        coVerify(exactly = 1) { convRepo.deleteConversation(421) }
        assertThat(vm.state.value.conversationId).isNull()
    }

    @Test
    fun `the wake word comes off the assistant, not off the persona`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        voiceInteractionManager.setVoiceMode(true)
        voiceInteractionManager.handleTranscript("hey kurisu")
        assertThat(voiceInteractionManager.state.value.interactionActive).isTrue()
        voiceInteractionManager.endInteraction()

        // Switching persona must not re-arm or clear it: it wakes the assistant
        // and selects no one.
        vm.switchPersona(coach)
        advanceUntilIdle()
        voiceInteractionManager.handleTranscript("hey kurisu")
        assertThat(voiceInteractionManager.state.value.interactionActive).isTrue()
    }

    @Test
    fun `a new chat opens with the persona in use, the one just switched to`() =
        runTest(testDispatcher) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.switchPersona(coach)
            advanceUntilIdle()

            vm.clearCurrentConversation()
            advanceUntilIdle()

            // The switch is the account's, not the closed conversation's.
            assertThat(vm.state.value.persona?.id).isEqualTo(coach.id)
            assertThat(vm.state.value.conversationId).isNull()
        }

    // ─── A persona is optional (#302) ─────────────────────────────────

    @Test
    fun `with none in use the assistant answers, not the first persona`() = runTest(testDispatcher) {
        coEvery { assistantRepo.getAssistant() } returns assistant(null)

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.persona).isNull()
    }

    @Test
    fun `a persona in use that is disabled is the assistant too`() = runTest(testDispatcher) {
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu.copy(enabled = false), coach)

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.persona).isNull()
    }

    @Test
    fun `a turn in an open conversation names no persona`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.sendMessage("hello")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            wsManager.sendChatRequest(text = "hello", modelName = "", conversationId = 421, images = any())
        }
    }

    @Test
    fun `a new chat's first turn names no persona either`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        vm.clearCurrentConversation()
        advanceUntilIdle()

        vm.sendMessage("hello")
        advanceUntilIdle()

        // The server answers as the persona in use; the request does not say.
        coVerify(exactly = 1) {
            wsManager.sendChatRequest(text = "hello", modelName = "", conversationId = null, images = any())
        }
    }
}
