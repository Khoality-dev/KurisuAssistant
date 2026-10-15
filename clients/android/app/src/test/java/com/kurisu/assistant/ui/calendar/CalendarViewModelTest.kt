package com.kurisu.assistant.ui.calendar

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.CalendarEntry
import com.kurisu.assistant.data.model.CalendarEntryCreate
import com.kurisu.assistant.data.model.CalendarEntryUpdate
import com.kurisu.assistant.data.repository.CalendarRepository
import com.kurisu.assistant.domain.calendar.CalendarView
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The Calendar screen's state (#282): the window it shows, what is in it,
 * the selected entry, and the changes it sends. The server is the record —
 * every change is sent and the window re-read.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class CalendarViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val la = ZoneId.of("America/Los_Angeles")
    // Tuesday 13 October 2026, 15:20 in Los Angeles.
    private val clock = Clock.fixed(Instant.parse("2026-10-13T22:20:00Z"), la)
    private lateinit var repo: CalendarRepository

    private val callMom = CalendarEntry(
        id = 7, kind = "reminder", title = "Call Mom", startsAt = "2026-10-17T02:00:00Z",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        coEvery { repo.list(any(), any()) } returns listOf(callMom)
        coEvery { repo.upcoming(any()) } returns listOf(callMom)
        coEvery { repo.get(7) } returns callMom
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel() = CalendarViewModel(repo, clock)

    @Test
    fun `opens on today's week and loads it in UTC`() = runTest(dispatcher) {
        val start = slot<String>()
        val end = slot<String>()
        coEvery { repo.list(capture(start), capture(end)) } returns listOf(callMom)

        val vm = viewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.view).isEqualTo(CalendarView.DAY)
        assertThat(vm.state.value.anchor).isEqualTo(LocalDate.of(2026, 10, 13))
        assertThat(start.captured).isEqualTo("2026-10-13T07:00:00Z")
        assertThat(end.captured).isEqualTo("2026-10-14T07:00:00Z")
        assertThat(vm.state.value.upcoming.map { it.id }).containsExactly(7)
    }

    @Test
    fun `week view and stepping move the window`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.setView(CalendarView.WEEK)
        vm.step(1)
        advanceUntilIdle()
        assertThat(vm.state.value.anchor).isEqualTo(LocalDate.of(2026, 10, 20))
        coVerify { repo.list("2026-10-19T07:00:00Z", "2026-10-26T07:00:00Z") }
        vm.today()
        assertThat(vm.state.value.anchor).isEqualTo(LocalDate.of(2026, 10, 13))
    }

    @Test
    fun `a reminder opened from a notification shows its day, selected`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.openEntry(7)
        advanceUntilIdle()
        assertThat(vm.state.value.selectedId).isEqualTo(7)
        assertThat(vm.state.value.anchor).isEqualTo(LocalDate.of(2026, 10, 16))
    }

    @Test
    fun `done, delete and create are sent, then the window is re-read`() = runTest(dispatcher) {
        coEvery { repo.create(any()) } returns callMom.copy(id = 9, title = "Water the plants")
        val vm = viewModel()
        advanceUntilIdle()

        vm.setDone(7, true)
        advanceUntilIdle()
        coVerify { repo.update(7, CalendarEntryUpdate(done = true)) }

        vm.select(7)
        vm.delete(7)
        advanceUntilIdle()
        coVerify { repo.delete(7) }
        assertThat(vm.state.value.selectedId).isNull()

        vm.create(CalendarEntryCreate(kind = "reminder", title = "Water the plants", startsAt = "2026-10-14T15:00:00Z"))
        advanceUntilIdle()
        assertThat(vm.state.value.selectedId).isEqualTo(9)
        coVerify(atLeast = 4) { repo.list(any(), any()) }
    }

    @Test
    fun `a refusal is a sentence on the screen`() = runTest(dispatcher) {
        coEvery { repo.create(any()) } throws IllegalStateException("A reminder needs a date and a time.")
        val vm = viewModel()
        vm.create(CalendarEntryCreate(kind = "reminder", title = "x"))
        advanceUntilIdle()
        assertThat(vm.state.value.error).isEqualTo("A reminder needs a date and a time.")
    }
}
