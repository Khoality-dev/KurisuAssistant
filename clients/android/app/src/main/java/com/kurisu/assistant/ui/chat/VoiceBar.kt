package com.kurisu.assistant.ui.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HeadsetMic
import androidx.compose.material.icons.filled.HeadsetOff
import androidx.compose.material.icons.filled.HearingDisabled
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.HeadsetMic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kurisu.assistant.domain.voice.VoiceBarPhase
import com.kurisu.assistant.service.VoiceInteractionManager
import java.text.DateFormat
import java.util.Date

/**
 * Voice mode's colours, from section 3 of the Claude Design mockup "Kurisu -
 * Voice Mode v1" over the app theme. They are blue in dark mode too, where the
 * theme's primary is grey: voice mode must read from across the room.
 */
private data class VoiceColors(
    val pri: Color,
    val priFg: Color,
    val onPri: Color,
    val priCont: Color,
    val onPriCont: Color,
    val ring: Color,
    val track: Color,
    val surface: Color,
    val bubble: Color,
    val errCont: Color,
    val onErrCont: Color,
    val warnCont: Color,
    val onWarnCont: Color,
    val warnDot: Color,
    val fg2: Color,
    val fg3: Color,
    val skel: Color,
    val skel2: Color,
)

@Composable
private fun voiceColors(): VoiceColors {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    return if (dark) {
        VoiceColors(
            pri = Color(0xFF3B82F6), priFg = Color(0xFF60A5FA), onPri = Color.White,
            priCont = Color(0xFF1E3A5F), onPriCont = Color(0xFFBFDBFE),
            ring = Color(0x4D3B82F6), track = Color(0x1AFFFFFF),
            surface = Color(0xFF1A1A1A), bubble = Color(0xFF262626),
            errCont = Color(0xFF450A0A), onErrCont = Color(0xFFFCA5A5),
            warnCont = Color(0x2EF59E0B), onWarnCont = Color(0xFFFBBF24), warnDot = Color(0xFFF59E0B),
            fg2 = Color(0xFFA3A3A3), fg3 = Color(0xFF8A8A8A),
            skel = Color(0x0FFFFFFF), skel2 = Color(0x21FFFFFF),
        )
    } else {
        VoiceColors(
            pri = Color(0xFF0084FF), priFg = Color(0xFF0070DB), onPri = Color.White,
            priCont = Color(0xFFE3F2FF), onPriCont = Color(0xFF003366),
            ring = Color(0x380084FF), track = Color(0x14000000),
            surface = Color(0xFFF0F2F5), bubble = Color(0xFFE4E6EB),
            errCont = Color(0xFFFEE2E2), onErrCont = Color(0xFF991B1B),
            warnCont = Color(0xFFFEF3C7), onWarnCont = Color(0xFF92400E), warnDot = Color(0xFFF59E0B),
            fg2 = Color(0xFF525252), fg3 = Color(0xFF737373),
            skel = Color(0x0F000000), skel2 = Color(0x21000000),
        )
    }
}

/** A wake word as the bar quotes it: "kurisu" reads as “Kurisu”. */
internal fun displayWakeWord(word: String?): String =
    word?.trim()?.replaceFirstChar { it.uppercaseChar() } ?: ""

private class ProblemCopy(
    val title: String,
    val detail: String,
    val icon: ImageVector,
    val warn: Boolean,
    val action: String,
)

private fun problemCopy(phase: VoiceBarPhase): ProblemCopy? = when (phase) {
    VoiceBarPhase.NO_WAKE_WORD -> ProblemCopy(
        "No wake word set",
        "Voice mode can't start anything until you set one on the Assistant screen.",
        Icons.Filled.RecordVoiceOver, warn = true, action = "Open Assistant",
    )
    VoiceBarPhase.MIC_UNAVAILABLE -> ProblemCopy(
        "Microphone unavailable",
        "Another app may be using it. Close it and try again.",
        Icons.Filled.MicOff, warn = false, action = "Try again",
    )
    VoiceBarPhase.MIC_BLOCKED -> ProblemCopy(
        "Microphone access is off",
        "Allow it in Android settings to use voice mode.",
        Icons.Filled.Lock, warn = false, action = "Open settings",
    )
    VoiceBarPhase.ASR_UNAVAILABLE -> ProblemCopy(
        "Speech recognition didn't load",
        "Voice mode can't hear anything until it does.",
        Icons.Filled.HearingDisabled, warn = false, action = "Retry",
    )
    else -> null
}

