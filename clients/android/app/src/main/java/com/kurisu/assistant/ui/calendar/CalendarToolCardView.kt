package com.kurisu.assistant.ui.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import com.kurisu.assistant.data.repository.CalendarRepository
import com.kurisu.assistant.domain.calendar.CalendarMath
import com.kurisu.assistant.domain.calendar.CalendarToolAction
import com.kurisu.assistant.domain.calendar.CalendarToolCard
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import java.time.Clock
import javax.inject.Inject

/**
 * Opens the Calendar on one entry. Provided by the nav graph, so a chat card
 * can reach the Calendar without holding a NavController.
 */
val LocalOpenCalendar = compositionLocalOf<(Int) -> Unit> { {} }

/** What "Undo" on a chat card needs: the one call that takes an entry back off. */
@HiltViewModel
class CalendarCardViewModel @Inject constructor(
    private val repo: CalendarRepository,
    val clock: Clock,
) : ViewModel() {
    suspend fun undo(id: Int): Boolean = runCatching { repo.delete(id) }.isSuccess
}

/**
 * How a calendar tool call looks in the chat (#282): what went on the calendar
 * and when, with "Open in Calendar" and — for something just added — "Undo".
 * The desktop's `CalendarToolCard.tsx` draws the same card.
 */
@Composable
fun CalendarToolCardView(
    card: CalendarToolCard,
    modifier: Modifier = Modifier,
    viewModel: CalendarCardViewModel = hiltViewModel(),
) {
    val openCalendar = LocalOpenCalendar.current
    val scope = rememberCoroutineScope()
    var undone by remember(card) { mutableStateOf(false) }
    val zone = viewModel.clock.zone
    val isReminder = (card.entry?.kind ?: card.deleted?.kind) == "reminder"
    val tint = if (isReminder) Color(0xFFB45309) else Color(0xFF1D4ED8)
    val kindLabel = if (isReminder) "Reminder" else "Event"
    val heading = when {
        undone || card.action == CalendarToolAction.DELETED -> "Removed from your calendar"
        card.action == CalendarToolAction.CREATED -> "$kindLabel added to your calendar"
        else -> "$kindLabel moved on your calendar"
    }
    val entry = card.entry

    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(
                if (isReminder) Icons.Outlined.NotificationsNone else Icons.Outlined.Event,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(16.dp),
            )
            Text(heading, style = MaterialTheme.typography.labelMedium, color = tint)
        }
        Text(
            entry?.title ?: card.deleted?.title.orEmpty(),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            textDecoration = if (undone) TextDecoration.LineThrough else null,
        )
        if (entry != null) {
            val day = CalendarMath.dayOf(entry, zone)
            Text(
                listOfNotNull(day?.let(CalendarMath::shortDate), CalendarMath.describeWhen(entry, zone)).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!undone) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { openCalendar(entry.id) }) { Text("Open in Calendar") }
                    if (card.action == CalendarToolAction.CREATED) {
                        TextButton(onClick = { scope.launch { if (viewModel.undo(entry.id)) undone = true } }) { Text("Undo") }
                    }
                }
            }
        }
    }
}
