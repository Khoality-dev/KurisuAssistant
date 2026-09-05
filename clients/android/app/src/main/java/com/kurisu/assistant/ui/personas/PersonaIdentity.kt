package com.kurisu.assistant.ui.personas

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import com.kurisu.assistant.ui.common.personaInitials

/**
 * An avatar image when the persona has one, its initials when it does not.
 *
 * [avatarUrl] is a plain `/images/{uuid}` URL: Coil is built on the app's
 * authenticated OkHttpClient (see `KurisuApplication`), so no token needs to be
 * threaded onto the query string.
 */
@Composable
fun PersonaAvatar(
    name: String,
    avatarUrl: String?,
    size: Dp,
    modifier: Modifier = Modifier,
    containerColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primaryContainer,
    contentColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onPrimaryContainer,
) {
    if (avatarUrl != null) {
        SubcomposeAsyncImage(
            model = avatarUrl,
            contentDescription = name,
            modifier = modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
            loading = { InitialsAvatar(name, size, containerColor, contentColor) },
            error = { InitialsAvatar(name, size, containerColor, contentColor) },
            success = { SubcomposeAsyncImageContent() },
        )
    } else {
        InitialsAvatar(name, size, containerColor, contentColor, modifier)
    }
}

@Composable
private fun InitialsAvatar(
    name: String,
    size: Dp,
    containerColor: androidx.compose.ui.graphics.Color,
    contentColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.size(size),
        shape = CircleShape,
        color = containerColor,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = personaInitials(name),
                style = if (size >= 64.dp) MaterialTheme.typography.headlineSmall
                else MaterialTheme.typography.titleSmall,
                color = contentColor,
            )
        }
    }
}

/**
 * The metadata line under a persona's name, matching the design: the voice it
 * speaks with, then whether it has a character rig. A disabled persona says so,
 * because a disabled one cannot answer and cannot be made the default.
 */
fun personaMeta(
    voiceReference: String?,
    hasCharacterConfig: Boolean,
    enabled: Boolean = true,
): String = buildString {
    append(voiceReference?.takeIf { it.isNotBlank() } ?: "no voice")
    if (hasCharacterConfig) append(" · character")
    if (!enabled) append(" · disabled")
}
