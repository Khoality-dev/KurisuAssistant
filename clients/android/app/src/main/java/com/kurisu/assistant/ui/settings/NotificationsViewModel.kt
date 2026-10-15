package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.service.NotificationDelivery
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Settings → Notifications (#353): one switch for this phone. Off unregisters
 * it from push and stops listening; on registers it again. The desktop has the
 * same switch for itself; neither changes the other. What is unread is the
 * bell's, on the Chats screen.
 */
@HiltViewModel
class NotificationsViewModel @Inject constructor(
    private val prefs: PreferencesDataStore,
    private val control: NotificationDelivery,
) : ViewModel() {

    private val _enabled = MutableStateFlow(true)
    val enabled: StateFlow<Boolean> = _enabled

    init {
        viewModelScope.launch { _enabled.value = prefs.getNotificationsEnabled() }
    }

    fun setEnabled(on: Boolean) {
        _enabled.value = on
        viewModelScope.launch {
            prefs.setNotificationsEnabled(on)
            if (on) control.start() else control.stop()
        }
    }

}
