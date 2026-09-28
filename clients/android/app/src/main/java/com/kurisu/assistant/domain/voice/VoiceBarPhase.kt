package com.kurisu.assistant.domain.voice

/**
 * Why the mic cannot listen (#341). Each has its own fix, so each is its own
 * state on the voice bar: another app holding the mic, access that is off in
 * Android settings, or speech recognition that did not load.
 */
enum class MicProblem { UNAVAILABLE, BLOCKED, ASR_UNAVAILABLE }

/**
 * What the voice bar says voice mode is doing (#341) — the desktop's
 * `voiceBarPhase` (#345), state for state. The last four are problems: the bar
 * says what is wrong and offers the fix.
 */
enum class VoiceBarPhase(val isProblem: Boolean = false) {
    WAITING,
    LISTENING,
    TRANSCRIBING,
    THINKING,
    SPEAKING,
    WINDOW,
    NO_WAKE_WORD(isProblem = true),
    MIC_UNAVAILABLE(isProblem = true),
    MIC_BLOCKED(isProblem = true),
    ASR_UNAVAILABLE(isProblem = true),
}

data class VoiceBarInput(
    val problem: MicProblem?,
    val triggerWord: String?,
    val interactionActive: Boolean,
    /** Someone is talking right now. */
    val userTalking: Boolean,
    val transcribing: Boolean,
    /** The reply is streaming. */
    val isStreaming: Boolean,
    /** The reply is being read aloud. */
    val isSpeaking: Boolean,
)

/**
 * A mic that cannot listen outranks everything; then a missing wake word,
 * since without one nothing can start. Inside an interaction, talking wins over
 * the reply — it interrupts it — and with the reply done and nobody talking,
 * the 30-second window runs.
 */
fun voiceBarPhase(s: VoiceBarInput): VoiceBarPhase = when {
    s.problem == MicProblem.UNAVAILABLE -> VoiceBarPhase.MIC_UNAVAILABLE
    s.problem == MicProblem.BLOCKED -> VoiceBarPhase.MIC_BLOCKED
    s.problem == MicProblem.ASR_UNAVAILABLE -> VoiceBarPhase.ASR_UNAVAILABLE
    !s.interactionActive -> if (s.triggerWord.isNullOrBlank()) VoiceBarPhase.NO_WAKE_WORD else VoiceBarPhase.WAITING
    s.userTalking -> VoiceBarPhase.LISTENING
    s.transcribing -> VoiceBarPhase.TRANSCRIBING
    s.isSpeaking -> VoiceBarPhase.SPEAKING
    s.isStreaming -> VoiceBarPhase.THINKING
    else -> VoiceBarPhase.WINDOW
}
