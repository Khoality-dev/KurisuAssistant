package com.kurisu.assistant.ui.conversations

import android.app.Application
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.ConversationLastMessage
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
 * The Chats list.
 *
 * These also carry what the deleted `HomeViewModelTest` was covering —
 * row ordering and the wake word — restated against the shape that replaced it:
 * rows are CONVERSATIONS, not one row per persona.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ConversationsViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var personaRepo: PersonaRepository
    private lateinit var assistantRepo: AssistantRepository
    private lateinit var convRepo: ConversationRepository
    private lateinit var prefs: PreferencesDataStore
    private lateinit var updateRepo: UpdateRepository
    private lateinit var application: Application
    private lateinit var coreState: CoreState

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        personaRepo = mockk(relaxed = true)
        assistantRepo = mockk(relaxed = true)
        convRepo = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        updateRepo = mockk(relaxed = true)
        application = mockk(relaxed = true)
        coreState = CoreState()

        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { personaRepo.listPersonas() } returns emptyList()
        coEvery { personaRepo.getImageUrl(any(), any()) } answers {
            "${firstArg<String>().trimEnd('/')}/images/${secondArg<String>()}"
        }
        coEvery { assistantRepo.getAssistant() } returns makeAssistant()
        coEvery { convRepo.getConversations() } returns emptyList()
        coEvery { updateRepo.checkForUpdate() } returns null
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makePersona(id: Int, name: String, avatarUuid: String? = null) =
        Persona(id = id, name = name, avatarUuid = avatarUuid)

    /**
     * One assistant per user owns the wake word and the default persona. A
     * persona owns neither — that is the whole point of the split.
     */
    private fun makeAssistant(triggerWord: String? = null, defaultPersonaId: Int? = null) =
        Assistant(id = 1, triggerWord = triggerWord, defaultPersonaId = defaultPersonaId)

    private fun conversation(
        id: Int,
        title: String = "Chat $id",
        personaId: Int? = null,
        lastMessageAt: String? = null,
        lastMessage: String = "hello",
        updatedAt: String = "2024-01-01T00:00:00Z",
    ) = Conversation(
        id = id,
        title = title,
        updatedAt = updatedAt,
        personaId = personaId,
        lastMessage = lastMessageAt?.let {
            ConversationLastMessage(content = lastMessage, role = "assistant", createdAt = it)
        },
    )

    private fun newViewModel() = ConversationsViewModel(
        application, personaRepo, assistantRepo, convRepo, prefs, coreState, updateRepo,
    )

    @Test
    fun `rows are conversations, newest activity first`() = runTest {
        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 100, lastMessageAt = "2024-01-01T00:00:00Z"),
            conversation(id = 200, lastMessageAt = "2024-06-01T00:00:00Z"),
            conversation(id = 300, lastMessageAt = "2024-03-01T00:00:00Z"),
        )

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.rows.map { it.id }).containsExactly(200, 300, 100).inOrder()
        assertThat(vm.state.value.isLoading).isFalse()
    }

    @Test
    fun `a conversation with no messages sorts on its updated timestamp`() = runTest {
        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 100, lastMessageAt = "2024-01-01T00:00:00Z"),
            conversation(id = 200, lastMessageAt = null, updatedAt = "2024-09-01T00:00:00Z"),
        )

        val vm = newViewModel()
        advanceUntilIdle()

        val rows = vm.state.value.rows
        assertThat(rows.map { it.id }).containsExactly(200, 100).inOrder()
        assertThat(rows[0].preview).isNull()
        assertThat(rows[0].timestamp).isEqualTo("2024-09-01T00:00:00Z")
    }

    @Test
    fun `a row is identified by the persona bound to the conversation`() = runTest {
        coEvery { personaRepo.listPersonas() } returns listOf(
            makePersona(1, "Kurisu"), makePersona(3, "Coach", avatarUuid = "abc"),
        )
        coEvery { assistantRepo.getAssistant() } returns makeAssistant(defaultPersonaId = 1)
        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 414, personaId = 3, lastMessageAt = "2024-06-01T00:00:00Z"),
        )

        val vm = newViewModel()
        advanceUntilIdle()

        val row = vm.state.value.rows.single()
        assertThat(row.personaName).isEqualTo("Coach")
        assertThat(row.avatarUrl).isEqualTo("https://example.test/images/abc")
    }

    @Test
    fun `an unbound conversation names the assistant's default persona`() = runTest {
        // The backend binds a conversation on its first message, so "unbound"
        // means "the default will answer" — which is what the row must say.
        coEvery { personaRepo.listPersonas() } returns listOf(
            makePersona(1, "Kurisu"), makePersona(3, "Coach"),
        )
        coEvery { assistantRepo.getAssistant() } returns makeAssistant(defaultPersonaId = 3)
        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 500, personaId = null, lastMessageAt = "2024-06-01T00:00:00Z"),
        )

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.rows.single().personaName).isEqualTo("Coach")
    }

    @Test
    fun `losing the assistant does not lose the list`() = runTest {
        coEvery { assistantRepo.getAssistant() } throws IllegalStateException("boom")
        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 100, lastMessageAt = "2024-06-01T00:00:00Z"),
        )

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.rows).hasSize(1)
        assertThat(vm.state.value.error).isNull()
        assertThat(vm.state.value.triggerWord).isNull()
    }

    @Test
    fun `a failed list surfaces an error and a retry reloads`() = runTest {
        coEvery { convRepo.getConversations() } throws IllegalStateException("offline")

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.error).isEqualTo("offline")
        assertThat(vm.state.value.isLoading).isFalse()
        assertThat(vm.state.value.rows).isEmpty()

        coEvery { convRepo.getConversations() } returns listOf(
            conversation(id = 100, lastMessageAt = "2024-06-01T00:00:00Z"),
        )
        vm.load()
        advanceUntilIdle()

        assertThat(vm.state.value.error).isNull()
        assertThat(vm.state.value.rows).hasSize(1)
    }

    @Test
    fun `an empty account settles on an empty list, not a spinner`() = runTest {
        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.rows).isEmpty()
        assertThat(vm.state.value.isLoading).isFalse()
        assertThat(vm.state.value.error).isNull()
    }

    @Test
    fun `opening a row publishes its conversation id`() = runTest {
        val vm = newViewModel()
        advanceUntilIdle()

        vm.openConversation(418)

        assertThat(coreState.state.value.conversationId).isEqualTo(418)
    }

    @Test
    fun `new chat drops the resumable conversation and picks nobody`() = runTest {
        // Decision: a new chat SILENTLY takes assistants.default_persona_id.
        // There is no picker, so nothing here selects a persona — it only makes
        // sure a stale conversation is not resumed instead.
        coEvery { personaRepo.listPersonas() } returns listOf(
            makePersona(1, "Kurisu"), makePersona(3, "Coach"),
        )
        coEvery { assistantRepo.getAssistant() } returns makeAssistant(defaultPersonaId = 3)

        val vm = newViewModel()
        advanceUntilIdle()
        coreState.setConversationId(421)

        vm.startNewChat()
        advanceUntilIdle()

        assertThat(coreState.state.value.conversationId).isNull()
        coVerify(exactly = 1) { personaRepo.clearConversationIdForPersona(3) }
    }

    @Test
    fun `new chat only navigates once the stale conversation is gone`() = runTest {
        // The chat screen reads the cached conversation id as it loads. If the
        // FAB navigated first, the new chat could resume the old conversation.
        coEvery { personaRepo.listPersonas() } returns listOf(makePersona(3, "Coach"))
        coEvery { assistantRepo.getAssistant() } returns makeAssistant(defaultPersonaId = 3)

        val vm = newViewModel()
        advanceUntilIdle()
        coreState.setConversationId(421)

        var conversationIdWhenNavigated: Int? = 421
        var navigated = false
        vm.startNewChat {
            navigated = true
            conversationIdWhenNavigated = coreState.state.value.conversationId
        }

        assertThat(navigated).isFalse()

        advanceUntilIdle()

        assertThat(navigated).isTrue()
        assertThat(conversationIdWhenNavigated).isNull()
        coVerify(exactly = 1) { personaRepo.clearConversationIdForPersona(3) }
    }

    @Test
    fun `the wake word opens the chat and names no persona`() = runTest {
        coEvery { personaRepo.listPersonas() } returns listOf(
            makePersona(42, "Kurisu"), makePersona(7, "Amadeus"),
        )
        coEvery { assistantRepo.getAssistant() } returns
            makeAssistant(triggerWord = "kurisu", defaultPersonaId = 7)

        val vm = newViewModel()
        advanceUntilIdle()

        vm.wakeWord.test {
            coreState.emitTranscript("hey Kurisu, what's up")
            assertThat(awaitItem()).isEqualTo("hey Kurisu, what's up")
        }
    }

    @Test
    fun `a persona name is not a wake word`() = runTest {
        // The trigger word is assistant-level and selects nobody. Saying another
        // persona's name must not wake anything.
        coEvery { personaRepo.listPersonas() } returns listOf(
            makePersona(42, "Kurisu"), makePersona(7, "Amadeus"),
        )
        coEvery { assistantRepo.getAssistant() } returns
            makeAssistant(triggerWord = "kurisu", defaultPersonaId = 7)

        val vm = newViewModel()
        advanceUntilIdle()

        vm.wakeWord.test {
            coreState.emitTranscript("Amadeus, help me")
            expectNoEvents()
        }
    }

    @Test
    fun `an assistant with no wake word never matches`() = runTest {
        coEvery { personaRepo.listPersonas() } returns listOf(makePersona(1, "Neutral"))
        coEvery { assistantRepo.getAssistant() } returns
            makeAssistant(triggerWord = null, defaultPersonaId = 1)

        val vm = newViewModel()
        advanceUntilIdle()

        vm.wakeWord.test {
            coreState.emitTranscript("Neutral, help me")
            expectNoEvents()
        }
    }

    @Test
    fun `the wake word is shown so the user knows what to say`() = runTest {
        coEvery { assistantRepo.getAssistant() } returns makeAssistant(triggerWord = "kurisu")

        val vm = newViewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.triggerWord).isEqualTo("kurisu")
    }

    @Test
    fun `dismissUpdate clears the in-app update state`() = runTest {
        // The in-app updater came off the dead Home screen; this screen is now
        // its only live call site.
        val vm = newViewModel()
        advanceUntilIdle()

        vm.dismissUpdate()

        assertThat(vm.state.value.updateRelease).isNull()
        assertThat(vm.state.value.updateProgress).isNull()
        assertThat(vm.state.value.updateApkFile).isNull()
    }
}
