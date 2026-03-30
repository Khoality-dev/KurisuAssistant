package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AppearanceUiState(
    val themeMode: String = "system", // "light", "dark", "system"
)

@HiltViewModel
class AppearanceViewModel @Inject constructor(
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(AppearanceUiState())
    val state: StateFlow<AppearanceUiState> = _state

    init {
        viewModelScope.launch {
            val mode = prefs.getThemeMode()
            _state.update { it.copy(themeMode = mode) }
        }
    }

    fun setThemeMode(mode: String) {
        _state.update { it.copy(themeMode = mode) }
        viewModelScope.launch { prefs.setThemeMode(mode) }
    }
}
