package com.kurisu.assistant.domain.chat

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.EmotionCue
import com.kurisu.assistant.domain.tts.SegmentCue
import com.kurisu.assistant.domain.tts.SpeechCue
import com.kurisu.assistant.domain.tts.speechSegmentOf
import com.kurisu.assistant.domain.tts.AmplitudeCurve
import org.junit.Test

/**
 * A feeling is shown when the sentence carrying it is spoken (#244, #246):
 * the same rules as the desktop's `selectCuesForSegment` in `@kurisu/hooks`.
 */
class EmotionTimingTest {

    @Test
    fun `cues inside a sentence become fractions of it`() {
        val cues = listOf(EmotionCue("happy", 10), EmotionCue("sad", 30))
        assertThat(selectCuesForSegment(cues, start = 0, end = 40, previousEnded = null))
            .containsExactly(SegmentCue("happy", 0.25), SegmentCue("sad", 0.75)).inOrder()
        assertThat(selectCuesForSegment(cues, start = 40, end = 40, previousEnded = null)).isEmpty()
    }

    @Test
    fun `a sentence with no cue of its own opens on the feeling in force, unless it is already showing`() {
        val cues = listOf(EmotionCue("happy", 5))
        assertThat(selectCuesForSegment(cues, start = 20, end = 40, previousEnded = null))
            .containsExactly(SegmentCue("happy", 0.0))
        assertThat(selectCuesForSegment(cues, start = 20, end = 40, previousEnded = "happy")).isEmpty()
    }

    @Test
    fun `the planner counts offsets across sentences and starts again for a new round`() {
        val planner = SpeechCuePlanner()
        planner.cue("happy", 0)
        planner.cue("sad", 25)
        // "Hello there, it is good to see you." is 35 code units; the sad cue is inside it.
        assertThat(planner.take(rawLength = 35, spoken = true))
            .containsExactly(SegmentCue("happy", 0.0), SegmentCue("sad", 25.0 / 35)).inOrder()
        // The next sentence opens on nothing new: sad is already on the face.
        assertThat(planner.take(rawLength = 20, spoken = true)).isEmpty()

        // A tool call: the backend's offsets restart at 0 in the next round.
        planner.newRun()
        planner.cue("surprised", 0)
        assertThat(planner.take(rawLength = 10, spoken = true)).containsExactly(SegmentCue("surprised", 0.0))
    }

    @Test
    fun `a sentence narration swallowed carries its feeling into the next one spoken`() {
        val planner = SpeechCuePlanner()
        planner.cue("angry", 2)
        assertThat(planner.take(rawLength = 12, spoken = false)).isNotEmpty()
        assertThat(planner.take(rawLength = 20, spoken = true)).containsExactly(SegmentCue("angry", 0.0))
    }

    @Test
    fun `a label the face does not know is dropped where it arrives`() {
        val planner = SpeechCuePlanner()
        planner.cue("smug", 0)
        assertThat(planner.take(rawLength = 10, spoken = true)).isEmpty()
    }

    @Test
    fun `a sentence's cues are delays into the audio once its length is known`() {
        val curve = AmplitudeCurve(floatArrayOf(0f, 0.5f, 1f), windowDurationMs = 33.3f)
        val segment = speechSegmentOf(
            text = "Hi there.",
            startedAt = 5_000,
            durationMs = 2_000,
            curve = curve,
            cues = listOf(SegmentCue("happy", 0.0), SegmentCue("sad", 0.5)),
        )
        assertThat(segment.startedAt).isEqualTo(5_000)
        assertThat(segment.durationMs).isEqualTo(2_000)
        assertThat(segment.windowMs).isWithin(0.01).of(33.3)
        assertThat(segment.curve!!.toList()).containsExactly(0f, 0.5f, 1f).inOrder()
        assertThat(segment.cues).containsExactly(SpeechCue("happy", 0), SpeechCue("sad", 1_000)).inOrder()

        // No curve (the WAV could not be read): the page holds a silent mouth for the duration.
        val silent = speechSegmentOf("Hi.", 1, 800, null, emptyList())
        assertThat(silent.curve).isNull()
        assertThat(silent.windowMs).isWithin(0.01).of(1000.0 / 30)
    }
}
