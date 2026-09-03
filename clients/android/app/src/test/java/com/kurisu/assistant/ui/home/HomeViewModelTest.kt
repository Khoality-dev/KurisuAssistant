package com.kurisu.assistant.ui.home

import android.app.Application
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.ConversationLastMessage
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class HomeViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var agentRepo: AgentRepository
    private lateinit var convRepo: ConversationRepository
    private lateinit var prefs: PreferencesDataStore
    private lateinit var updateRepo: UpdateRepository
    private lateinit var application: Application
    private lateinit var coreState: CoreState

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        agentRepo = mockk(relaxed = true)
        convRepo = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        updateRepo = mockk(relaxed = true)
        application = mockk(relaxed = true)
        coreState = CoreState()

        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { agentRepo.loadAgents() } returns emptyList()
        coEvery { convRepo.getConversations() } returns emptyList()
        coEvery { agentRepo.getConversationIdForAgent(any()) } returns null
        coEvery { updateRepo.checkForUpdate() } returns null
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makeAgent(id: Int, name: String, triggerWord: String? = null) = Agent(
        id = id,
        name = name,
        description = "",
        systemPrompt = "",
        triggerWord = triggerWord,
    )

    @Test
    fun `sorts conversations with most recent last message first`() = runTest {
        val alice = makeAgent(1, "Alice")
        val bob = makeAgent(2, "Bob")
        val carol = makeAgent(3, "Carol")

        coEvery { agentRepo.loadAgents() } returns listOf(alice, bob, carol)
        coEvery { agentRepo.getConversationIdForAgent(1) } returns 100
        coEvery { agentRepo.getConversationIdForAgent(2) } returns 200
        coEvery { agentRepo.getConversationIdForAgent(3) } returns null
        coEvery { convRepo.getConversations() } returns listOf(
            Conversation(id = 100, lastMessage = ConversationLastMessage(
                content = "older", role = "assistant", createdAt = "2024-01-01T00:00:00",
            )),
            Conversation(id = 200, lastMessage = ConversationLastMessage(
                content = "newer", role = "assistant", createdAt = "2024-06-01T00:00:00",
            )),
        )

        val vm = HomeViewModel(application, agentRepo, convRepo, prefs, coreState, updateRepo)
        advanceUntilIdle()

        val conversations = vm.state.value.conversations
        assertThat(conversations).hasSize(3)
        assertThat(conversations[0].agent.name).isEqualTo("Bob")   // newest
        assertThat(conversations[1].agent.name).isEqualTo("Alice") // older
        assertThat(conversations[2].agent.name).isEqualTo("Carol") // no conversation
        assertThat(conversations[2].lastMessage).isNull()
    }

    @Test
    fun `trigger match emits when transcript contains any agent trigger word`() = runTest {
        val agent = makeAgent(42, "Kurisu", triggerWord = "kurisu")
        coEvery { agentRepo.loadAgents() } returns listOf(agent)

        val vm = HomeViewModel(application, agentRepo, convRepo, prefs, coreState, updateRepo)
        advanceUntilIdle()

        vm.triggerMatch.test {
            coreState.emitTranscript("hey Kurisu, what's up")
            val match = awaitItem()
            assertThat(match.agentId).isEqualTo(42)
            assertThat(match.text).isEqualTo("hey Kurisu, what's up")
        }
    }

    @Test
    fun `no trigger match for transcript without any trigger word`() = runTest {
        val agent = makeAgent(1, "Kurisu", triggerWord = "kurisu")
        coEvery { agentRepo.loadAgents() } returns listOf(agent)

        val vm = HomeViewModel(application, agentRepo, convRepo, prefs, coreState, updateRepo)
        advanceUntilIdle()

        vm.triggerMatch.test {
            coreState.emitTranscript("what time is it")
            expectNoEvents()
        }
    }

    @Test
    fun `agents with null trigger word are ignored`() = runTest {
        val agent = makeAgent(1, "Neutral", triggerWord = null)
        coEvery { agentRepo.loadAgents() } returns listOf(agent)

        val vm = HomeViewModel(application, agentRepo, convRepo, prefs, coreState, updateRepo)
        advanceUntilIdle()

        vm.triggerMatch.test {
            coreState.emitTranscript("Neutral, help me")
            expectNoEvents()
        }
    }

    @Test
    fun `dismissUpdate clears update state`() = runTest {
        val vm = HomeViewModel(application, agentRepo, convRepo, prefs, coreState, updateRepo)
        advanceUntilIdle()
        vm.dismissUpdate()
        assertThat(vm.state.value.updateRelease).isNull()
        assertThat(vm.state.value.updateProgress).isNull()
        assertThat(vm.state.value.updateApkFile).isNull()
    }
}
