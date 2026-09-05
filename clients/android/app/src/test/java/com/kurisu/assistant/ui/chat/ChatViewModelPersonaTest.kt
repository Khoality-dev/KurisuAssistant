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
 * The chat header's persona switch is a PER-CONVERSATION override.
 *
 * The one thing that must never happen is the switch leaking into
 * `assistants.default_persona_id`: pick a different voice for one thread and
 * every future chat would silently change hands. These tests pin that down,
 * plus the reload path that makes the override survive a reconnect.
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

    private fun assistant() = Assistant(
        id = 1,
        modelName = "gpt-4o-mini",
        triggerWord = "kurisu",
        defaultPersonaId = kurisu.id,
    )

    private fun detail(id: Int, personaId: Int?) = ConversationDetail(
        id = id,
        title = "Halden invoice",
        createdAt = "2026-09-01T00:00:00Z",
        messages = listOf(Message(id = 1, role = "user", content = "hi")),
        totalMessages = 1,
        offset = 0,
        limit = 20,
        hasMore = false,
        personaId = personaId,
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
        coEvery { prefs.getAsrAlwaysListen() } returns true
        coEvery { authRepo.loadUserProfile() } returns UserProfile(username = "kho")
        coEvery { assistantRepo.getAssistant() } returns assistant()
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu, coach)
        coEvery { personaRepo.getConversationIdForPersona(kurisu.id) } returns 421
        coEvery { convRepo.getConversation(421, 20, 0) } returns detail(421, kurisu.id)
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
    fun `switching persona rebinds the conversation and never the assistant default`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)

        vm.switchPersona(coach)
        advanceUntilIdle()

        // The conversation moved…
        coVerify(exactly = 1) { convRepo.setConversationPersona(421, coach.id) }
        assertThat(vm.state.value.persona?.id).isEqualTo(coach.id)

        // …and nothing touched the assistant. This is the whole point of
        // "this conversation only".
        coVerify(exactly = 0) { assistantRepo.updateAssistant(any<AssistantUpdate>()) }
        assertThat(vm.state.value.assistant?.defaultPersonaId).isEqualTo(kurisu.id)
        assertThat(vm.state.value.defaultPersonaName).isEqualTo("Kurisu")
    }

    @Test
    fun `switching persona keeps the same conversation and its transcript`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.switchPersona(coach)
        advanceUntilIdle()

        // The old agent switch swapped conversations. A per-conversation override
        // must not: the user is still reading this thread.
        assertThat(vm.state.value.conversationId).isEqualTo(421)
        assertThat(vm.state.value.messages).hasSize(1)
        coVerify(exactly = 0) { personaRepo.getConversationIdForPersona(coach.id) }
    }

    @Test
    fun `a failed rebind reverts the header instead of lying about who answers`() = runTest(testDispatcher) {
        coEvery { convRepo.setConversationPersona(any(), any()) } throws RuntimeException("500")

        val vm = newViewModel()
        advanceUntilIdle()

        vm.switchPersona(coach)
        advanceUntilIdle()

        assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)
        assertThat(vm.state.value.commandFeedback).isEqualTo("Could not switch persona")
    }

    @Test
    fun `reloading adopts the binding the server holds, so the override survives a reconnect`() = runTest(testDispatcher) {
        coEvery { convRepo.getConversation(421, 20, 0) } returns detail(421, coach.id)

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.persona?.id).isEqualTo(coach.id)
        // The default is untouched — it is still what a NEW chat would open with.
        assertThat(vm.state.value.assistant?.defaultPersonaId).isEqualTo(kurisu.id)
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

        assertThat(voiceInteractionManager.handleTranscript("hey kurisu")).isTrue()
        voiceInteractionManager.exitMode()

        // Switching persona must not re-arm or clear it: it wakes the assistant
        // and selects no one.
        vm.switchPersona(coach)
        advanceUntilIdle()
        assertThat(voiceInteractionManager.handleTranscript("hey kurisu")).isTrue()
    }

    @Test
    fun `a new chat opens with the default persona, not the one this thread was switched to`() =
        runTest(testDispatcher) {
            val vm = newViewModel()
            advanceUntilIdle()

            vm.switchPersona(coach)
            advanceUntilIdle()
            assertThat(vm.state.value.persona?.id).isEqualTo(coach.id)

            vm.clearCurrentConversation()
            advanceUntilIdle()

            // The override belonged to the conversation that just closed.
            assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)
            assertThat(vm.state.value.conversationId).isNull()
        }
}
