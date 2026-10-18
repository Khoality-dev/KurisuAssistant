package com.kurisu.assistant.ui.onboarding

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.repository.OnboardingRepository
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test

/** The onboarding screen's state (#342, #376); the finish rules themselves are `OnboardingRunTest`'s. */
@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: OnboardingRepository
    private lateinit var core: CoreState
    private val patches = mutableListOf<JsonObject>()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        core = mockk(relaxed = true)
        coEvery { repo.models() } returns ModelsResponse(emptyList())
        coEvery { repo.patchAssistant(capture(patches)) } returns Unit
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.viewModel() = OnboardingViewModel(repo, core).also { advanceUntilIdle() }

    private fun TestScope.events(vm: OnboardingViewModel): List<OnboardingEvent> {
        val seen = mutableListOf<OnboardingEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.events.collect { seen += it } }
        return seen
    }

    private fun TestScope.connected(): OnboardingViewModel {
        val vm = viewModel()
        coEvery { repo.models() } returns ModelsResponse(listOf(ModelInfo("test-model", "ollama")))
        vm.setProviderValue("http://192.168.1.20:11434")
        vm.connect()
        advanceUntilIdle()
        return vm
    }

    @Test
    fun `a provider set up earlier is already connected, with its first model picked`() = runTest(dispatcher) {
        coEvery { repo.models() } returns ModelsResponse(listOf(ModelInfo("qwen3:8b", "ollama")))
        val vm = viewModel()
        assertThat(vm.state.value.models).containsExactly(ModelInfo("qwen3:8b", "ollama"))
        assertThat(vm.state.value.model).isEqualTo(ModelInfo("qwen3:8b", "ollama"))
        assertThat(vm.state.value.canFinish).isTrue()
    }

    @Test
    fun `connecting lists the provider's models and picks the first`() = runTest(dispatcher) {
        val vm = viewModel()
        assertThat(vm.state.value.canFinish).isFalse()
        coEvery { repo.models() } returns ModelsResponse(listOf(ModelInfo("test-model", "ollama")))
        vm.setProviderValue("http://192.168.1.20:11434")
        vm.connect()
        advanceUntilIdle()
        coVerify { repo.patchProfile(JsonObject(mapOf("ollama_url" to JsonPrimitive("http://192.168.1.20:11434")))) }
        assertThat(vm.state.value.model).isEqualTo(ModelInfo("test-model", "ollama"))
        assertThat(vm.state.value.providerProblem).isNull()
        assertThat(vm.state.value.canFinish).isTrue()
    }

    @Test
    fun `a cloud provider asks for its key, and offers only its own models`() = runTest(dispatcher) {
        val vm = connected()
        vm.setProvider("gemini")
        assertThat(vm.state.value.provider.input).isEqualTo("API key")
        assertThat(vm.state.value.providerValue).isEmpty()
        // The Ollama model is not the one Start chatting would save under Gemini.
        assertThat(vm.state.value.providerModels).isEmpty()
        assertThat(vm.state.value.model).isNull()
        assertThat(vm.state.value.canFinish).isFalse()

        vm.setProvider("ollama")
        assertThat(vm.state.value.model).isEqualTo(ModelInfo("test-model", "ollama"))
    }

    @Test
    fun `finishing saves only the model, opens a new chat and says so`() = runTest(dispatcher) {
        val vm = connected()
        val seen = events(vm)
        vm.finish()
        advanceUntilIdle()

        assertThat(patches.single()).isEqualTo(
            JsonObject(mapOf("model_name" to JsonPrimitive("test-model"), "provider_type" to JsonPrimitive("ollama"))),
        )
        coVerify { repo.patchProfile(JsonObject(mapOf("onboarded" to JsonPrimitive(true)))) }
        verify { core.setConversationId(null) }
        assertThat(seen).containsExactly(OnboardingEvent.Finished)
    }

    @Test
    fun `a failure is said, and trying again goes on`() = runTest(dispatcher) {
        val vm = connected()
        coEvery { repo.patchAssistant(any()) } throws java.io.IOException("offline") andThen Unit
        val seen = events(vm)
        vm.finish()
        advanceUntilIdle()
        assertThat(vm.state.value.error).isNotNull()
        assertThat(vm.state.value.finishing).isFalse()
        assertThat(seen).isEmpty()

        vm.finish()
        advanceUntilIdle()
        assertThat(seen).containsExactly(OnboardingEvent.Finished)
    }

    @Test
    fun `skipping is asked first and keeps nothing`() = runTest(dispatcher) {
        val vm = viewModel()
        val seen = events(vm)
        vm.askSkip()
        assertThat(vm.state.value.confirmSkip).isTrue()
        vm.skip()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.patchProfile(JsonObject(mapOf("onboarded" to JsonPrimitive(true)))) }
        coVerify(exactly = 0) { repo.patchAssistant(any()) }
        assertThat(seen).containsExactly(OnboardingEvent.Skipped)
    }
}