/**
 * The voice bar (#341): what stands in for the composer while voice mode is on,
 * with the keyboard hidden. The first line says what voice mode is doing and
 * the second what was last said; a problem replaces them with what is wrong and
 * the action that fixes it. A line along the top is faint while voice mode
 * waits, solid through an interaction, and drains over the 30-second window.
 * End voice mode is a 44 dp tonal button in the bottom-right, in every state.
 */
@Composable
fun VoiceBar(
    phase: VoiceBarPhase,
    wakeWord: String?,
    answererName: String,
    lastTranscript: String?,
    /** When the 30-second window ends the interaction, while it is open. */
    idleDeadlineMs: Long?,
    onEnd: () -> Unit,
    onRetry: () -> Unit,
    onOpenAssistant: () -> Unit,
    onOpenAppSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = voiceColors()
    val problem = problemCopy(phase)
    val running = phase in setOf(VoiceBarPhase.LISTENING, VoiceBarPhase.TRANSCRIBING, VoiceBarPhase.THINKING, VoiceBarPhase.SPEAKING)

    // The bar sets its own text colour: it is drawn on its own surface, not
    // inside one that would.
    CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) {
    Box(modifier = modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(c.surface),
        ) {
            // The top line.
            val lineModifier = Modifier
                .align(Alignment.TopCenter)
                .padding(horizontal = 32.dp)
                .fillMaxWidth()
                .height(3.dp)
                .clip(RoundedCornerShape(bottomStart = 3.dp, bottomEnd = 3.dp))
            when {
                phase == VoiceBarPhase.WAITING -> Box(lineModifier.background(c.ring))
                running -> Box(lineModifier.background(c.pri))
                phase == VoiceBarPhase.WINDOW -> DrainLine(idleDeadlineMs, c, lineModifier)
            }

            Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 14.dp)) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Disc(phase, answererName, problem, c)
                    Column(
                        modifier = Modifier.weight(1f).padding(top = 2.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        StatusLines(phase, wakeWord, answererName, lastTranscript, problem, c)
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (problem != null) {
                        FilledTonalButton(
                            onClick = when (phase) {
                                VoiceBarPhase.NO_WAKE_WORD -> onOpenAssistant
                                VoiceBarPhase.MIC_BLOCKED -> onOpenAppSettings
                                else -> onRetry
                            },
                            colors = ButtonDefaults.filledTonalButtonColors(containerColor = c.priCont, contentColor = c.onPriCont),
                            modifier = Modifier.height(44.dp),
                        ) { Text(problem.action, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                    }
                    Spacer(Modifier.weight(1f))
                    FilledTonalButton(
                        onClick = onEnd,
                        colors = ButtonDefaults.filledTonalButtonColors(containerColor = c.errCont, contentColor = c.onErrCont),
                        contentPadding = PaddingValues(start = 14.dp, end = 18.dp),
                        modifier = Modifier.height(44.dp),
                    ) {
                        Icon(Icons.Filled.HeadsetOff, contentDescription = null, modifier = Modifier.size(19.dp))
                        Spacer(Modifier.width(7.dp))
                        Text("End voice mode", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun DrainLine(idleDeadlineMs: Long?, c: VoiceColors, modifier: Modifier) {
    val fraction = remember(idleDeadlineMs) { Animatable(remainingFraction(idleDeadlineMs)) }
    LaunchedEffect(idleDeadlineMs) {
        val left = idleDeadlineMs?.let { (it - System.currentTimeMillis()).coerceAtLeast(0L) } ?: 0L
        if (left > 0) fraction.animateTo(0f, tween(durationMillis = left.toInt(), easing = LinearEasing))
    }
    Box(modifier.background(c.track).testTag("voice-window-drain")) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.value).background(c.pri))
    }
}

/** How much of the 30-second window is left, from its deadline. */
internal fun remainingFraction(deadlineMs: Long?, nowMs: Long = System.currentTimeMillis()): Float {
    if (deadlineMs == null) return 0f
    return ((deadlineMs - nowMs).toFloat() / VoiceInteractionManager.IDLE_TIMEOUT_MS).coerceIn(0f, 1f)
}

@Composable
private fun Disc(phase: VoiceBarPhase, answererName: String, problem: ProblemCopy?, c: VoiceColors) {
    val transition = rememberInfiniteTransition(label = "voice-disc")
    val pulse by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "pulse",
    )
    Box(modifier = Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        when {
            problem != null -> Circle(if (problem.warn) c.warnCont else c.errCont) {
                Icon(problem.icon, contentDescription = null, tint = if (problem.warn) c.onWarnCont else c.onErrCont, modifier = Modifier.size(24.dp))
            }
            phase == VoiceBarPhase.WAITING -> {
                Box(
                    Modifier.size(58.dp).scale(1f + 0.1f * breathe(pulse))
                        .border(1.5.dp, c.pri.copy(alpha = 0.25f + 0.35f * breathe(pulse)), CircleShape),
                )
                Circle(c.priCont) { Icon(Icons.Filled.HeadsetMic, contentDescription = null, tint = c.onPriCont, modifier = Modifier.size(24.dp)) }
            }
            phase == VoiceBarPhase.LISTENING || phase == VoiceBarPhase.WINDOW -> {
                Halo(pulse, c.pri)
                Halo((pulse + 0.5f) % 1f, c.pri)
                Circle(c.pri) { Icon(Icons.Filled.Mic, contentDescription = null, tint = c.onPri, modifier = Modifier.size(24.dp)) }
            }
            phase == VoiceBarPhase.TRANSCRIBING -> {
                Circle(c.priCont) { Icon(Icons.Filled.Mic, contentDescription = null, tint = c.onPriCont, modifier = Modifier.size(24.dp)) }
                CircularProgressIndicator(modifier = Modifier.size(56.dp), color = c.pri, strokeWidth = 2.5.dp)
            }
            else -> {
                if (phase == VoiceBarPhase.SPEAKING) {
                    Halo(pulse, c.fg3)
                    Halo((pulse + 0.5f) % 1f, c.fg3)
                }
                Circle(c.bubble) {
                    Text(
                        answererName.take(2).uppercase(),
                        fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

private fun breathe(t: Float): Float = if (t < 0.5f) t * 2f else (1f - t) * 2f

@Composable
private fun Halo(t: Float, color: Color) {
    Box(
        Modifier.size(48.dp).scale(1f + 0.6f * t)
            .border(2.dp, color.copy(alpha = 0.55f * (1f - t)), CircleShape),
    )
}

@Composable
private fun Circle(color: Color, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier = Modifier.size(48.dp).clip(CircleShape).background(color),
        contentAlignment = Alignment.Center,
        content = content,
    )
}

@Composable
private fun StatusLines(
    phase: VoiceBarPhase,
    wakeWord: String?,
    answererName: String,
    lastTranscript: String?,
    problem: ProblemCopy?,
    c: VoiceColors,
) {
    val label = problem?.title ?: when (phase) {
        VoiceBarPhase.LISTENING, VoiceBarPhase.WINDOW -> "Listening"
        VoiceBarPhase.TRANSCRIBING -> "Transcribing"
        VoiceBarPhase.THINKING -> "$answererName is thinking"
        VoiceBarPhase.SPEAKING -> "$answererName is speaking"
        else -> null
    }
    if (phase == VoiceBarPhase.WAITING) {
        Text(
            buildAnnotatedString {
                append("Say ")
                withStyle(SpanStyle(color = c.priFg)) { append("“${displayWakeWord(wakeWord)}”") }
                append(" to start")
            },
            fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 23.sp,
        )
    }
    if (label != null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.heightIn(min = 23.dp)) {
            Text(label, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 23.sp)
            when (phase) {
                VoiceBarPhase.LISTENING -> Bars(listOf(460, 620, 380, 550, 710, 430, 580), c.pri, 18.dp, 0.25f, 1f)
                VoiceBarPhase.WINDOW -> Bars(listOf(900, 1100, 800, 1200, 1000, 850, 1050), c.fg3, 18.dp, 0.12f, 0.35f)
                VoiceBarPhase.SPEAKING -> Bars(listOf(520, 400, 660, 470, 600), c.fg2, 15.dp, 0.25f, 1f)
                VoiceBarPhase.THINKING -> Dots(c.fg2)
                else -> {}
            }
        }
    }
    val quoted = !lastTranscript.isNullOrBlank() && phase in setOf(
        VoiceBarPhase.LISTENING, VoiceBarPhase.THINKING, VoiceBarPhase.SPEAKING, VoiceBarPhase.WINDOW,
    )
    if (quoted) {
        Text(
            "You said “$lastTranscript”",
            fontSize = 14.sp, lineHeight = 20.sp, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
    if (phase == VoiceBarPhase.TRANSCRIBING) Skeleton(c)
    val sub = problem?.detail ?: if (phase == VoiceBarPhase.WAITING) "Nothing is sent until you say it." else null
    if (sub != null) Text(sub, fontSize = 14.sp, lineHeight = 20.sp, color = c.fg2)
    if (phase == VoiceBarPhase.WINDOW) {
        Text("Ends soon unless you say something", fontSize = 13.sp, lineHeight = 19.sp, color = c.fg2)
    }
}

@Composable
private fun Bars(durationsMs: List<Int>, color: Color, height: androidx.compose.ui.unit.Dp, low: Float, high: Float) {
    val transition = rememberInfiniteTransition(label = "voice-bars")
    Row(horizontalArrangement = Arrangement.spacedBy(2.5.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.height(height)) {
        durationsMs.forEachIndexed { i, d ->
            val s by transition.animateFloat(
                initialValue = low, targetValue = high,
                animationSpec = infiniteRepeatable(tween(d, delayMillis = i * 60), RepeatMode.Reverse), label = "bar$i",
            )
            Box(Modifier.width(3.5.dp).fillMaxHeight(s).clip(RoundedCornerShape(2.dp)).background(color))
        }
    }
}

@Composable
private fun Dots(color: Color) {
    val transition = rememberInfiniteTransition(label = "voice-dots")
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val a by transition.animateFloat(
                initialValue = 0.35f, targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 160), RepeatMode.Reverse), label = "dot$i",
            )
            Box(Modifier.size(6.dp).clip(CircleShape).background(color.copy(alpha = a)))
        }
    }
}

@Composable
private fun Skeleton(c: VoiceColors) {
    val transition = rememberInfiniteTransition(label = "voice-skeleton")
    val x by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "shimmer")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 7.dp)) {
        listOf(0.9f, 0.58f).forEach { w ->
            Box(
                Modifier.fillMaxWidth(w).height(10.dp).clip(RoundedCornerShape(5.dp)).drawBehind {
                    val shift = size.width * (2 * x - 1)
                    drawRect(Brush.horizontalGradient(listOf(c.skel, c.skel2, c.skel), startX = shift, endX = shift + size.width))
                },
            )
        }
    }
}

/**
 * Voice mode's control in the top bar (#341). Off, an outlined headset; on, a
 * filled blue circle with a ring, and a dot while the voice bar shows a problem.
 */
@Composable
fun VoiceModeButton(on: Boolean, attention: Boolean, onToggle: () -> Unit) {
    val c = voiceColors()
    if (!on) {
        IconButton(onClick = onToggle) {
            Icon(Icons.Outlined.HeadsetMic, contentDescription = "Start voice mode")
        }
        return
    }
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(onClick = onToggle)
            .semantics {
                contentDescription = "End voice mode"
                if (attention) stateDescription = "Needs attention"
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(46.dp).clip(CircleShape).background(c.ring),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(c.pri), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.HeadsetMic, contentDescription = null, tint = c.onPri, modifier = Modifier.size(22.dp))
            }
        }
        if (attention) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(top = 5.dp, end = 5.dp).size(13.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.background).padding(2.dp).clip(CircleShape)
                    .background(c.warnDot).testTag("voice-mode-attention"),
            )
        }
    }
}

/**
 * Each interaction is a new conversation (#341), so the transcript opens on a
 * marker that says so: when the wake word was heard and, when a conversation
 * was open before, that it is kept in Chats.
 */
@Composable
fun NewInteractionMarker(wakeWord: String?, atMs: Long, hasPrevious: Boolean, onOpenChats: () -> Unit) {
    val c = voiceColors()
    val time = remember(atMs) { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(atMs)) }
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.height(30.dp).clip(RoundedCornerShape(15.dp)).background(c.surface).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.AddComment, contentDescription = null, tint = c.priFg, modifier = Modifier.size(16.dp))
            Text("New conversation", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
        }
        Text(
            "You said “${displayWakeWord(wakeWord)}” at $time.",
            fontSize = 13.sp, lineHeight = 18.sp, color = c.fg2, textAlign = TextAlign.Center,
        )
        if (hasPrevious) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("The last one is in ", fontSize = 13.sp, color = c.fg2)
                Text(
                    "Chats",
                    fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.priFg,
                    modifier = Modifier.clickable(onClick = onOpenChats),
                )
                Text(".", fontSize = 13.sp, color = c.fg2)
            }
        }
    }
}
