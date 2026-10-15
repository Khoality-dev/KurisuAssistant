package com.kurisu.assistant.ui.settings

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.model.ToolFunction
import com.kurisu.assistant.data.model.ToolsResponse
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
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * A tool allowed by default (#353) — notify_user — runs without asking until
 * the user denies it. Tools & MCP lists it with a switch: on is no stored
 * policy, off stores a "deny".
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ToolsMcpPermissionTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repository: ToolsRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repository = mockk(relaxed = true)
        val notify = Tool(
            type = "function",
            function = ToolFunction(name = "notify_user", description = "", parameters = kotlinx.serialization.json.JsonObject(emptyMap())),
            builtIn = true,
            allowedByDefault = true,
        )
        coEvery { repository.listTools() } returns ToolsResponse(mcpTools = emptyList(), builtinTools = listOf(notify))
        coEvery { repository.listMCPServers() } returns emptyList()
        coEvery { repository.deniedTools() } returns setOf("notify_user")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `shows which default-allowed tools the user has denied`() = runTest(dispatcher) {
        val vm = ToolsMcpViewModel(repository)
        advanceUntilIdle()
        assertThat(vm.state.value.deniedTools).containsExactly("notify_user")
    }

    @Test
    fun `turning it back on removes the deny, and off stores one`() = runTest(dispatcher) {
        val vm = ToolsMcpViewModel(repository)
        advanceUntilIdle()
        vm.setToolAllowed("notify_user", true)
        advanceUntilIdle()
        assertThat(vm.state.value.deniedTools).isEmpty()
        coVerify { repository.setToolDenied("notify_user", false) }

        vm.setToolAllowed("notify_user", false)
        advanceUntilIdle()
        assertThat(vm.state.value.deniedTools).containsExactly("notify_user")
        coVerify { repository.setToolDenied("notify_user", true) }
    }
}
