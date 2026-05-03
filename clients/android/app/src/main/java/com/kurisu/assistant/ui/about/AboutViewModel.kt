package com.kurisu.assistant.ui.about

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.data.repository.VersionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

data class AboutUiState(
    val backendVersion: String? = null,
    val backendWireProtocol: Int? = null,
    val isCheckingUpdate: Boolean = false,
    val updateRelease: GithubRelease? = null,
    val updateProgress: Float? = null,
    val updateApkFile: File? = null,
    val message: String? = null,
)

@HiltViewModel
class AboutViewModel @Inject constructor(
    private val updateRepository: UpdateRepository,
    private val versionRepository: VersionRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AboutUiState())
    val state: StateFlow<AboutUiState> = _state

    init {
        viewModelScope.launch {
            versionRepository.fetchServerVersion()?.let { info ->
                _state.update { it.copy(
                    backendVersion = info.backendVersion,
                    backendWireProtocol = info.wireProtocol,
                ) }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun checkForUpdate() {
        viewModelScope.launch {
            _state.update { it.copy(isCheckingUpdate = true) }
            try {
                val release = updateRepository.checkForUpdate()
                if (release != null) {
                    _state.update { it.copy(updateRelease = release) }
                } else {
                    _state.update { it.copy(message = "You're on the latest version") }
                }
            } catch (e: Exception) {
                Log.e("AboutVM", "Update check failed", e)
                _state.update { it.copy(message = "Update check failed: ${e.message}") }
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
                _state.update { it.copy(updateProgress = null, message = "Download failed: ${e.message}") }
            }
        }
    }

    fun dismissUpdate() {
        _state.update { it.copy(updateRelease = null, updateProgress = null, updateApkFile = null) }
    }
}
