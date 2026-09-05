package com.kurisu.assistant.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.kurisu.assistant.R

/**
 * Vendored static TTFs (SIL OFL — licences in `app/licenses/`), not variable fonts and not
 * `ui-text-google-fonts`:
 *
 *  - minSdk is 26. `Font(resId, weight)` on API < 29 loads one instance out of the file and
 *    ignores the weight axis, so a variable font renders a single weight everywhere.
 *  - the downloadable-font provider needs a Play font-provider certificate, and this app
 *    deliberately ships without Google Play Services (see app/build.gradle.kts).
 */
val InstrumentSans = FontFamily(
    Font(R.font.instrument_sans_regular, FontWeight.Normal),
    Font(R.font.instrument_sans_medium, FontWeight.Medium),
    Font(R.font.instrument_sans_semibold, FontWeight.SemiBold),
    Font(R.font.instrument_sans_bold, FontWeight.Bold),
)

/** Code, raw payloads and every metadata row. Regular + Medium only — no other weight is used. */
val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
)

/**
 * Styles the design needs that Material 3's `Typography` has no slot for.
 *
 * The design sets every metadata row (timestamps, token counts, model and tool names, tool
 * argument lines) in JetBrains Mono. `labelSmall` is NOT free for that — it is load-bearing
 * in AssistantScreen, MessageBubble and ChatInput as a proportional label — so these live
 * beside the M3 scale instead of overwriting part of it.
 */
@Immutable
data class KurisuExtraTypography(
    /** Metadata rows: timestamps, counts, model/tool identifiers. */
    val metadata: TextStyle = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
    ),
    /** Dense metadata: chips and inline tags where 12sp is too tall. */
    val metadataSmall: TextStyle = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.2.sp,
    ),
    /** Code and raw payload blocks (tool args, thinking traces, raw LLM data). */
    val code: TextStyle = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight.Normal,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
    ),
)

/** Provided by [KurisuTheme]; read as `KurisuTheme.extraTypography`. */
val LocalKurisuTypography = staticCompositionLocalOf { KurisuExtraTypography() }
