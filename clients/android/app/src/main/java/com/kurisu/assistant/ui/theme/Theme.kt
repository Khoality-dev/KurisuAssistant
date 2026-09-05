package com.kurisu.assistant.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

// ── Neutral palette (matches desktop client) ──────────────────────
private val Neutral50  = Color(0xFFFAFAFA)
private val Neutral100 = Color(0xFFF5F5F5)
private val Neutral200 = Color(0xFFE5E5E5)
private val Neutral300 = Color(0xFFD4D4D4)
private val Neutral400 = Color(0xFFA3A3A3)
private val Neutral500 = Color(0xFF737373)
private val Neutral600 = Color(0xFF525252)
private val Neutral700 = Color(0xFF404040)
private val Neutral800 = Color(0xFF262626)
private val Neutral900 = Color(0xFF171717)
private val Neutral950 = Color(0xFF0A0A0A)

// Dark-mode surfaces (pure cool grays, no warmth)
private val Dark14     = Color(0xFF141414)
private val Dark1A     = Color(0xFF1A1A1A)
private val Dark22     = Color(0xFF222222)

// ── Accent: blue (matches desktop info color) ─────────────────────
private val Blue500 = Color(0xFF3B82F6)

// ── Semantic colors ────────────────────────────────────────────────
// SuccessGreen / WarningAmber are consumed by KurisuExtraColors (risk chips) below.
private val ErrorRed        = Color(0xFFEF4444)
private val ErrorBg         = Color(0xFFFEE2E2)
private val SuccessGreen    = Color(0xFF22C55E)
private val SuccessGreenDim = Color(0xFF15803D)  // readable on a light chip
private val WarningAmber    = Color(0xFFF59E0B)
private val WarningAmberDim = Color(0xFF92400E)  // readable on a light chip

// ── Sub-agent tag (design roles) ──────────────────────────────────
private val IndigoTagBg     = Color(0xFFEEF2FF)
private val IndigoTagFg     = Color(0xFF4338CA)
private val IndigoTagBgDark = Color(0xFF1E1B4B)
private val IndigoTagFgDark = Color(0xFFA5B4FC)

// ── Tool result surfaces (were hardcoded in MessageBubble) ────────
private val ToolSuccessBg      = Color(0xFFE8F5E9)
private val ToolSuccessBorder  = Color(0xFF81C784)
private val ToolSuccessFg      = Color(0xFF2E7D32)
private val ToolErrorBg        = Color(0xFFFCE4EC)
private val ToolErrorBorder    = Color(0xFFE57373)
private val ToolErrorFg        = Color(0xFFC62828)
private val ToolSuccessBgDark     = Color(0xFF002A00)
private val ToolSuccessBorderDark = Color(0xFF006600)
private val ToolSuccessFgDark     = Color(0xFF81C784)
private val ToolErrorBgDark       = Color(0xFF2A0000)
private val ToolErrorBorderDark   = Color(0xFF660000)
private val ToolErrorFgDark       = Color(0xFFE57373)

// ── Chat bubbles (were hardcoded in MessageBubble) ────────────────
private val BubbleNeutral     = Color(0xFFE4E6EB)
private val BubbleNeutralDark = Neutral800

// ── Messenger blue ─────────────────────────────────────────────────
private val MessengerBlue = Color(0xFF0084FF)
private val MessengerBlueDark = Color(0xFF0066CC)

// ── Light scheme: Messenger-style — white, gray bubbles, blue accent
private val LightColors = lightColorScheme(
    primary          = MessengerBlue,
    onPrimary        = Color.White,
    primaryContainer = Color(0xFFE3F2FF),
    onPrimaryContainer = Color(0xFF003366),
    secondary        = Neutral600,
    onSecondary      = Color.White,
    secondaryContainer = Color(0xFFE4E6EB),
    onSecondaryContainer = Neutral800,
    tertiary         = Neutral500,
    onTertiary       = Color.White,
    tertiaryContainer = Color(0xFFF0F0F0),
    onTertiaryContainer = Neutral700,
    surface          = Color.White,
    onSurface        = Neutral900,
    surfaceVariant   = Color(0xFFF0F2F5),
    onSurfaceVariant = Neutral600,
    background       = Color.White,
    onBackground     = Neutral900,
    error            = ErrorRed,
    onError          = Color.White,
    errorContainer   = ErrorBg,
    onErrorContainer = Color(0xFF991B1B),
    outline          = Color(0xFFD1D5DB),
    outlineVariant   = Color(0xFFE5E7EB),
    inverseSurface   = Neutral900,
    inverseOnSurface = Neutral100,
)

// ── Dark scheme: matches desktop — pure neutral grays, blue accent ─
private val DarkColors = darkColorScheme(
    primary          = Neutral200,
    onPrimary        = Neutral900,
    primaryContainer = Neutral800,
    onPrimaryContainer = Neutral200,
    secondary        = Blue500,
    onSecondary      = Color.White,
    secondaryContainer = Color(0xFF1E3A5F),
    onSecondaryContainer = Blue500,
    tertiary         = Neutral400,
    onTertiary       = Neutral900,
    tertiaryContainer = Dark22,
    onTertiaryContainer = Neutral300,
    surface          = Dark14,
    onSurface        = Neutral200,
    surfaceVariant   = Dark1A,
    onSurfaceVariant = Neutral500,
    background       = Neutral950,
    onBackground     = Neutral200,
    error            = Color(0xFFFCA5A5),
    onError          = Color(0xFF7F1D1D),
    errorContainer   = Color(0xFF450A0A),
    onErrorContainer = Color(0xFFFCA5A5),
    outline          = Neutral600,
    outlineVariant   = Neutral700,
    inverseSurface   = Neutral100,
    inverseOnSurface = Neutral900,
)

