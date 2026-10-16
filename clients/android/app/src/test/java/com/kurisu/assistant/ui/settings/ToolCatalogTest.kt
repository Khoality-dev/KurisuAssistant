package com.kurisu.assistant.ui.settings

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.model.ToolFunction
import com.kurisu.assistant.data.model.ToolsResponse
import com.kurisu.assistant.data.repository.ToolsRepository
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

/**
 * Tools & MCP lists what the assistant has (#360), as the desktop's Settings ›
 * Tools does: the server's own tools by feature, the user's MCP servers by
 * server, each tagged by whether it only looks — what Read only runs. A tool
 * that does not say counts as changing something, and nothing switches a tool
 * on or off.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ToolCatalogTest {

    private fun tool(name: String, readOnly: Boolean = false) =
        Tool(type = "function", function = ToolFunction(name = name, description = ""), readOnly = readOnly)

    private val response = ToolsResponse(
        serverTools = listOf(
            tool("calendar_list", true), tool("calendar_create"),
            tool("task_list", true), tool("task_start"),
            tool("drive_read", true), tool("drive_write"),
            tool("history_list", true), tool("recall_regex", true),
            tool("notify_user", true), tool("get_skill_instructions", true),
        ),
        mcpTools = listOf(tool("get_weather", true), tool("toggle")),
        mcpServers = mapOf("Weather" to listOf(tool("get_weather", true)), "Lights" to listOf(tool("toggle"))),
    )

    @Test
    fun `the server's own tools are grouped by feature`() {
        val catalog = ToolCatalog.from(response)
        assertThat(catalog.kurisu.map { it.name to it.tools.map { t -> t.name } }).containsExactly(
            "Calendar" to listOf("calendar_list", "calendar_create"),
            "Tasks" to listOf("task_list", "task_start"),
            "Kurisu Drive" to listOf("drive_read", "drive_write"),
            "History and recall" to listOf("history_list", "recall_regex"),
            "Other" to listOf("notify_user", "get_skill_instructions"),
        ).inOrder()
    }

    @Test
    fun `MCP tools are listed by server`() {
        val catalog = ToolCatalog.from(response)
        assertThat(catalog.mcp.map { it.name }).containsExactly("Weather", "Lights").inOrder()
    }

    @Test
    fun `each tool is tagged by whether it only looks`() {
        val catalog = ToolCatalog.from(response)
        val all = (catalog.kurisu + catalog.mcp).flatMap { it.tools }.associateBy { it.name }
        assertThat(all.getValue("drive_read").effect).isEqualTo(ToolEffect.READS)
        assertThat(all.getValue("drive_write").effect).isEqualTo(ToolEffect.CHANGES)
        assertThat(all.getValue("toggle").effect).isEqualTo(ToolEffect.CHANGES)
        assertThat(ToolEffect.READS.label).isEqualTo("Reads")
        assertThat(ToolEffect.CHANGES.label).isEqualTo("Changes")
    }

    @Test
    fun `an empty group is left out`() {
        val catalog = ToolCatalog.from(ToolsResponse(serverTools = listOf(tool("notify_user", true)), mcpTools = emptyList()))
        assertThat(catalog.kurisu.map { it.name }).containsExactly("Other")
        assertThat(catalog.mcp).isEmpty()
    }

    // ── The view model ──────────────────────────────────────────────

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repository: ToolsRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repository = mockk(relaxed = true)
        coEvery { repository.listTools() } returns response
        coEvery { repository.listMCPServers() } returns emptyList()
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `the screen loads the catalogue, and keeps nothing that turns a tool off`() = runTest(dispatcher) {
        val vm = ToolsMcpViewModel(repository)
        advanceUntilIdle()

        assertThat(vm.state.value.catalog.kurisu).isNotEmpty()
        val names = ToolsMcpUiState::class.java.declaredFields.map { it.name }
        assertThat(names.filter { it.contains("denied", ignoreCase = true) || it.contains("allowed", ignoreCase = true) }).isEmpty()
        val methods = ToolsMcpViewModel::class.java.declaredMethods.map { it.name }
        assertThat(methods).containsNoneOf("setToolAllowed", "toggleServerEnabled")
    }
}
