package com.kurisu.assistant.ui.faces

import android.app.Application
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.FaceIdentity
import com.kurisu.assistant.data.model.FaceIdentityDetail
import com.kurisu.assistant.data.repository.FaceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

data class FaceIdentitiesUiState(
    val identities: List<FaceIdentity> = emptyList(),
    val isLoading: Boolean = false,
    val message: String? = null,
    val baseUrl: String = "",
    // Create dialog state
    val showCreateDialog: Boolean = false,
    val createName: String = "",
    val createPhotoPath: String? = null,
    val creating: Boolean = false,
    // Detail dialog
    val detail: FaceIdentityDetail? = null,
    val loadingDetail: Boolean = false,
    val pendingDeleteIdentityId: Int? = null,
)

@HiltViewModel
class FaceIdentitiesViewModel @Inject constructor(
    private val application: Application,
    private val repository: FaceRepository,
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    companion object { private const val TAG = "FaceIdentitiesVM" }

    private val _state = MutableStateFlow(FaceIdentitiesUiState())
    val state: StateFlow<FaceIdentitiesUiState> = _state

    init {
        viewModelScope.launch {
            _state.update { it.copy(baseUrl = prefs.getBackendUrl()) }
            loadIdentities()
        }
    }

    fun loadIdentities() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val list = repository.listFaces()
                _state.update { it.copy(identities = list, isLoading = false) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load identities", e)
                _state.update { it.copy(
                    isLoading = false,
                    message = "Failed to load: ${e.message}",
                ) }
            }
        }
    }

    fun openCreateDialog() = _state.update { it.copy(
        showCreateDialog = true,
        createName = "",
        createPhotoPath = null,
    ) }

    fun dismissCreateDialog() = _state.update { it.copy(showCreateDialog = false) }

    fun setCreateName(name: String) = _state.update { it.copy(createName = name) }

    fun setCreatePhoto(path: String?) = _state.update { it.copy(createPhotoPath = path) }

    fun submitCreate() {
        val s = _state.value
        if (s.createName.isBlank() || s.createPhotoPath == null) return
        _state.update { it.copy(creating = true) }
        viewModelScope.launch {
            try {
                repository.createFace(s.createName.trim(), File(s.createPhotoPath))
                _state.update { it.copy(
                    showCreateDialog = false,
                    creating = false,
                    createName = "",
                    createPhotoPath = null,
                    message = "Face identity created",
                ) }
                loadIdentities()
            } catch (e: Exception) {
                Log.e(TAG, "Create failed", e)
                _state.update { it.copy(
                    creating = false,
                    message = "Create failed: ${e.message}",
                ) }
            }
        }
    }

    fun openDetail(id: Int) {
        _state.update { it.copy(loadingDetail = true) }
        viewModelScope.launch {
            try {
                val detail = repository.getFace(id)
                _state.update { it.copy(detail = detail, loadingDetail = false) }
            } catch (e: Exception) {
                Log.e(TAG, "Detail fetch failed", e)
                _state.update { it.copy(
                    loadingDetail = false,
                    message = "Failed to load identity",
                ) }
            }
        }
    }

    fun dismissDetail() = _state.update { it.copy(detail = null) }

    fun addPhotoToCurrent(path: String) {
        val id = _state.value.detail?.id ?: return
        viewModelScope.launch {
            try {
                repository.addFacePhoto(id, File(path))
                val refreshed = repository.getFace(id)
                _state.update { it.copy(detail = refreshed, message = "Photo added") }
            } catch (e: Exception) {
                Log.e(TAG, "Add photo failed", e)
                _state.update { it.copy(message = "Failed to add photo") }
            }
        }
    }

    fun deletePhoto(photoId: Int) {
        val id = _state.value.detail?.id ?: return
        viewModelScope.launch {
            try {
                repository.deleteFacePhoto(id, photoId)
                val refreshed = repository.getFace(id)
                _state.update { it.copy(detail = refreshed, message = "Photo removed") }
            } catch (e: Exception) {
                Log.e(TAG, "Delete photo failed", e)
                _state.update { it.copy(message = "Failed to delete photo") }
            }
        }
    }

    fun confirmDeleteIdentity(id: Int) = _state.update { it.copy(pendingDeleteIdentityId = id) }
    fun cancelDeleteIdentity() = _state.update { it.copy(pendingDeleteIdentityId = null) }

    fun deleteIdentity() {
        val id = _state.value.pendingDeleteIdentityId ?: return
        _state.update { it.copy(pendingDeleteIdentityId = null) }
        viewModelScope.launch {
            try {
                repository.deleteFace(id)
                _state.update { it.copy(
                    identities = it.identities.filterNot { i -> i.id == id },
                    detail = if (it.detail?.id == id) null else it.detail,
                    message = "Identity deleted",
                ) }
            } catch (e: Exception) {
                Log.e(TAG, "Delete identity failed", e)
                _state.update { it.copy(message = "Failed to delete") }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }
}