// ── Typography: tighter, sharper, more intentional ─────────────────
private val KurisuTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = InstrumentSans,
        // Instrument Sans ships 400-700: FontWeight.Light would be synthesized, not drawn.
        fontWeight = FontWeight.Normal,
        fontSize = 44.sp,
        lineHeight = 48.sp,
        letterSpacing = (-1.5).sp,
    ),
    displayMedium = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 36.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineLarge = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 24.sp,
        lineHeight = 30.sp,
        letterSpacing = (-0.25).sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 26.sp,
        letterSpacing = 0.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Medium,
        fontSize = 18.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.1.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.15.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.15.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.2.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.5.sp,
    ),
)

// ── Extra color roles ─────────────────────────────────────────────
/**
 * Roles the design needs that Material 3 has no slot for: tool-result surfaces, risk
 * chips, the sub-agent tag and the chat bubbles.
 *
 * These used to be hardcoded hex literals inside MessageBubble and ChatScreen, which let
 * the tool rail and the approval sheet drift apart. They live here so both read the same
 * values, and so dark mode is derived once rather than at every call site.
 */
@Immutable
data class KurisuExtraColors(
    val bubbleUser: Color,
    val bubbleUserContent: Color,
    val bubbleNeutral: Color,
    val toolNeutralBackground: Color,
    val toolSuccessBackground: Color,
    val toolSuccessBorder: Color,
    val toolSuccessContent: Color,
    val toolErrorBackground: Color,
    val toolErrorBorder: Color,
    val toolErrorContent: Color,
    val subAgentTagBackground: Color,
    val subAgentTagContent: Color,
    val riskHighBackground: Color,
    val riskHighContent: Color,
    val riskMediumBackground: Color,
    val riskMediumContent: Color,
    val riskLowBackground: Color,
    val riskLowContent: Color,
)

private val LightExtraColors = KurisuExtraColors(
    bubbleUser            = MessengerBlue,
    bubbleUserContent     = Color.White,
    bubbleNeutral         = BubbleNeutral,
    toolNeutralBackground = BubbleNeutral,
    toolSuccessBackground = ToolSuccessBg,
    toolSuccessBorder     = ToolSuccessBorder,
    toolSuccessContent    = ToolSuccessFg,
    toolErrorBackground   = ToolErrorBg,
    toolErrorBorder       = ToolErrorBorder,
    toolErrorContent      = ToolErrorFg,
    subAgentTagBackground = IndigoTagBg,
    subAgentTagContent    = IndigoTagFg,
    riskHighBackground    = ErrorBg,
    riskHighContent       = Color(0xFF991B1B),
    riskMediumBackground  = WarningAmber.copy(alpha = 0.16f),
    riskMediumContent     = WarningAmberDim,
    riskLowBackground     = SuccessGreen.copy(alpha = 0.16f),
    riskLowContent        = SuccessGreenDim,
)

private val DarkExtraColors = KurisuExtraColors(
    bubbleUser            = MessengerBlueDark,
    bubbleUserContent     = Color.White,
    bubbleNeutral         = BubbleNeutralDark,
    toolNeutralBackground = Dark1A,
    toolSuccessBackground = ToolSuccessBgDark,
    toolSuccessBorder     = ToolSuccessBorderDark,
    toolSuccessContent    = ToolSuccessFgDark,
    toolErrorBackground   = ToolErrorBgDark,
    toolErrorBorder       = ToolErrorBorderDark,
    toolErrorContent      = ToolErrorFgDark,
    subAgentTagBackground = IndigoTagBgDark,
    subAgentTagContent    = IndigoTagFgDark,
    riskHighBackground    = Color(0xFF450A0A),
    riskHighContent       = Color(0xFFFCA5A5),
    riskMediumBackground  = WarningAmber.copy(alpha = 0.20f),
    riskMediumContent     = WarningAmber,
    riskLowBackground     = SuccessGreen.copy(alpha = 0.20f),
    riskLowContent        = SuccessGreen,
)

/** Provided by [KurisuTheme]; read as `KurisuTheme.extraColors`. */
val LocalKurisuColors = staticCompositionLocalOf { LightExtraColors }

/** One shared instance — the extra type scale does not vary with the theme mode. */
private val KurisuExtraTypographyValue = KurisuExtraTypography()

/** Accessors for the two theme extensions, mirroring `MaterialTheme.colorScheme`. */
object KurisuTheme {
    val extraColors: KurisuExtraColors
        @Composable @ReadOnlyComposable get() = LocalKurisuColors.current

    val extraTypography: KurisuExtraTypography
        @Composable @ReadOnlyComposable get() = LocalKurisuTypography.current
}

// ── Shapes: matching desktop (borderRadius: 6-8) ──────────────────
private val KurisuShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small      = RoundedCornerShape(6.dp),
    medium     = RoundedCornerShape(8.dp),
    large      = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

@Composable
fun KurisuTheme(
    themeMode: String = "system",
    content: @Composable () -> Unit,
) {
    val darkTheme = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val colorScheme = if (darkTheme) DarkColors else LightColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            @Suppress("DEPRECATION")
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    CompositionLocalProvider(
        LocalKurisuColors provides if (darkTheme) DarkExtraColors else LightExtraColors,
        LocalKurisuTypography provides KurisuExtraTypographyValue,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = KurisuTypography,
            shapes = KurisuShapes,
            content = content,
        )
    }
}
