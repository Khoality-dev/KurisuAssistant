package com.kurisu.assistant.ui.settings

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.service.NotificationDelivery
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
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

/**
 * Settings → Notifications (#353): one switch for this phone, on until the user
 * turns it off. Off unregisters the phone from push and stops listening; on
 * registers it again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationsViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var prefs: PreferencesDataStore
    private lateinit var control: NotificationDelivery

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        prefs = mockk(relaxed = true)
        control = mockk(relaxed = true)
        coEvery { prefs.getNotificationsEnabled() } returns true
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `starts on, as this phone left it`() = runTest(dispatcher) {
        val vm = NotificationsViewModel(prefs, control)
        advanceUntilIdle()
        assertThat(vm.enabled.value).isTrue()
    }

    @Test
    fun `turned off, the phone remembers and stops listening`() = runTest(dispatcher) {
        val vm = NotificationsViewModel(prefs, control)
        advanceUntilIdle()
        vm.setEnabled(false)
        advanceUntilIdle()
        assertThat(vm.enabled.value).isFalse()
        coVerify { prefs.setNotificationsEnabled(false) }
        verify { control.stop() }
    }

    @Test
    fun `turned back on, it listens again`() = runTest(dispatcher) {
        coEvery { prefs.getNotificationsEnabled() } returns false
        val vm = NotificationsViewModel(prefs, control)
        advanceUntilIdle()
        assertThat(vm.enabled.value).isFalse()
        vm.setEnabled(true)
        advanceUntilIdle()
        coVerify { prefs.setNotificationsEnabled(true) }
        verify { control.start() }
    }
}
