package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.Skill
import com.kurisu.assistant.data.repository.ToolsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SkillsUiState(
    val skills: List<Skill> = emptyList(),
    val isLoading: Boolean = false,
    val message: String? = null,
    val showEditor: Boolean = false,
    val editingSkill: Skill? = null,
    val editorName: String = "",
    val editorInstructions: String = "",
    val isSaving: Boolean = false,
    val deletingSkill: Skill? = null,
)

@HiltViewModel
class SkillsViewModel @Inject constructor(
    private val repository: ToolsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SkillsUiState())
    val state: StateFlow<SkillsUiState> = _state

    init { loadSkills() }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun loadSkills() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val skills = repository.listSkills()
                _state.update { it.copy(skills = skills) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun openNewEditor() = _state.update { it.copy(showEditor = true, editingSkill = null, editorName = "", editorInstructions = "") }

    fun openEditEditor(skill: Skill) = _state.update { it.copy(
        showEditor = true, editingSkill = skill, editorName = skill.name, editorInstructions = skill.instructions,
    ) }

    fun dismissEditor() = _state.update { it.copy(showEditor = false, editingSkill = null) }

    fun setEditorName(v: String) = _state.update { it.copy(editorName = v) }
    fun setEditorInstructions(v: String) = _state.update { it.copy(editorInstructions = v) }

    fun saveSkill() {
        val s = _state.value
        if (s.editorName.isBlank()) { _state.update { it.copy(message = "Name is required") }; return }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                if (s.editingSkill != null) {
                    repository.updateSkill(s.editingSkill.id, s.editorName.trim(), s.editorInstructions)
                    _state.update { it.copy(message = "Skill updated") }
                } else {
                    repository.createSkill(s.editorName.trim(), s.editorInstructions)
                    _state.update { it.copy(message = "Skill created") }
                }
                _state.update { it.copy(showEditor = false, editingSkill = null) }
                loadSkills()
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun confirmDelete(skill: Skill) = _state.update { it.copy(deletingSkill = skill) }
    fun dismissDelete() = _state.update { it.copy(deletingSkill = null) }

    fun deleteSkill() {
        val skill = _state.value.deletingSkill ?: return
        viewModelScope.launch {
            try {
                repository.deleteSkill(skill.id)
                _state.update { it.copy(deletingSkill = null, message = "Skill deleted") }
                loadSkills()
            } catch (e: Exception) {
                _state.update { it.copy(deletingSkill = null, message = "Failed: ${e.message}") }
            }
        }
    }
}
