package com.kurisu.assistant.ui.chat

import android.app.Application
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

/**
 * Voice mode from the chat (#341): a control turns it on and off and the app
 * remembers which; turning it off says the mic is off; and each interaction
 * opens a new conversation, marked as such, with the previous one kept.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatViewModelVoiceModeTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var personaRepo: PersonaRepository
    private lateinit var assistantRepo: AssistantRepository
    private lateinit var authRepo: AuthRepository
    private lateinit var convRepo: ConversationRepository
    private lateinit var prefs: PreferencesDataStore
    private lateinit var wsManager: WebSocketManager
    private lateinit var ttsQueueManager: TtsQueueManager
    private lateinit var voice: VoiceInteractionManager
    private lateinit var coreState: CoreState
    private lateinit var application: Application

    private val kurisu = Persona(id = 1, name = "Kurisu")

    private fun detail(id: Int) = ConversationDetail(
        id = id,
        title = "Eggs",
        createdAt = "2026-09-28T00:00:00Z",
        messages = listOf(Message(id = id, role = "user", content = "hi")),
        totalMessages = 1,
        offset = 0,
        limit = 20,
        hasMore = false,
        personaId = kurisu.id,
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
        voice = VoiceInteractionManager(application)

        every { wsManager.events } returns MutableSharedFlow<ServerEvent>()
        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { prefs.getVoiceMode() } returns false
        coEvery { authRepo.loadUserProfile() } returns UserProfile(username = "kho")
        coEvery { assistantRepo.getAssistant() } returns Assistant(id = 1, modelName = "m", triggerWord = "kurisu", selectedPersonaId = kurisu.id)
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu)
        coEvery { personaRepo.getConversationIdForPersona(kurisu.id) } returns 421
        coEvery { convRepo.getConversation(421, 20, 0) } returns detail(421)
        coEvery { convRepo.getConversation(500, 20, 0) } returns detail(500)
    }

    @After
    fun tearDown() {
        voice.release()
        Dispatchers.resetMain()
    }

    private fun newViewModel() = ChatViewModel(
        application = application,
        personaRepository = personaRepo,
        assistantRepository = assistantRepo,
        authRepository = authRepo,
        conversationRepository = convRepo,
        prefs = prefs,
        wsManager = wsManager,
        streamProcessor = ChatStreamProcessor(wsManager),
        ttsQueueManager = ttsQueueManager,
        voiceInteractionManager = voice,
        coreState = coreState,
    )

    @Test
    fun `the control turns voice mode on and off, and the app remembers which`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.setVoiceMode(true)
        advanceUntilIdle()
        assertThat(voice.state.value.voiceMode).isTrue()
        coVerify { prefs.setVoiceMode(true) }

        vm.setVoiceMode(false)
        advanceUntilIdle()
        assertThat(voice.state.value.voiceMode).isFalse()
        coVerify { prefs.setVoiceMode(false) }
    }

    @Test
    fun `voice mode comes back on with the app if it was left on`() = runTest(testDispatcher) {
        coEvery { prefs.getVoiceMode() } returns true

        newViewModel()
        advanceUntilIdle()

        assertThat(voice.state.value.voiceMode).isTrue()
    }

    @Test
    fun `turning it off says the mic is off`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        vm.setVoiceMode(true)
        advanceUntilIdle()
        assertThat(vm.state.value.voiceOffNotice).isFalse()

        vm.setVoiceMode(false)
        advanceUntilIdle()
        assertThat(vm.state.value.voiceOffNotice).isTrue()

        vm.dismissVoiceOffNotice()
        assertThat(vm.state.value.voiceOffNotice).isFalse()
    }

    @Test
    fun `an interaction opens a new conversation on a marker, keeping the previous one`() = runTest(testDispatcher) {
        val vm = newViewModel()
        advanceUntilIdle()
        assertThat(vm.state.value.conversationId).isEqualTo(421)

        coreState.startNewInteraction(atMs = 1_000L)
        advanceUntilIdle()

        assertThat(vm.state.value.conversationId).isNull()
        assertThat(vm.state.value.messages).isEmpty()
        val marker = vm.state.value.interactionMarker!!
        assertThat(marker.atMs).isEqualTo(1_000L)
        assertThat(marker.previousConversationId).isEqualTo(421)
        assertThat(vm.state.value.showInteractionMarker).isTrue()

        // The server creates the conversation with the first reply; the marker
        // stays with it.
        coreState.setConversationId(500)
        advanceUntilIdle()
        assertThat(vm.state.value.conversationId).isEqualTo(500)
        assertThat(vm.state.value.interactionMarker!!.conversationId).isEqualTo(500)
        assertThat(vm.state.value.showInteractionMarker).isTrue()
    }
}
