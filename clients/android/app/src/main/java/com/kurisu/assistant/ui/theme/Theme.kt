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
import androidx.compose.runtime.SideEffect
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
private val Blue600 = Color(0xFF2563EB)
private val Blue700 = Color(0xFF1D4ED8)

// ── Semantic colors ────────────────────────────────────────────────
private val ErrorRed     = Color(0xFFEF4444)
private val ErrorBg      = Color(0xFFFEE2E2)
private val SuccessGreen = Color(0xFF22C55E)
private val WarningAmber = Color(0xFFF59E0B)

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
        fontWeight = FontWeight.Light,
        fontSize = 44.sp,
        lineHeight = 48.sp,
        letterSpacing = (-1.5).sp,
    ),
    displayMedium = TextStyle(
        fontWeight = FontWeight.Light,
        fontSize = 36.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineLarge = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineMedium = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 24.sp,
        lineHeight = 30.sp,
        letterSpacing = (-0.25).sp,
    ),
    headlineSmall = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 26.sp,
        letterSpacing = 0.sp,
    ),
    titleLarge = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 18.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    ),
    titleMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
    ),
    titleSmall = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.1.sp,
    ),
    bodyLarge = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.15.sp,
    ),
    bodyMedium = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.15.sp,
    ),
    bodySmall = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.2.sp,
    ),
    labelLarge = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
    ),
    labelMedium = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp,
    ),
    labelSmall = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.5.sp,
    ),
)

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

    MaterialTheme(
        colorScheme = colorScheme,
        typography = KurisuTypography,
        shapes = KurisuShapes,
        content = content,
    )
}
