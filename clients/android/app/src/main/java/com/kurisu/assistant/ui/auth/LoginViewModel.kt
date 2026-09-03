package com.kurisu.assistant.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject

@Serializable
private data class LoginQrPayload(
    @SerialName("v") val version: Int = 1,
    @SerialName("server") val server: String,
    @SerialName("username") val username: String,
    @SerialName("password") val password: String,
)

private val qrJson = Json { ignoreUnknownKeys = true }

data class LoginUiState(
    val isLoginMode: Boolean = true,
    val username: String = "",
    val password: String = "",
    val email: String = "",
    val serverUrl: String = PreferencesDataStore.DEFAULT_BACKEND_URL,
    val rememberMe: Boolean = true,
    val isLoading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val prefs: PreferencesDataStore,
    private val dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor,
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state

    private val _loginSuccess = MutableStateFlow<UserProfile?>(null)
    val loginSuccess: StateFlow<UserProfile?> = _loginSuccess

    init {
        viewModelScope.launch {
            val url = prefs.getBackendUrl()
            _state.update { it.copy(serverUrl = url) }
        }
    }

    fun setLoginMode(isLogin: Boolean) = _state.update { it.copy(isLoginMode = isLogin, error = null) }
    fun setUsername(v: String) = _state.update { it.copy(username = v) }
    fun setPassword(v: String) = _state.update { it.copy(password = v) }
    fun setEmail(v: String) = _state.update { it.copy(email = v) }
    fun setServerUrl(v: String) = _state.update { it.copy(serverUrl = v) }
    fun setRememberMe(v: Boolean) = _state.update { it.copy(rememberMe = v) }
    fun clearError() = _state.update { it.copy(error = null) }

    /**
     * Parse a QR code payload and, if it's a valid v1 login QR, populate the
     * form and submit. Returns true if the payload was applied (caller can
     * dismiss the scanner). Returns false if the QR is not ours.
     */
    fun applyLoginQr(raw: String): Boolean {
        val payload = try {
            qrJson.decodeFromString(LoginQrPayload.serializer(), raw)
        } catch (_: Exception) {
            _state.update { it.copy(error = "QR code is not a Kurisu login code") }
            return false
        }
        if (payload.version != 1) {
            _state.update { it.copy(error = "Unsupported QR version (${payload.version})") }
            return false
        }
        if (payload.server.isBlank() || payload.username.isBlank() || payload.password.isBlank()) {
            _state.update { it.copy(error = "QR code is missing fields") }
            return false
        }
        _state.update {
            it.copy(
                isLoginMode = true,
                serverUrl = payload.server,
                username = payload.username,
                password = payload.password,
                error = null,
            )
        }
        submit()
        return true
    }

    fun submit() {
        val s = _state.value
        if (s.username.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Username and password are required") }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                // Save and apply server URL
                val url = s.serverUrl.trim().trimEnd('/')
                prefs.setBackendUrl(url)
                dynamicBaseUrlInterceptor.setCachedBaseUrl(url)

                val user = if (s.isLoginMode) {
                    authRepository.login(s.username, s.password, s.rememberMe)
                } else {
                    authRepository.register(
                        s.username,
                        s.password,
                        s.email.ifBlank { null },
                        s.rememberMe,
                    )
                }
                _loginSuccess.value = user
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Authentication failed") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }
}
