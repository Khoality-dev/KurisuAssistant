package com.kurisu.assistant.data.remote.websocket

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.ConnectedEvent
import com.kurisu.assistant.data.model.ContextInfoEvent
import com.kurisu.assistant.data.model.ConversationSwitchedEvent
import com.kurisu.assistant.data.model.DoneEvent
import com.kurisu.assistant.data.model.ErrorEvent
import com.kurisu.assistant.data.model.ServerEvent
import com.kurisu.assistant.data.model.StreamChunkEvent
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.data.model.ToolCallRequestEvent
import com.kurisu.assistant.data.model.VisionResultEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import kotlin.reflect.KClass

/**
 * Protocol-coverage guard for [parseServerEvent].
 *
 * Issue #92: the `when` in the parser silently dropped whole server event types, so a
 * backend that had moved on (a new conversation after compaction) or was waiting on us
 * (a client tool call) went unnoticed. Every server → client type in the backend's
 * `EventType` enum (backend/kurisuassistant/websocket/events.py) gets a row here; adding
 * one to the wire without adding it to the parser should fail this test.
 */
class WebSocketManagerTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    // ── Every server → client event type maps to its model ──────────────

    private data class Row(val type: String, val payload: String, val expected: KClass<out ServerEvent>)

    private val table = listOf(
        Row(
            "stream_chunk",
            """{"type":"stream_chunk","event_id":"e1","timestamp":"t","content":"hi","role":"assistant","conversation_id":7}""",
            StreamChunkEvent::class,
        ),
        Row(
            "done",
            """{"type":"done","event_id":"e3","timestamp":"t","conversation_id":7}""",
            DoneEvent::class,
        ),
        Row(
            "error",
            """{"type":"error","event_id":"e4","timestamp":"t","error":"boom","code":"INTERNAL_ERROR"}""",
            ErrorEvent::class,
        ),
        Row(
            "tool_approval_request",
            """{"type":"tool_approval_request","event_id":"e5","timestamp":"t","approval_id":"a1","tool_name":"shell","tool_args":{"cmd":"ls"},"risk_level":"high"}""",
            ToolApprovalRequestEvent::class,
        ),
        Row(
            "tool_call_request",
            """{"type":"tool_call_request","event_id":"e6","timestamp":"t","request_id":"r1","tool_name":"clipboard_read","tool_args":{}}""",
            ToolCallRequestEvent::class,
        ),
        Row(
            "vision_result",
            """{"type":"vision_result","event_id":"e7","timestamp":"t","faces":[],"gestures":[]}""",
            VisionResultEvent::class,
        ),
        Row(
            "connected",
            """{"type":"connected","event_id":"e8","timestamp":"t","chat_active":false,"conversation_id":7,"persona_id":4}""",
            ConnectedEvent::class,
        ),
        Row(
            "context_info",
            """{"type":"context_info","event_id":"e9","timestamp":"t","conversation_id":7,"compacting":true}""",
            ContextInfoEvent::class,
        ),
        Row(
            "conversation_switched",
            """{"type":"conversation_switched","event_id":"e10","timestamp":"t","old_conversation_id":7,"new_conversation_id":8,"compacted_context":"summary","persona_id":3}""",
            ConversationSwitchedEvent::class,
        ),
    )

    @Test
    fun `every known server event type parses to its model`() {
        for (row in table) {
            val event = parseServerEvent(row.payload)
            assertThat(event).isNotNull()
            assertThat(event!!::class).isEqualTo(row.expected)
            assertThat(event.type).isEqualTo(row.type)
        }
    }

    @Test
    fun `unknown event type returns null`() {
        val event = parseServerEvent("""{"type":"telepathy","event_id":"x","timestamp":"t"}""")
        assertThat(event).isNull()
    }

    @Test
    fun `frame without a type returns null`() {
        assertThat(parseServerEvent("""{"event_id":"x","timestamp":"t"}""")).isNull()
    }

    @Test
    fun `unknown fields on a known event do not break parsing`() {
        // The backend adds fields ahead of the client; ignoreUnknownKeys must hold.
        val event = parseServerEvent(
            """{"type":"done","event_id":"e","timestamp":"t","conversation_id":5,"brand_new_field":42}"""
        )
        assertThat(event).isInstanceOf(DoneEvent::class.java)
        assertThat((event as DoneEvent).conversationId).isEqualTo(5)
    }

    // ── Field-level contracts that issue #92 depends on ─────────────────

    @Test
    fun `conversation_switched carries the new conversation and persona`() {
        val event = parseServerEvent(table.first { it.type == "conversation_switched" }.payload)
                as ConversationSwitchedEvent
        assertThat(event.oldConversationId).isEqualTo(7)
        assertThat(event.newConversationId).isEqualTo(8)
        assertThat(event.compactedContext).isEqualTo("summary")
        // Wire protocol 4 renamed this from `agent_id`. It is NOT aliased: parsing
        // the old name would silently yield 0 and strand the new conversation
        // without a voice.
        assertThat(event.personaId).isEqualTo(3)
    }

    @Test
    fun `connected announces the persona bound to the conversation`() {
        val event = parseServerEvent(table.first { it.type == "connected" }.payload)
                as ConnectedEvent
        assertThat(event.conversationId).isEqualTo(7)
        assertThat(event.personaId).isEqualTo(4)
    }

    @Test
    fun `agent_switch is no longer a known event type`() {
        // Removed in wire protocol 4. It must fall through to the unknown branch
        // rather than being quietly modelled, or the protocol-gap warning never fires.
        assertThat(
            parseServerEvent("""{"type":"agent_switch","event_id":"e","timestamp":"t"}""")
        ).isNull()
    }

    @Test
    fun `tool_call_request carries the request id the backend keys its future on`() {
        val event = parseServerEvent(table.first { it.type == "tool_call_request" }.payload)
                as ToolCallRequestEvent
        assertThat(event.requestId).isEqualTo("r1")
        assertThat(event.toolName).isEqualTo("clipboard_read")
    }

    @Test
    fun `stream_chunk keeps snake_case wire names`() {
        val event = parseServerEvent(
            """{"type":"stream_chunk","event_id":"e","timestamp":"t","role":"assistant","content":"x","conversation_id":9,"persona_id":3,"persona_name":"Kurisu","tool_status":"success","token_count":120}"""
        ) as StreamChunkEvent
        assertThat(event.conversationId).isEqualTo(9)
        assertThat(event.personaId).isEqualTo(3)
        assertThat(event.personaName).isEqualTo("Kurisu")
        assertThat(event.toolStatus).isEqualTo("success")
        assertThat(event.tokenCount).isEqualTo(120)
    }

    @Test
    fun `a tool chunk carries its kind and duration and no persona`() {
        // `tool_kind` and `duration_ms` are the ONLY source for a sub-agent tag and
        // for tool timing — the chunk is emitted after the call returns, so the
        // client can derive neither. `persona_id`/`persona_name` are null on a tool
        // chunk; `name` carries the tool's own label instead.
        val event = parseServerEvent(
            """{"type":"stream_chunk","event_id":"e","timestamp":"t","role":"tool","content":"done","conversation_id":9,"name":"researcher","tool_kind":"sub_agent","duration_ms":1420}"""
        ) as StreamChunkEvent
        assertThat(event.name).isEqualTo("researcher")
        assertThat(event.toolKind).isEqualTo("sub_agent")
        assertThat(event.durationMs).isEqualTo(1420)
        assertThat(event.personaId).isNull()
        assertThat(event.personaName).isNull()
    }

    // ── Client → server payload shapes the backend parses by name ───────

    @Test
    fun `chat_request carries persona_id, never the removed agent_id`() {
        // The backend renamed this field rather than aliasing it: a payload still
        // saying `agent_id` is parsed as "no override" and silently ignored.
        val payload = ChatRequestPayload(
            eventId = "e",
            timestamp = "t",
            text = "hi",
            modelName = "",
            conversationId = 7,
            personaId = 3,
        )
        val obj = json.parseToJsonElement(
            json.encodeToString(ChatRequestPayload.serializer(), payload)
        ) as kotlinx.serialization.json.JsonObject

        assertThat(obj["persona_id"]!!.jsonPrimitive.content).isEqualTo("3")
        assertThat(obj.keys).doesNotContain("agent_id")
    }

    @Test
    fun `tool_call_response serializes to the shape the backend parses`() {
        val payload = ToolCallResponsePayload(
            eventId = "e",
            timestamp = "t",
            requestId = "r1",
            content = "Client tools are not supported on the Android client",
            isError = true,
        )
        val obj = json.parseToJsonElement(
            json.encodeToString(ToolCallResponsePayload.serializer(), payload)
        ) as kotlinx.serialization.json.JsonObject

        assertThat(obj["type"]).isEqualTo(JsonPrimitive("tool_call_response"))
        assertThat(obj["request_id"]!!.jsonPrimitive.content).isEqualTo("r1")
        assertThat(obj["is_error"]!!.jsonPrimitive.content).isEqualTo("true")
        assertThat(obj.keys).containsExactly(
            "type", "event_id", "timestamp", "request_id", "content", "is_error",
        )
    }
}
