package com.kurisu.assistant.ui.navigation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Backs the one action in the drawer that is not navigation.
 *
 * Logout used to live on `ChatViewModel`, which meant it only existed while the
 * chat was on screen. The drawer now hangs above every destination, so the
 * action needs a holder of its own — a deliberately tiny one, because a drawer
 * must not pay for a screen's worth of loading.
 */
@HiltViewModel
class AppDrawerViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {

    fun logout(onLoggedOut: () -> Unit) {
        viewModelScope.launch {
            try {
                authRepository.logout()
            } catch (_: Exception) {
                // Clearing tokens is local work, but a websocket teardown can
                // still throw; the user asked to leave, so leave regardless.
            }
            onLoggedOut()
        }
    }
}
