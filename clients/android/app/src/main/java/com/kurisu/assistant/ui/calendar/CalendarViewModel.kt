package com.kurisu.assistant.ui.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.CalendarEntry
import com.kurisu.assistant.data.model.CalendarEntryCreate
import com.kurisu.assistant.data.model.CalendarEntryUpdate
import com.kurisu.assistant.data.repository.CalendarRepository
import com.kurisu.assistant.domain.calendar.CalendarMath
import com.kurisu.assistant.domain.calendar.CalendarView
import com.kurisu.assistant.ui.assistant.apiErrorMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject

data class CalendarUiState(
    val view: CalendarView = CalendarView.DAY,
    val anchor: LocalDate = LocalDate.now(),
    val entries: List<CalendarEntry> = emptyList(),
    val upcoming: List<CalendarEntry> = emptyList(),
    val selectedId: Int? = null,
    /** Which time of the selected entry: a repeating reminder's are separate entries (#355). */
    val selectedAt: String? = null,
    val loading: Boolean = false,
    /** The last refusal or failure, as a sentence. */
    val error: String? = null,
)

/**
 * The Calendar screen (#282): which day or week it shows, what is in it,
 * the selected entry, and the changes it sends.
 *
 * The server is the record. Every change is sent and the window re-read, so
 * the screen shows what the server has — including what the assistant put
 * there from a chat. A phone opens on today's day; the week is one tap away.
 * [openEntry] is the navigation target a reminder notification's tap uses
 * (#353): that entry's day, with it selected.
 *
 * A repeating reminder (#355) is several entries with one id, so the selection
 * is the id and the time, and Done on one names the time.
 */
@HiltViewModel
class CalendarViewModel @Inject constructor(
    private val repo: CalendarRepository,
    private val clock: Clock,
) : ViewModel() {

    val zone: ZoneId get() = clock.zone

    private val _state = MutableStateFlow(CalendarUiState(anchor = LocalDate.now(clock)))
    val state: StateFlow<CalendarUiState> = _state.asStateFlow()

    init {
        load()
    }

    private fun currentDay(): LocalDate = LocalDate.now(clock)

    fun setView(view: CalendarView) {
        _state.update { it.copy(view = view) }
        load()
    }

    fun setAnchor(day: LocalDate) {
        _state.update { it.copy(anchor = day) }
        load()
    }

    fun step(direction: Int) {
        val s = _state.value
        setAnchor(s.anchor.plusDays(direction.toLong() * if (s.view == CalendarView.WEEK) 7 else 1))
    }

    fun today() = setAnchor(currentDay())

    fun select(id: Int?, at: String? = null) = _state.update { it.copy(selectedId = id, selectedAt = if (id == null) null else at) }

    fun clearError() = _state.update { it.copy(error = null) }

    fun load() {
        val s = _state.value
        val window = CalendarMath.window(s.view, s.anchor, zone)
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            runCatching {
                repo.list(window.start.toString(), window.end.toString()) to repo.upcoming()
            }.onSuccess { (entries, upcoming) ->
                // An answer for a window already left is dropped.
                if (_state.value.anchor == s.anchor && _state.value.view == s.view) {
                    _state.update { it.copy(entries = entries, upcoming = upcoming, loading = false) }
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = apiErrorMessage(e, "The calendar could not be loaded.")) }
            }
        }
    }

    fun openEntry(id: Int) {
        _state.update { it.copy(selectedId = id, selectedAt = null) }
        viewModelScope.launch {
            runCatching { repo.get(id) }.onSuccess { entry ->
                // A repeating reminder answers as its time from today on — the one to show.
                if (entry.isRepeating && _state.value.selectedId == id) {
                    _state.update { it.copy(selectedAt = entry.startsAt) }
                }
                CalendarMath.dayOf(entry, zone)?.let { day ->
                    if (_state.value.selectedId == id) setAnchor(day)
                }
            }
        }
    }

    fun create(body: CalendarEntryCreate, onDone: () -> Unit = {}) = change {
        val made = repo.create(body)
        _state.update { it.copy(selectedId = made.id, selectedAt = if (made.isRepeating) made.startsAt else null) }
        onDone()
    }

    fun move(id: Int, changes: CalendarEntryUpdate, onDone: () -> Unit = {}) = change {
        repo.update(id, changes)
        onDone()
    }

    /** [occurrenceAt]: the time of a repeating reminder this is about. */
    fun setDone(id: Int, done: Boolean, occurrenceAt: String? = null) =
        change { repo.update(id, CalendarEntryUpdate(done = done, occurrenceAt = occurrenceAt)) }

    fun delete(id: Int) = change {
        repo.delete(id)
        if (_state.value.selectedId == id) _state.update { it.copy(selectedId = null, selectedAt = null) }
    }

    /** Run a change, then re-read; a failure is kept as a sentence. */
    private fun change(block: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess {
                    _state.update { it.copy(error = null) }
                    load()
                }
                .onFailure { e -> _state.update { it.copy(error = apiErrorMessage(e, "The calendar could not be changed.")) } }
        }
    }
}
