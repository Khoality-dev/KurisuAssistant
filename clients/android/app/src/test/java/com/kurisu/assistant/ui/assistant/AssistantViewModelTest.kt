package com.kurisu.assistant.ui.assistant

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.SubAgent
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.model.ToolFunction
import com.kurisu.assistant.data.model.ToolsResponse
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.SubAgentRepository
import com.kurisu.assistant.data.repository.ToolsRepository
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
    private lateinit var personaRepo: PersonaRepository
    private lateinit var subAgentRepo: SubAgentRepository
    private lateinit var toolsRepo: ToolsRepository
    private lateinit var prefs: PreferencesDataStore

    /** Every body the view model sent to `PATCH /assistant`, in order. */
    private val patches = mutableListOf<AssistantUpdate>()

    private val assistant = Assistant(
        id = 1,
        modelName = "qwen3:8b",
        providerType = "ollama",
        availableTools = null,
        think = false,
        memory = "Kho works in Europe/Berlin.",
        memoryEnabled = true,
        triggerWord = "kurisu",
        defaultPersonaId = 7,
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
        personaRepo = mockk(relaxed = true)
        subAgentRepo = mockk(relaxed = true)
        toolsRepo = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        patches.clear()

        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { assistantRepo.getAssistant() } returns assistant
        coEvery { assistantRepo.listModels() } returns listOf(
            ModelInfo("qwen3:8b", "ollama"),
            ModelInfo("gemini-2.0-flash", "gemini"),
        )
        coEvery { subAgentRepo.listSubAgents() } returns emptyList()
        coEvery { toolsRepo.listTools() } returns ToolsResponse(
            mcpTools = listOf(tool("mail.search")),
            builtinTools = listOf(tool("web_search"), tool("read_file")),
        )
        coEvery { personaRepo.getPersona(7) } returns Persona(id = 7, name = "Kurisu")
        coEvery { assistantRepo.updateAssistant(any()) } answers {
            patches += firstArg<AssistantUpdate>()
            assistant
        }
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun tool(name: String) =
        Tool(type = "function", function = ToolFunction(name = name, description = ""))

    private fun httpError(code: Int, detail: String) = HttpException(
        Response.error<Any>(
            code,
            """{"detail":"$detail"}""".toResponseBody("application/json".toMediaType()),
        )
    )

    private fun viewModel() = AssistantViewModel(
        assistantRepository = assistantRepo,
        personaRepository = personaRepo,
        subAgentRepository = subAgentRepo,
        toolsRepository = toolsRepo,
        prefs = prefs,
    )

    @Test
    fun `loads the assistant, its default persona and its sub-agents`() = runTest {
        coEvery { subAgentRepo.listSubAgents() } returns listOf(
            SubAgent(id = 4, name = "code-reader", modelName = "qwen2.5-coder:7b")
        )
        val vm = viewModel()
        advanceUntilIdle()

        val s = vm.state.value
        assertThat(s.isLoading).isFalse()
        assertThat(s.assistant?.modelName).isEqualTo("qwen3:8b")
        assertThat(s.defaultPersona?.name).isEqualTo("Kurisu")
        assertThat(s.subAgents.map { it.name }).containsExactly("code-reader")
        // Built-in and MCP tools land in one list, sorted, for the picker.
        assertThat(s.allToolNames).containsExactly("mail.search", "read_file", "web_search").inOrder()
    }

    @Test
    fun `think, tools and memory all patch the one assistant, never a persona`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(true)
        advanceUntilIdle()
        vm.openToolPicker()
        vm.toggleToolDraft("read_file")
        vm.saveTools()
        advanceUntilIdle()
        vm.setMemoryEnabled(false)
        advanceUntilIdle()

        assertThat(patches).hasSize(3)
        // No capability edit is allowed to leak onto a persona: that is exactly
        // what the old per-"main agent" model did.
        coVerify(exactly = 0) { personaRepo.updatePersona(any(), any()) }
        coVerify(exactly = 0) { personaRepo.createPersona(any()) }
        coVerify(exactly = 0) { personaRepo.deletePersona(any()) }
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

        vm.openToolPicker()
        vm.toggleToolDraft("read_file")
        vm.saveTools()
        advanceUntilIdle()
        assertThat(keysOf(patches.last())).containsExactly("available_tools")
    }

    @Test
    fun `the provider travels with the model, because they describe one choice`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setModel(ModelInfo("gemini-2.0-flash", "gemini"))
        advanceUntilIdle()

        assertThat(keysOf(patches.last())).containsExactly("model_name", "provider_type")
        assertThat(patches.last().providerType).isEqualTo("gemini")
    }

    @Test
    fun `setting a value it already has sends nothing`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.setThink(false)
        vm.setMemoryEnabled(true)
        vm.setModel(ModelInfo("qwen3:8b", "ollama"))
        advanceUntilIdle()

        assertThat(patches).isEmpty()
    }

    @Test
    fun `every tool opens the picker with everything selected`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()
        assertThat(vm.state.value.usesEveryTool).isTrue()
        assertThat(vm.state.value.toolsSummary).isEqualTo("Every tool")

        vm.openToolPicker()

        assertThat(vm.state.value.toolDraft)
            .containsExactly("mail.search", "read_file", "web_search")
    }

    @Test
    fun `turning one tool off pins the assistant to an explicit list`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openToolPicker()
        vm.toggleToolDraft("mail.search")
        vm.saveTools()
        advanceUntilIdle()

        assertThat(patches.last().availableTools)
            .containsExactly("read_file", "web_search").inOrder()
        assertThat(vm.state.value.toolPickerOpen).isFalse()
    }

    @Test
    fun `clearing every tool sends an empty list, which is not the same as absent`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openToolPicker()
        vm.clearToolDrafts()
        vm.saveTools()
        advanceUntilIdle()

        assertThat(patches.last().availableTools).isEmpty()
        assertThat(keysOf(patches.last())).containsExactly("available_tools")
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
    fun `an assistant with no default persona still loads`() = runTest {
        coEvery { assistantRepo.getAssistant() } returns assistant.copy(defaultPersonaId = null)
        val vm = viewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.defaultPersona).isNull()
        assertThat(vm.state.value.loadError).isNull()
        coVerify(exactly = 0) { personaRepo.getPersona(any()) }
    }

    // ─── Sub-agents ───────────────────────────────────────────────────

    @Test
    fun `a sub-agent needs a name and a model`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewSubAgent()
        vm.saveSubAgent()
        advanceUntilIdle()
        assertThat(vm.state.value.message).isEqualTo("Name is required")

        vm.setSubDraftName("summarizer")
        vm.setSubDraftModelName("  ")
        vm.saveSubAgent()
        advanceUntilIdle()
        assertThat(vm.state.value.message).isEqualTo("Model is required")

        coVerify(exactly = 0) { subAgentRepo.createSubAgent(any()) }
    }

    @Test
    fun `a new sub-agent defaults to the assistant's model`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewSubAgent()

        assertThat(vm.state.value.subDraftModelName).isEqualTo("qwen3:8b")
        assertThat(vm.state.value.editingSubAgent).isNull()
    }

    @Test
    fun `creating a sub-agent never touches the assistant`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewSubAgent()
        vm.setSubDraftName("  summarizer  ")
        vm.saveSubAgent()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            subAgentRepo.createSubAgent(match { it.name == "summarizer" })
        }
        // A worker gaining a model must not repoint the assistant at it.
        assertThat(patches).isEmpty()
        assertThat(vm.state.value.subEditorOpen).isFalse()
    }

    @Test
    fun `deleting a sub-agent surfaces the reason when the server refuses`() = runTest {
        val subAgent = SubAgent(id = 4, name = "code-reader", modelName = "m")
        coEvery { subAgentRepo.deleteSubAgent(4) } throws httpError(400, "Still referenced.")
        val vm = viewModel()
        advanceUntilIdle()

        vm.confirmDeleteSubAgent(subAgent)
        vm.deleteSubAgent()
        advanceUntilIdle()

        assertThat(vm.state.value.message).isEqualTo("Still referenced.")
        assertThat(vm.state.value.deletingSubAgent).isNull()
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
