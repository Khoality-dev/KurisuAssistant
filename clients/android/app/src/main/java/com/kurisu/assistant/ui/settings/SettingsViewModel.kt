package com.kurisu.assistant.ui.settings

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.repository.FaceRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Backs the grouped Settings index.
 *
 * Settings is a table of contents: every row that edits something navigates to
 * the screen that owns it (Account, Appearance, TTS & ASR, Face Identities,
 * About). Only two things are decided here, because they have nowhere else to
 * live: the auto-update preference and the manual update check.
 *
 * The old view model held the whole of Account, TTS, ASR and the microphone
 * test as well — a duplicate of four screens that no route reached. That is
 * gone rather than kept in parallel.
 */
data class SettingsUiState(
    val autoUpdate: Boolean = true,
    val isCheckingUpdate: Boolean = false,
    /** Result of the last manual check, shown under the row. */
    val updateStatus: String? = null,
    val updateRelease: GithubRelease? = null,
    val updateProgress: Float? = null,
    val updateApkFile: java.io.File? = null,
    /** null while the count is unknown — the row falls back to static copy. */
    val faceCount: Int? = null,
    val message: String? = null,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val prefs: PreferencesDataStore,
    private val updateRepository: UpdateRepository,
    private val faceRepository: FaceRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state

    init {
        viewModelScope.launch {
            _state.update { it.copy(autoUpdate = prefs.getAutoUpdate()) }
        }
        loadFaceCount()
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun setAutoUpdate(enabled: Boolean) {
        viewModelScope.launch {
            prefs.setAutoUpdate(enabled)
            _state.update { it.copy(autoUpdate = enabled) }
        }
    }

    /**
     * The count is decoration, not a gate: a failed call leaves it null and the
     * row keeps its static sub-label rather than showing a wrong number.
     */
    private fun loadFaceCount() {
        viewModelScope.launch {
            try {
                _state.update { it.copy(faceCount = faceRepository.listFaces().size) }
            } catch (e: Exception) {
                Log.d(TAG, "Face count unavailable: ${e.message}")
            }
        }
    }

    fun checkForUpdate() {
        if (_state.value.isCheckingUpdate) return
        viewModelScope.launch {
            _state.update { it.copy(isCheckingUpdate = true, updateStatus = null) }
            try {
                val release = updateRepository.checkForUpdate()
                if (release != null) {
                    _state.update { it.copy(updateRelease = release) }
                } else {
                    _state.update { it.copy(updateStatus = "You're on the latest version") }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Update check failed", e)
                _state.update { it.copy(updateStatus = "Check failed — ${e.message}") }
            } finally {
                _state.update { it.copy(isCheckingUpdate = false) }
            }
        }
    }

    fun downloadAndInstall() {
        val release = _state.value.updateRelease ?: return
        val apkAsset = release.assets.firstOrNull { it.name.endsWith(".apk") } ?: return

        viewModelScope.launch {
            _state.update { it.copy(updateProgress = 0f) }
            try {
                val file = updateRepository.downloadApk(apkAsset.browserDownloadUrl) { progress ->
                    _state.update { it.copy(updateProgress = progress) }
                }
                _state.update { it.copy(updateApkFile = file, updateProgress = 1f) }
            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                _state.update {
                    it.copy(updateProgress = null, message = "Download failed: ${e.message}")
                }
            }
        }
    }

    fun dismissUpdate() {
        _state.update {
            it.copy(updateRelease = null, updateProgress = null, updateApkFile = null)
        }
    }

    private companion object {
        const val TAG = "SettingsVM"
    }
}
