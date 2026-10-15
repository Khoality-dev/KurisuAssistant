@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.kurisu.assistant.ui.calendar

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.CalendarEntry
import com.kurisu.assistant.data.model.CalendarEntryCreate
import com.kurisu.assistant.data.model.CalendarEntryUpdate
import com.kurisu.assistant.domain.calendar.CalendarMath
import com.kurisu.assistant.domain.calendar.CalendarView
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

private val ReminderTint = Color(0xFFB45309)
private val EventTint = Color(0xFF1D4ED8)
private val AllDayTint = Color(0xFF7E22CE)

/**
 * The calendar (#282): the user's events and reminders by day or by week.
 *
 * A phone opens on today: the week strip on top, the day's entries in time
 * order with the now-line among them, and "Coming up" below. The week view
 * lists every day of the week. Tapping an entry opens its sheet — Done, Move,
 * Delete. Nothing here says who put an entry on the calendar, and nothing here
 * starts the assistant. [openReminderId] is the navigation target a reminder
 * notification opens (#353).
 */

@Composable
fun CalendarScreen(
    onOpenMenu: () -> Unit,
    openReminderId: Int? = null,
    viewModel: CalendarViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val zone = viewModel.zone
    var editor by remember { mutableStateOf<EditorTarget?>(null) }

    LaunchedEffect(openReminderId) {
        openReminderId?.let(viewModel::openEntry)
    }

    val selected = state.selectedId?.let { id ->
        state.entries.firstOrNull { it.id == id } ?: state.upcoming.firstOrNull { it.id == id }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Calendar") },
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) { Icon(Icons.Outlined.Menu, contentDescription = "Menu") }
                },
                actions = { TextButton(onClick = viewModel::today) { Text("Today") } },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { editor = EditorTarget(null) }) {
                Icon(Icons.Outlined.Add, contentDescription = "New event or reminder")
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { viewModel.step(-1) }) {
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, contentDescription = "Previous")
                }
                Text(
                    CalendarMath.title(state.view, state.anchor),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = { viewModel.step(1) }) {
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = "Next")
                }
            }
            SingleChoiceSegmentedButtonRow(Modifier.padding(horizontal = 16.dp).fillMaxWidth()) {
                listOf(CalendarView.DAY to "Day", CalendarView.WEEK to "Week").forEachIndexed { i, (view, label) ->
                    SegmentedButton(
                        selected = state.view == view,
                        onClick = { viewModel.setView(view) },
                        shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                    ) { Text(label) }
                }
            }
            WeekStrip(
                anchor = state.anchor,
                today = LocalDate.now(zone),
                entries = state.entries,
                zone = zone,
                onPick = { day ->
                    viewModel.setAnchor(day)
                    if (state.view == CalendarView.WEEK) viewModel.setView(CalendarView.DAY)
                },
            )
            state.error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            HorizontalDivider()
            LazyColumn(
                modifier = Modifier.weight(1f).testTag("calendar-list"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val window = CalendarMath.window(state.view, state.anchor, zone)
                val today = LocalDate.now(zone)
                window.days.forEach { day ->
                    val dayEntries = CalendarMath.onDay(state.entries, day, zone)
                    item(key = "h-$day") {
                        Text(
                            dayHeading(day, today),
                            style = MaterialTheme.typography.labelLarge,
                            color = if (day == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                    if (dayEntries.isEmpty()) {
                        item(key = "e-$day") {
                            Text("Nothing on this day.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    var nowShown = day != today
                    dayEntries.forEach { entry ->
                        val start = CalendarMath.startOf(entry, zone)
                        if (!nowShown && !entry.allDay && start != null && start.toInstant().isAfter(Instant.now())) {
                            nowShown = true
                            item(key = "now-$day") { NowLine() }
                        }
                        item(key = "${day}-${entry.id}") {
                            EntryRow(entry, zone, selected = entry.id == state.selectedId) { viewModel.select(entry.id) }
                        }
                    }
                    if (!nowShown && dayEntries.isNotEmpty()) item(key = "now-end-$day") { NowLine() }
                }
                val shownIds = state.entries.map { it.id }.toSet()
                val later = state.upcoming.filter { it.id !in shownIds }
                if (later.isNotEmpty()) {
                    item(key = "later") {
                        Text(
                            "Coming up",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                    items(later, key = { "u-${it.id}" }) { entry ->
                        UpcomingRow(entry, zone) {
                            viewModel.select(entry.id)
                            CalendarMath.dayOf(entry, zone)?.let(viewModel::setAnchor)
                        }
                    }
                }
            }
        }
    }

    if (selected != null) {
        ModalBottomSheet(onDismissRequest = { viewModel.select(null) }) {
            EntrySheet(
                entry = selected,
                zone = zone,
                onDone = { viewModel.setDone(selected.id, !selected.done) },
                onMove = { editor = EditorTarget(selected) },
                onDelete = { viewModel.delete(selected.id) },
            )
        }
    }

    editor?.let { target ->
        EntryEditor(
            entry = target.entry,
            defaultDay = state.anchor,
            zone = zone,
            error = state.error,
            onDismiss = {
                editor = null
                viewModel.clearError()
            },
            onCreate = { body -> viewModel.create(body) { editor = null } },
            onMove = { id, changes -> viewModel.move(id, changes) { editor = null } },
        )
    }
}

private data class EditorTarget(val entry: CalendarEntry?)

private fun dayHeading(day: LocalDate, today: LocalDate): String {
    val name = "${day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)} ${day.dayOfMonth} " +
        day.month.getDisplayName(TextStyle.FULL, Locale.ENGLISH)
    return if (day == today) "Today · $name" else name
}

@Composable
private fun WeekStrip(
    anchor: LocalDate,
    today: LocalDate,
    entries: List<CalendarEntry>,
    zone: ZoneId,
    onPick: (LocalDate) -> Unit,
) {
    val first = CalendarMath.weekStart(anchor)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        (0 until 7).forEach { i ->
            val day = first.plusDays(i.toLong())
            val isAnchor = day == anchor
            val hasEntries = CalendarMath.onDay(entries, day, zone).isNotEmpty()
            Column(
                modifier = Modifier
                    .weight(1f)
                    .height(62.dp)
                    .background(
                        if (isAnchor) MaterialTheme.colorScheme.primary else Color.Transparent,
                        RoundedCornerShape(14.dp),
                    )
                    .clickable { onPick(day) },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                val color = when {
                    isAnchor -> MaterialTheme.colorScheme.onPrimary
                    day == today -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurface
                }
                Text(day.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ENGLISH), style = MaterialTheme.typography.labelSmall, color = color)
                Text("${day.dayOfMonth}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = color)
                Box(
                    Modifier.size(5.dp).background(
                        if (hasEntries) color.copy(alpha = 0.6f) else Color.Transparent,
                        CircleShape,
                    ),
                )
            }
        }
    }
}

@Composable
private fun NowLine() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(MaterialTheme.colorScheme.error, CircleShape))
        Box(Modifier.weight(1f).height(2.dp).background(MaterialTheme.colorScheme.error))
    }
}

@Composable
private fun EntryRow(entry: CalendarEntry, zone: ZoneId, selected: Boolean, onClick: () -> Unit) {
    val tint = when {
        entry.isReminder -> ReminderTint
        entry.allDay -> AllDayTint
        else -> EventTint
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = if (selected) MaterialTheme.colorScheme.primary else tint.copy(alpha = 0.25f),
                shape = RoundedCornerShape(14.dp),
            )
            .clickable(onClick = onClick)
            .padding(12.dp)
            .testTag("calendar-entry-${entry.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(entryIcon(entry), contentDescription = if (entry.isReminder) "Reminder" else "Event", tint = tint, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f)) {
            Text(
                entry.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                textDecoration = if (entry.done) TextDecoration.LineThrough else null,
            )
            Text(
                CalendarMath.describeWhen(entry, zone) + if (entry.isReminder) " · Reminder" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun UpcomingRow(entry: CalendarEntry, zone: ZoneId, onClick: () -> Unit) {
    val day = CalendarMath.dayOf(entry, zone)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.width(44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(day?.dayOfWeek?.getDisplayName(TextStyle.SHORT, Locale.ENGLISH).orEmpty(), style = MaterialTheme.typography.labelSmall)
            Text(day?.dayOfMonth?.toString().orEmpty(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        }
        Icon(entryIcon(entry), contentDescription = null, tint = if (entry.isReminder) ReminderTint else EventTint, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(CalendarMath.describeWhen(entry, zone), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun entryIcon(entry: CalendarEntry) = when {
    entry.isReminder -> Icons.Outlined.NotificationsNone
    entry.allDay -> Icons.Outlined.Cake
    else -> Icons.Outlined.Event
}

@Composable
private fun EntrySheet(
    entry: CalendarEntry,
    zone: ZoneId,
    onDone: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (entry.isReminder) "Reminder" else "Event", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            entry.title,
            style = MaterialTheme.typography.headlineSmall,
            textDecoration = if (entry.done) TextDecoration.LineThrough else null,
        )
        val day = CalendarMath.dayOf(entry, zone)
        Text(
            listOfNotNull(day?.let(CalendarMath::shortDate), CalendarMath.describeWhen(entry, zone)).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (entry.isReminder) {
            Text(
                "Notifies your devices when it is due, even with the app closed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        entry.notes?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (entry.isReminder) {
                Button(onClick = onDone) {
                    Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (entry.done) "Not done" else "Done")
                }
            }
            OutlinedButton(onClick = onMove) { Text("Move") }
            TextButton(onClick = onDelete) {
                Icon(Icons.Outlined.Delete, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.width(6.dp))
                Text("Delete", color = MaterialTheme.colorScheme.error)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** New entry, or Move. Dates and times come from the platform pickers. */
@Composable
private fun EntryEditor(
    entry: CalendarEntry?,
    defaultDay: LocalDate,
    zone: ZoneId,
    error: String?,
    onDismiss: () -> Unit,
    onCreate: (CalendarEntryCreate) -> Unit,
    onMove: (Int, CalendarEntryUpdate) -> Unit,
) {
    val context = LocalContext.current
    val start = entry?.let { CalendarMath.startOf(it, zone) }
    var kind by remember { mutableStateOf(entry?.kind ?: "event") }
    var title by remember { mutableStateOf(entry?.title ?: "") }
    var allDay by remember { mutableStateOf(entry?.allDay ?: false) }
    var date by remember { mutableStateOf(entry?.let { CalendarMath.dayOf(it, zone) } ?: defaultDay) }
    var time by remember {
        mutableStateOf(start?.toLocalTime() ?: LocalTime.now(zone).plusHours(1).withMinute(0).withSecond(0).withNano(0))
    }
    val isReminder = kind == "reminder"
    val timed = isReminder || !allDay

    fun instant(day: LocalDate, at: LocalTime) = day.atTime(at).atZone(zone).toInstant().toString()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (entry == null) "New entry" else "Move ${entry.kind}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (entry == null) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf("event" to "Event", "reminder" to "Reminder").forEachIndexed { i, (value, label) ->
                            SegmentedButton(
                                selected = kind == value,
                                onClick = { kind = value },
                                shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                            ) { Text(label) }
                        }
                    }
                }
                OutlinedTextField(
                    value = title,
                    onValueChange = { if (it.length <= 200) title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("calendar-title"),
                )
                if (!isReminder && entry == null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = allDay, onCheckedChange = { allDay = it })
                        Text("All day")
                    }
                }
                OutlinedButton(
                    onClick = {
                        DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(CalendarMath.shortDate(date) + " ${date.year}") }
                if (timed) {
                    OutlinedButton(
                        onClick = {
                            TimePickerDialog(context, { _, h, min -> time = LocalTime.of(h, min) }, time.hour, time.minute, true).show()
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(String.format(Locale.ROOT, "%02d:%02d", time.hour, time.minute)) }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = title.isNotBlank(),
                onClick = {
                    if (entry != null) {
                        onMove(
                            entry.id,
                            if (entry.allDay) {
                                CalendarEntryUpdate(title = title, startDate = date.toString())
                            } else {
                                CalendarEntryUpdate(title = title, startsAt = instant(date, time))
                            },
                        )
                    } else if (timed) {
                        onCreate(CalendarEntryCreate(kind = kind, title = title, startsAt = instant(date, time)))
                    } else {
                        onCreate(CalendarEntryCreate(kind = kind, title = title, allDay = true, startDate = date.toString(), endDate = date.toString()))
                    }
                },
            ) { Text(if (entry == null) "Add" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
