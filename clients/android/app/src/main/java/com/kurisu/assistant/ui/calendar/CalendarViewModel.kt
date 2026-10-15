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

    fun select(id: Int?) = _state.update { it.copy(selectedId = id) }

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
        _state.update { it.copy(selectedId = id) }
        viewModelScope.launch {
            runCatching { repo.get(id) }.onSuccess { entry ->
                CalendarMath.dayOf(entry, zone)?.let { day ->
                    if (_state.value.selectedId == id) setAnchor(day)
                }
            }
        }
    }

    fun create(body: CalendarEntryCreate, onDone: () -> Unit = {}) = change {
        val made = repo.create(body)
        _state.update { it.copy(selectedId = made.id) }
        onDone()
    }

    fun move(id: Int, changes: CalendarEntryUpdate, onDone: () -> Unit = {}) = change {
        repo.update(id, changes)
        onDone()
    }

    fun setDone(id: Int, done: Boolean) = change { repo.update(id, CalendarEntryUpdate(done = done)) }

    fun delete(id: Int) = change {
        repo.delete(id)
        if (_state.value.selectedId == id) _state.update { it.copy(selectedId = null) }
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
