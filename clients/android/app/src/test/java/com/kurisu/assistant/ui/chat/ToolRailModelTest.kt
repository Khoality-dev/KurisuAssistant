package com.kurisu.assistant.ui.chat

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.Message
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

/**
 * The tool rail's rules, tested without a composition.
 *
 * `tool_kind` and `duration_ms` arrive only on the live stream, so the rail has
 * to read as honest both while the call is running and after a reload that has
 * neither field.
 */
class ToolRailModelTest {

    private fun toolMessage(
        name: String = "mail.search",
        status: String? = null,
        toolKind: String? = null,
        durationMs: Int? = null,
        modelName: String? = null,
        content: String = "",
    ) = Message(
        role = "tool",
        content = content,
        name = name,
        toolStatus = status,
        toolKind = toolKind,
        durationMs = durationMs,
        modelName = modelName,
    )

    @Test
    fun `a sub_agent call is tagged and names the model that ran it`() {
        val rail = ToolRailModel.from(
            toolMessage(
                name = "summarizer",
                status = "success",
                toolKind = "sub_agent",
                durationMs = 900,
                modelName = "qwen2.5:7b",
            ),
        )
        assertThat(rail.isSubAgent).isTrue()
        assertThat(rail.meta).isEqualTo("qwen2.5:7b · 0.9s")
        assertThat(rail.status).isEqualTo(ToolRunStatus.SUCCEEDED)
    }

    @Test
    fun `an ordinary tool is not tagged and does not repeat the assistant model`() {
        val rail = ToolRailModel.from(
            toolMessage(status = "success", toolKind = "tool", durationMs = 800, modelName = "gpt-4o-mini"),
        )
        assertThat(rail.isSubAgent).isFalse()
        // The model is the assistant's, identical on every row — it says nothing.
        assertThat(rail.meta).isEqualTo("0.8s")
    }

    @Test
    fun `a reloaded transcript has neither field and omits the tag and the timing`() {
        val rail = ToolRailModel.from(toolMessage(status = "success"))
        assertThat(rail.isSubAgent).isFalse()
        assertThat(rail.meta).isEmpty()
    }

    @Test
    fun `a call still in flight says so`() {
        val rail = ToolRailModel.from(toolMessage(status = null))
        assertThat(rail.status).isEqualTo(ToolRunStatus.RUNNING)
        assertThat(rail.meta).isEqualTo("running")
    }

    @Test
    fun `denied counts as failed, like an error`() {
        assertThat(ToolRailModel.from(toolMessage(status = "denied")).status)
            .isEqualTo(ToolRunStatus.FAILED)
        assertThat(ToolRailModel.from(toolMessage(status = "error")).status)
            .isEqualTo(ToolRunStatus.FAILED)
    }

    @Test
    fun `args render as key value pairs with the quotes stripped`() {
        val rail = ToolRailModel.from(
            toolMessage().copy(
                toolArgs = buildJsonObject {
                    put("query", JsonPrimitive("halden invoice"))
                    put("after", JsonPrimitive("2026-08-01"))
                },
            ),
        )
        assertThat(rail.args).isEqualTo("query: halden invoice, after: 2026-08-01")
    }

    @Test
    fun `durations round to a tenth and keep the decimal below a second`() {
        assertThat(formatToolDuration(800)).isEqualTo("0.8s")
        assertThat(formatToolDuration(2449)).isEqualTo("2.4s")
        assertThat(formatToolDuration(40)).isEqualTo("0.0s")
        assertThat(formatToolDuration(12000)).isEqualTo("12.0s")
    }
}
