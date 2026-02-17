package com.kurisu.assistant.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val Primary = Color(0xFF2563EB)
private val OnPrimary = Color.White
private val PrimaryContainer = Color(0xFFD6E4FF)
private val OnPrimaryContainer = Color(0xFF001A41)
private val Secondary = Color(0xFF565F71)
private val OnSecondary = Color.White
private val SecondaryContainer = Color(0xFFDAE2F9)
private val Surface = Color.White
private val SurfaceVariant = Color(0xFFE1E2EC)
private val Background = Color.White
private val Error = Color(0xFFBA1A1A)

private val LightColors = lightColorScheme(
    primary = Primary,
    onPrimary = OnPrimary,
    primaryContainer = PrimaryContainer,
    onPrimaryContainer = OnPrimaryContainer,
    secondary = Secondary,
    onSecondary = OnSecondary,
    secondaryContainer = SecondaryContainer,
    surface = Surface,
    surfaceVariant = SurfaceVariant,
    background = Background,
    error = Error,
)

private val DarkPrimary = Color(0xFFAAC7FF)
private val DarkOnPrimary = Color(0xFF002F68)
private val DarkSurface = Color(0xFF1A1C1E)
private val DarkBackground = Color(0xFF1A1C1E)

private val DarkColors = darkColorScheme(
    primary = DarkPrimary,
    onPrimary = DarkOnPrimary,
    surface = DarkSurface,
    background = DarkBackground,
    error = Color(0xFFFFB4AB),
)

@Composable
fun KurisuTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
