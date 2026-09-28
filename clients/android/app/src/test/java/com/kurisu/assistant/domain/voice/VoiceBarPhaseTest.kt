package com.kurisu.assistant.domain.voice

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * Which state the voice bar is in (#341): one answer from everything voice mode
 * knows, in the same order as the desktop's `voiceBarPhase` (#345).
 */
class VoiceBarPhaseTest {

    private val idle = VoiceBarInput(
        problem = null,
        triggerWord = "Kurisu",
        interactionActive = false,
        userTalking = false,
        transcribing = false,
        isStreaming = false,
        isSpeaking = false,
    )

    private fun inInteraction(input: VoiceBarInput) = voiceBarPhase(input.copy(interactionActive = true))

    @Test
    fun `waits for the wake word before an interaction`() {
        assertThat(voiceBarPhase(idle)).isEqualTo(VoiceBarPhase.WAITING)
        assertThat(voiceBarPhase(idle.copy(userTalking = true))).isEqualTo(VoiceBarPhase.WAITING)
    }

    @Test
    fun `in an interaction, listening while someone talks, then transcribing`() {
        assertThat(inInteraction(idle.copy(userTalking = true))).isEqualTo(VoiceBarPhase.LISTENING)
        assertThat(inInteraction(idle.copy(transcribing = true))).isEqualTo(VoiceBarPhase.TRANSCRIBING)
    }

    @Test
    fun `then thinking while the reply streams, speaking while it is read aloud`() {
        assertThat(inInteraction(idle.copy(isStreaming = true))).isEqualTo(VoiceBarPhase.THINKING)
        assertThat(inInteraction(idle.copy(isSpeaking = true))).isEqualTo(VoiceBarPhase.SPEAKING)
        assertThat(inInteraction(idle.copy(isStreaming = true, isSpeaking = true))).isEqualTo(VoiceBarPhase.SPEAKING)
    }

    @Test
    fun `talking over the reply is listening`() {
        assertThat(inInteraction(idle.copy(isSpeaking = true, userTalking = true))).isEqualTo(VoiceBarPhase.LISTENING)
    }

    @Test
    fun `with the reply done and nobody talking, the 30-second window runs`() {
        assertThat(inInteraction(idle)).isEqualTo(VoiceBarPhase.WINDOW)
    }

    @Test
    fun `with no wake word set, nothing can start`() {
        assertThat(voiceBarPhase(idle.copy(triggerWord = null))).isEqualTo(VoiceBarPhase.NO_WAKE_WORD)
        assertThat(voiceBarPhase(idle.copy(triggerWord = "  "))).isEqualTo(VoiceBarPhase.NO_WAKE_WORD)
    }

    @Test
    fun `a mic that cannot listen outranks everything else`() {
        assertThat(voiceBarPhase(idle.copy(problem = MicProblem.BLOCKED, triggerWord = null)))
            .isEqualTo(VoiceBarPhase.MIC_BLOCKED)
        assertThat(inInteraction(idle.copy(problem = MicProblem.ASR_UNAVAILABLE, isStreaming = true)))
            .isEqualTo(VoiceBarPhase.ASR_UNAVAILABLE)
        assertThat(voiceBarPhase(idle.copy(problem = MicProblem.UNAVAILABLE)))
            .isEqualTo(VoiceBarPhase.MIC_UNAVAILABLE)
    }

    @Test
    fun `knows which states are problems`() {
        assertThat(VoiceBarPhase.NO_WAKE_WORD.isProblem).isTrue()
        assertThat(VoiceBarPhase.MIC_BLOCKED.isProblem).isTrue()
        assertThat(VoiceBarPhase.MIC_UNAVAILABLE.isProblem).isTrue()
        assertThat(VoiceBarPhase.ASR_UNAVAILABLE.isProblem).isTrue()
        assertThat(VoiceBarPhase.WINDOW.isProblem).isFalse()
        assertThat(VoiceBarPhase.WAITING.isProblem).isFalse()
    }
}
