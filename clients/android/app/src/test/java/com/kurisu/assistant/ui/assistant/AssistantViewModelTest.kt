package com.kurisu.assistant.ui.assistant

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.repository.AssistantRepository
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * The Assistant screen edits ONE row.
 *
 * The screen it replaces listed "main agents", each carrying its own model,
 * tools, wake word and memory, and saving one wrote a persona AND the assistant
 * in the same breath. Under wire protocol 4 capability is the assistant's alone,
 * so these tests pin two things: every capability control lands on
 * `PATCH /assistant`, and none of them touches a persona.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AssistantViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var assistantRepo: AssistantRepository

    /** Every body the view model sent to `PATCH /assistant`, in order. */
    private val patches = mutableListOf<AssistantUpdate>()

    private val assistant = Assistant(
        id = 1,
        modelName = "qwen3:8b",
        providerType = "ollama",
        think = false,
        memory = "Kho works in Europe/Berlin.",
        memoryEnabled = true,
        triggerWord = "kurisu",
        selectedPersonaId = 7,
    )

    // Same configuration as NetworkModule.provideJson(), so "which keys go on the
    // wire" is answered by the real serializer rather than by inspection.
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private fun keysOf(update: AssistantUpdate): Set<String> =
        (json.parseToJsonElement(json.encodeToString(AssistantUpdate.serializer(), update))
            as JsonObject).keys

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        assistantRepo = mockk(relaxed = true)
        patches.clear()

        coEvery { assistantRepo.getAssistant() } returns assistant
        coEvery { assistantRepo.listModels() } returns listOf(
            ModelInfo("qwen3:8b", "ollama"),
            ModelInfo("gemini-2.0-flash", "gemini"),
        )
        coEvery { assistantRepo.updateAssistant(any()) } answers {
            patches += firstArg<AssistantUpdate>()
            assistant
        }
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun httpError(code: Int, detail: String) = HttpException(
        Response.error<Any>(
            code,
            """{"detail":"$detail"}""".toResponseBody("application/json".toMediaType()),
        )
    )

    private fun viewModel() = AssistantViewModel(
        assistantRepository = assistantRepo,
    )

    @Test
    fun `loads the assistant`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        val s = vm.state.value
        assertThat(s.isLoading).isFalse()
        assertThat(s.assistant?.modelName).isEqualTo("qwen3:8b")
    }

    @Test
    fun `think and memory both patch the one assistant, never a persona`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        advanceUntilIdle()
        vm.setMemoryEnabled(false)
        advanceUntilIdle()

        assertThat(patches).hasSize(2)
        // No capability edit is allowed to leak onto a persona: that is exactly
        // what the old per-"main agent" model did. Since #197 the view model has
        // no persona repository to leak through at all, so "never a persona" is
        // a fact about its constructor rather than something to verify here.
        assertThat(patches.flatMap { keysOf(it) }).containsNoneOf("name", "system_prompt", "voice_reference")
    }

    @Test
    fun `each edit sends only the field it changed`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        advanceUntilIdle()
        assertThat(keysOf(patches.last())).containsExactly("think")

        vm.setMemoryEnabled(false)
        advanceUntilIdle()
        assertThat(keysOf(patches.last())).containsExactly("memory_enabled")
    }

    @Test
    fun `setting a value it already has sends nothing`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(false)
        vm.setMemoryEnabled(true)
        advanceUntilIdle()

        assertThat(patches).isEmpty()
    }

    @Test
    fun `there is no tool list to pick from`() {
        // Every tool is always available (#360); how much runs without asking is
        // the permission mode beside the chat input, not a list here.
        val names = AssistantUiState::class.java.declaredFields.map { it.name }
        assertThat(names.filter { it.contains("tool", ignoreCase = true) }).isEmpty()
    }

    @Test
    fun `the wake word is the assistant's and clears as blank, not as an omitted null`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openTriggerEditor()
        assertThat(vm.state.value.triggerDraft).isEqualTo("kurisu")

        vm.setTriggerDraft("  ")
        vm.saveTriggerWord()
        advanceUntilIdle()

        // A null would be dropped by @EncodeDefault(NEVER) and the wake word
        // would silently survive; "" round-trips and reads as unset.
        assertThat(keysOf(patches.last())).containsExactly("trigger_word")
        assertThat(patches.last().triggerWord).isEmpty()
    }

    @Test
    fun `a rejected edit explains itself and leaves the switch where it was`() = runTest {
        coEvery { assistantRepo.updateAssistant(any()) } throws
            httpError(400, "'think' cannot be null.")
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        advanceUntilIdle()

        assertThat(vm.state.value.message).isEqualTo("'think' cannot be null.")
        // Nothing is applied optimistically, so the switch snaps back rather
        // than showing a state the server never accepted.
        assertThat(vm.state.value.assistant?.think).isFalse()
    }

    @Test
    fun `a failed load leaves an error the screen can retry from`() = runTest {
        coEvery { assistantRepo.getAssistant() } throws httpError(503, "Service unavailable")
        val vm = viewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.assistant).isNull()
        assertThat(vm.state.value.loadError).isEqualTo("Service unavailable")
        assertThat(vm.state.value.isLoading).isFalse()
    }

    @Test
    fun `the screen never sets the model or the selected persona`() = runTest {
        // Both moved off this page (#197): the model to the chat header, the
        // default persona to the Personas screen. Nothing here can send either
        // field, so a regression that brings a picker back has to add it to the
        // view model first — and fail this.
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        vm.setMemoryEnabled(false)
        advanceUntilIdle()

        val keys = patches.flatMap { keysOf(it) }.toSet()
        assertThat(keys).containsNoneOf("model_name", "provider_type", "selected_persona_id", "permission_mode")
    }

    @Test
    fun `there are no sub-agents to set up`() {
        // The assistant spawns a helper itself when it needs one (#354); the
        // screen has nothing to list, edit or delete.
        val names = AssistantUiState::class.java.declaredFields.map { it.name }
        assertThat(names.filter { it.contains("sub", ignoreCase = true) }).isEmpty()
    }

    @Test
    fun `an error with no detail body still says something useful`() = runTest {
        coEvery { assistantRepo.updateAssistant(any()) } throws RuntimeException("boom")
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        advanceUntilIdle()

        assertThat(vm.state.value.message).isEqualTo("boom")
    }
}
