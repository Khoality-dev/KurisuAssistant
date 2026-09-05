package com.kurisu.assistant.ui.chat

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.kurisu.assistant.ui.common.personaInitials

/**
 * A persona's face: the uploaded avatar when there is one, the monogram when
 * there is not. [avatarUrl] is already resolved against the backend base URL.
 */
@Composable
fun PersonaAvatar(
    name: String?,
    avatarUrl: String?,
    size: Dp = 32.dp,
    fontSize: TextUnit = 12.sp,
    modifier: Modifier = Modifier,
) {
    if (avatarUrl != null) {
        AsyncImage(
            model = avatarUrl,
            contentDescription = name,
            modifier = modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    } else {
        Surface(
            modifier = modifier.size(size),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.secondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    text = personaInitials(name),
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontSize = fontSize,
                        fontWeight = FontWeight.SemiBold,
                    ),
                )
            }
        }
    }
}
