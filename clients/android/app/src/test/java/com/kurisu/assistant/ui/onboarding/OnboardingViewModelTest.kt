package com.kurisu.assistant.ui.onboarding

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.DriveFiles
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.VoiceInfo
import com.kurisu.assistant.data.repository.OnboardingRepository
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.drive.UploadSource
import com.kurisu.assistant.domain.onboarding.OnboardingStep
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.InputStream

/** The onboarding screen's state (#342); the finish rules themselves are `OnboardingRunTest`'s. */
@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: OnboardingRepository
    private lateinit var tts: TtsRepository
    private lateinit var queue: TtsQueueManager
    private lateinit var files: DriveFiles
    private lateinit var core: CoreState
    private val patches = mutableListOf<JsonObject>()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        tts = mockk(relaxed = true)
        queue = mockk(relaxed = true)
        files = mockk(relaxed = true)
        core = mockk(relaxed = true)
        coEvery { repo.models() } returns ModelsResponse(emptyList())
        coEvery { tts.listVoices(any()) } returns listOf(VoiceInfo("kurisu_ja_01", "Kurisu (Japanese)", "gpt-sovits"))
        coEvery { repo.createPersona(any()) } answers { Persona(id = 7, name = firstArg<com.kurisu.assistant.data.model.PersonaCreate>().name) }
        coEvery { repo.patchAssistant(capture(patches)) } returns Unit
        every { files.source(any()) } returns object : UploadSource {
            override val name = "kurisu.vrm"
            override val size: Long = 3
            override fun open(): InputStream = "glb".byteInputStream()
        }
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.viewModel() = OnboardingViewModel(repo, tts, queue, files, core).also { advanceUntilIdle() }

    private fun TestScope.events(vm: OnboardingViewModel): List<OnboardingEvent> {
        val seen = mutableListOf<OnboardingEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.events.collect { seen += it } }
        return seen
    }

    @Test
    fun `a provider set up earlier is already connected, with its first model picked`() = runTest(dispatcher) {
        coEvery { repo.models() } returns ModelsResponse(listOf(ModelInfo("qwen3:8b", "ollama")))
        val vm = viewModel()
        assertThat(vm.state.value.models).containsExactly(ModelInfo("qwen3:8b", "ollama"))
        assertThat(vm.state.value.model).isEqualTo(ModelInfo("qwen3:8b", "ollama"))
    }

    @Test
    fun `connecting lists the provider's models and picks the first`() = runTest(dispatcher) {
        val vm = viewModel()
        coEvery { repo.models() } returns ModelsResponse(listOf(ModelInfo("test-model", "ollama")))
        vm.setProviderValue("http://192.168.1.20:11434")
        vm.connect()
        advanceUntilIdle()
        coVerify { repo.patchProfile(JsonObject(mapOf("ollama_url" to JsonPrimitive("http://192.168.1.20:11434")))) }
        assertThat(vm.state.value.model).isEqualTo(ModelInfo("test-model", "ollama"))
        assertThat(vm.state.value.providerProblem).isNull()
    }

    @Test
    fun `a persona needs a name, and without one the voice and character steps are skipped`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.next()
        assertThat(vm.state.value.step).isEqualTo(OnboardingStep.PERSONA)
        assertThat(vm.state.value.canGoOn).isFalse()
        vm.setWithPersona(false)
        assertThat(vm.state.value.canGoOn).isTrue()
        vm.next()
        assertThat(vm.state.value.step).isEqualTo(OnboardingStep.WAKE_WORD)
        assertThat(vm.state.value.wakeWord).isEmpty()
        assertThat(vm.state.value.isLast).isTrue()
    }

    @Test
    fun `the wake word starts as the persona's name until the user types one`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.next()
        vm.setName("Kurisu")
        vm.next(); vm.next()
        vm.setWantsModel(false)
        vm.next()
        assertThat(vm.state.value.step).isEqualTo(OnboardingStep.WAKE_WORD)
        assertThat(vm.state.value.wakeWord).isEqualTo("Kurisu")

        vm.setWakeWord("Hey you")
        vm.back(); vm.next()
        assertThat(vm.state.value.wakeWord).isEqualTo("Hey you")
    }

    @Test
    fun `a 3D model needs its file before the next step`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.next(); vm.setName("Kurisu"); vm.next(); vm.next()
        assertThat(vm.state.value.step).isEqualTo(OnboardingStep.CHARACTER)
        assertThat(vm.state.value.canGoOn).isFalse()
        vm.pickVrm("content://picked/kurisu.vrm")
        assertThat(vm.state.value.vrmName).isEqualTo("kurisu.vrm")
        assertThat(vm.state.value.canGoOn).isTrue()
    }

    @Test
    fun `finishing writes it all, opens a new chat and says so`() = runTest(dispatcher) {
        val vm = viewModel()
        val seen = events(vm)
        vm.next()
        vm.setName("Kurisu")
        vm.next()
        vm.pickVoice("kurisu_ja_01")
        vm.next()
        vm.setWantsModel(false)
        vm.next()
        vm.finish()
        advanceUntilIdle()

        assertThat(patches.single()).isEqualTo(
            JsonObject(mapOf("selected_persona_id" to JsonPrimitive(7), "trigger_word" to JsonPrimitive("Kurisu"))),
        )
        coVerify { repo.patchProfile(JsonObject(mapOf("onboarded" to JsonPrimitive(true)))) }
        verify { core.setConversationId(null) }
        assertThat(seen).containsExactly(OnboardingEvent.Finished)
    }

    @Test
    fun `a failure is said, and trying again goes on`() = runTest(dispatcher) {
        coEvery { repo.patchAssistant(any()) } throws java.io.IOException("offline") andThen Unit
        val vm = viewModel()
        val seen = events(vm)
        vm.next(); vm.setWithPersona(false); vm.next()
        vm.finish()
        advanceUntilIdle()
        assertThat(vm.state.value.error).isNotNull()
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
