package com.kurisu.assistant.domain.chat

import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.DoneEvent
import com.kurisu.assistant.data.model.ErrorEvent
import com.kurisu.assistant.data.model.ServerEvent
import com.kurisu.assistant.data.model.StreamChunkEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.runs
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatStreamProcessorTest {

    private lateinit var wsManager: WebSocketManager
    private lateinit var eventsFlow: MutableSharedFlow<ServerEvent>
    private lateinit var processor: ChatStreamProcessor

    @Before
    fun setUp() {
        wsManager = mockk(relaxed = true)
        eventsFlow = MutableSharedFlow(extraBufferCapacity = 64)
        every { wsManager.events } returns eventsFlow
        every { wsManager.sendCancel() } just runs
        processor = ChatStreamProcessor(wsManager)
        processor.collectDispatcher = UnconfinedTestDispatcher()
    }

    @After
    fun tearDown() {
        processor.stopCollecting()
    }

    @Test
    fun `startStreaming sets isStreaming true`() {
        processor.startStreaming()
        assertThat(processor.state.value.isStreaming).isTrue()
    }

    @Test
    fun `addUserMessage appends to streamingMessages`() {
        processor.addUserMessage("hello", images = listOf("img1"))
        val msgs = processor.state.value.streamingMessages
        assertThat(msgs).hasSize(1)
        assertThat(msgs[0].role).isEqualTo("user")
        assertThat(msgs[0].content).isEqualTo("hello")
        assertThat(msgs[0].images).containsExactly("img1")
    }

    @Test
    fun `queueMessage and dequeueMessage are FIFO`() {
        processor.queueMessage("first")
        processor.queueMessage("second", images = listOf("i"))
        assertThat(processor.state.value.queuedMessages).hasSize(2)

        val first = processor.dequeueMessage()
        assertThat(first!!.text).isEqualTo("first")
        assertThat(processor.state.value.queuedMessages).hasSize(1)

        val second = processor.dequeueMessage()
        assertThat(second!!.text).isEqualTo("second")
        assertThat(second.images).containsExactly("i")

        assertThat(processor.dequeueMessage()).isNull()
    }

    @Test
    fun `cancelStream clears state and sends cancel to ws`() {
        processor.startStreaming()
        processor.queueMessage("x")
        processor.cancelStream()
        verify { wsManager.sendCancel() }
        assertThat(processor.state.value.isStreaming).isFalse()
        assertThat(processor.state.value.queuedMessages).isEmpty()
    }

    @Test
    fun `setError stops streaming and sets error message`() {
        processor.startStreaming()
        processor.setError("boom")
        assertThat(processor.state.value.isStreaming).isFalse()
        assertThat(processor.state.value.streamError).isEqualTo("boom")
        processor.clearError()
        assertThat(processor.state.value.streamError).isNull()
    }

    @Test
    fun `clearStreamingMessages empties the list`() {
        processor.addUserMessage("a")
        processor.addUserMessage("b")
        processor.clearStreamingMessages()
        assertThat(processor.state.value.streamingMessages).isEmpty()
    }

    @Test
    fun `stream chunks accumulate into one bubble when role is same`() = runTest {
        processor.startCollecting()
        processor.startStreaming()

        eventsFlow.emit(chunk(role = "assistant", content = "Hel"))
        eventsFlow.emit(chunk(role = "assistant", content = "lo, "))
        eventsFlow.emit(chunk(role = "assistant", content = "world."))
        advanceUntilIdle()

        val msgs = processor.state.value.streamingMessages
        assertThat(msgs).hasSize(1)
        assertThat(msgs[0].content).isEqualTo("Hello, world.")
    }

    @Test
    fun `role change creates new bubble`() = runTest {
        processor.startCollecting()
        processor.startStreaming()

        eventsFlow.emit(chunk(role = "assistant", content = "thinking"))
        eventsFlow.emit(chunk(role = "tool", content = "tool call", name = "calculator"))
        eventsFlow.emit(chunk(role = "assistant", content = " answer"))
        advanceUntilIdle()

        val msgs = processor.state.value.streamingMessages
        assertThat(msgs).hasSize(3)
        assertThat(msgs.map { it.role }).containsExactly("assistant", "tool", "assistant").inOrder()
    }

    @Test
    fun `sentence boundary fires callback for assistant only`() = runTest {
        val received = mutableListOf<String>()
        processor.onSentenceBoundary = { text, _ -> received.add(text) }
        processor.startCollecting()
        processor.startStreaming()

        eventsFlow.emit(chunk(role = "assistant", content = "First sentence. Second "))
        eventsFlow.emit(chunk(role = "assistant", content = "sentence! Third"))
        advanceUntilIdle()

        assertThat(received).containsExactly("First sentence.", "Second sentence!").inOrder()
    }

    @Test
    fun `tool role does not feed TTS`() = runTest {
        val received = mutableListOf<String>()
        processor.onSentenceBoundary = { text, _ -> received.add(text) }
        processor.startCollecting()

        eventsFlow.emit(chunk(role = "tool", content = "Tool output.", name = "x"))
        advanceUntilIdle()

        assertThat(received).isEmpty()
    }

    @Test
    fun `DoneEvent flushes remaining TTS buffer and invokes callback`() = runTest {
        val received = mutableListOf<String>()
        processor.onSentenceBoundary = { text, _ -> received.add(text) }
        var doneFired = false
        processor.onStreamDone = { doneFired = true }
        processor.startCollecting()

        eventsFlow.emit(chunk(role = "assistant", content = "No boundary yet"))
        eventsFlow.emit(DoneEvent(conversationId = 5))
        advanceUntilIdle()

        assertThat(received).containsExactly("No boundary yet")
        assertThat(doneFired).isTrue()
        assertThat(processor.state.value.isStreaming).isFalse()
    }

    @Test
    fun `ErrorEvent with non-connection-lost code sets error`() = runTest {
        processor.startCollecting()
        eventsFlow.emit(ErrorEvent(error = "bad thing", code = "BAD"))
        advanceUntilIdle()

        assertThat(processor.state.value.streamError).isEqualTo("bad thing")
        assertThat(processor.state.value.isStreaming).isFalse()
    }

    @Test
    fun `ErrorEvent with CONNECTION_LOST is ignored`() = runTest {
        processor.startCollecting()
        eventsFlow.emit(ErrorEvent(error = "dropped", code = "CONNECTION_LOST"))
        advanceUntilIdle()

        assertThat(processor.state.value.streamError).isNull()
    }

    @Test
    fun `conversation id callback fires from first chunk`() = runTest {
        val ids = mutableListOf<Int>()
        processor.onConversationId = { ids.add(it) }
        processor.startCollecting()

        eventsFlow.emit(chunk(role = "assistant", content = "hi", conversationId = 42))
        advanceUntilIdle()

        assertThat(ids).containsExactly(42)
    }

    @Test
    fun `startCollecting is idempotent`() {
        processor.startCollecting()
        processor.startCollecting() // should not crash or double-subscribe
    }

    private fun chunk(
        role: String,
        content: String,
        name: String? = null,
        conversationId: Int = 1,
    ) = StreamChunkEvent(
        role = role,
        content = content,
        name = name,
        conversationId = conversationId,
    )
}
