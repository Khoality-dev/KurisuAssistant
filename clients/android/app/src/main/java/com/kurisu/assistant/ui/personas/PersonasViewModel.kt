package com.kurisu.assistant.ui.personas

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.model.PersonaUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PersonasUiState(
    val personas: List<Persona> = emptyList(),
    val isLoading: Boolean = false,
    val baseUrl: String = "",
    val message: String? = null,
    // Editor dialog
    val showEditor: Boolean = false,
    val editingPersona: Persona? = null,
    val editorName: String = "",
    val editorSystemPrompt: String = "",
    val editorPreferredName: String = "",
    val editorTriggerWord: String = "",
    val isSaving: Boolean = false,
    // Delete confirmation
    val deletingPersona: Persona? = null,
)

@HiltViewModel
class PersonasViewModel @Inject constructor(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(PersonasUiState())
    val state: StateFlow<PersonasUiState> = _state

    init {
        loadAll()
    }

    fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val personas = api.listPersonas()
                _state.update { it.copy(personas = personas, baseUrl = baseUrl) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed to load: ${e.message}") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun openNewEditor() = _state.update { it.copy(
        showEditor = true,
        editingPersona = null,
        editorName = "",
        editorSystemPrompt = "",
        editorPreferredName = "",
        editorTriggerWord = "",
    ) }

    fun openEditEditor(persona: Persona) = _state.update { it.copy(
        showEditor = true,
        editingPersona = persona,
        editorName = persona.name,
        editorSystemPrompt = persona.systemPrompt,
        editorPreferredName = persona.preferredName ?: "",
        editorTriggerWord = persona.triggerWord ?: "",
    ) }

    fun dismissEditor() = _state.update { it.copy(showEditor = false, editingPersona = null) }

    fun setEditorName(v: String) = _state.update { it.copy(editorName = v) }
    fun setEditorSystemPrompt(v: String) = _state.update { it.copy(editorSystemPrompt = v) }
    fun setEditorPreferredName(v: String) = _state.update { it.copy(editorPreferredName = v) }
    fun setEditorTriggerWord(v: String) = _state.update { it.copy(editorTriggerWord = v) }

    fun savePersona() {
        val s = _state.value
        if (s.editorName.isBlank()) {
            _state.update { it.copy(message = "Name is required") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                if (s.editingPersona != null) {
                    api.updatePersona(s.editingPersona.id, PersonaUpdate(
                        name = s.editorName.trim(),
                        systemPrompt = s.editorSystemPrompt.ifBlank { null },
                        preferredName = s.editorPreferredName.trim().ifBlank { null },
                        triggerWord = s.editorTriggerWord.trim().ifBlank { null },
                    ))
                    _state.update { it.copy(message = "Persona updated") }
                } else {
                    api.createPersona(PersonaCreate(
                        name = s.editorName.trim(),
                        systemPrompt = s.editorSystemPrompt.ifBlank { null },
                        preferredName = s.editorPreferredName.trim().ifBlank { null },
                        triggerWord = s.editorTriggerWord.trim().ifBlank { null },
                    ))
                    _state.update { it.copy(message = "Persona created") }
                }
                _state.update { it.copy(showEditor = false, editingPersona = null) }
                reloadPersonas()
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun confirmDelete(persona: Persona) = _state.update { it.copy(deletingPersona = persona) }
    fun dismissDelete() = _state.update { it.copy(deletingPersona = null) }

    fun deletePersona() {
        val persona = _state.value.deletingPersona ?: return
        viewModelScope.launch {
            try {
                api.deletePersona(persona.id)
                _state.update { it.copy(deletingPersona = null, message = "Persona deleted") }
                reloadPersonas()
            } catch (e: Exception) {
                _state.update { it.copy(deletingPersona = null, message = "Failed: ${e.message}") }
            }
        }
    }

    private fun reloadPersonas() {
        viewModelScope.launch {
            try {
                val personas = api.listPersonas()
                _state.update { it.copy(personas = personas) }
            } catch (_: Exception) {}
        }
    }
}
