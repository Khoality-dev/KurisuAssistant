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
import com.kurisu.assistant.data.model.ModelInfo
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
 * The chat header's model sheet sets the ASSISTANT's model (#197).
 *
 * It is the mirror of [ChatViewModelPersonaTest]: where the persona sheet must
 * never leak into the assistant, the model sheet must never land anywhere but
 * `PATCH /assistant` — a model is one for every persona, and a per-conversation
 * model would be the old "main agent" carrying its own back in. These pin that,
 * plus the two ways the pick can go nowhere: the model already set, and a server
 * that refuses.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatViewModelModelTest {

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

    private val qwen = ModelInfo("qwen3:8b", "ollama")
    private val gemini = ModelInfo("gemini-2.0-flash", "gemini")

    private fun assistant(model: ModelInfo = qwen) = Assistant(
        id = 1,
        modelName = model.name,
        providerType = model.provider,
        triggerWord = "kurisu",
        defaultPersonaId = kurisu.id,
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
        coEvery { assistantRepo.listModels() } returns listOf(qwen, gemini)
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu)
        coEvery { personaRepo.getConversationIdForPersona(kurisu.id) } returns 421
        coEvery { convRepo.getConversation(421, 20, 0) } returns ConversationDetail(
            id = 421,
            title = "Halden invoice",
            createdAt = "2026-09-01T00:00:00Z",
            messages = listOf(Message(id = 1, role = "user", content = "hi")),
            totalMessages = 1,
            offset = 0,
            limit = 20,
            hasMore = false,
            personaId = kurisu.id,
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
    fun `opening the sheet lists what the host offers`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openModelSheet()
        val loading = vm.state.value.modal as ChatModal.ModelPicker
        assertThat(loading.loading).isTrue()

        advanceUntilIdle()
        val sheet = vm.state.value.modal as ChatModal.ModelPicker
        assertThat(sheet.loading).isFalse()
        assertThat(sheet.models).containsExactly(qwen, gemini).inOrder()
    }

    @Test
    fun `picking a model patches the assistant, provider included, and touches nothing else`() =
        runTest(testDispatcher) {
            coEvery { assistantRepo.updateAssistant(any()) } returns assistant(gemini)

            val vm = newViewModel()
            advanceUntilIdle()
            vm.openModelSheet()
            advanceUntilIdle()

            vm.pickModel(gemini)
            advanceUntilIdle()

            // One row, two columns: the name alone would point the assistant at
            // a model the old provider cannot serve.
            coVerify(exactly = 1) {
                assistantRepo.updateAssistant(
                    AssistantUpdate(modelName = "gemini-2.0-flash", providerType = "gemini"),
                )
            }
            // The header names the new model; the sheet is gone; the
            // conversation and its persona did not move.
            assertThat(vm.state.value.assistant?.modelName).isEqualTo("gemini-2.0-flash")
            assertThat(vm.state.value.modal).isNull()
            assertThat(vm.state.value.persona?.id).isEqualTo(kurisu.id)
            assertThat(vm.state.value.conversationId).isEqualTo(421)
            coVerify(exactly = 0) { convRepo.setConversationPersona(any(), any()) }
        }

    @Test
    fun `picking the model already in use sends nothing`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        vm.openModelSheet()
        advanceUntilIdle()

        vm.pickModel(qwen)
        advanceUntilIdle()

        coVerify(exactly = 0) { assistantRepo.updateAssistant(any()) }
        assertThat(vm.state.value.modal).isNull()
    }

    @Test
    fun `a refused pick leaves the model as it was and says so`() = runTest(testDispatcher) {
        coEvery { assistantRepo.updateAssistant(any()) } throws RuntimeException("500")

        val vm = newViewModel()
        advanceUntilIdle()
        vm.openModelSheet()
        advanceUntilIdle()

        vm.pickModel(gemini)
        advanceUntilIdle()

        // Nothing is optimistic here: the model applies from the next message,
        // so the name only changes once the server has agreed.
        assertThat(vm.state.value.assistant?.modelName).isEqualTo("qwen3:8b")
        assertThat(vm.state.value.modal).isNull()
        assertThat(vm.state.value.commandFeedback).isEqualTo("Could not change model")
    }

    @Test
    fun `a host with no models still opens the sheet, empty, rather than failing`() =
        runTest(testDispatcher) {
            coEvery { assistantRepo.listModels() } returns emptyList()

            val vm = newViewModel()
            advanceUntilIdle()
            vm.openModelSheet()
            advanceUntilIdle()

            val sheet = vm.state.value.modal as ChatModal.ModelPicker
            assertThat(sheet.models).isEmpty()
            assertThat(sheet.loading).isFalse()
        }
}
