package com.kurisu.assistant.ui.tools

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.Skill
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.repository.ToolsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ToolsUiState(
    val selectedTab: Int = 0,
    val mcpServers: List<MCPServer> = emptyList(),
    val mcpTools: List<Tool> = emptyList(),
    val builtinTools: List<Tool> = emptyList(),
    val skills: List<Skill> = emptyList(),
    val isLoading: Boolean = false,
    val message: String? = null,
    // Tool detail dialog
    val detailTool: Tool? = null,
    // Skill editor dialog
    val editingSkill: Skill? = null,
    val showSkillEditor: Boolean = false,
    val skillEditorName: String = "",
    val skillEditorInstructions: String = "",
    val isSavingSkill: Boolean = false,
    // Delete confirmation
    val deletingSkill: Skill? = null,
)

@HiltViewModel
class ToolsViewModel @Inject constructor(
    private val repository: ToolsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ToolsUiState())
    val state: StateFlow<ToolsUiState> = _state

    init {
        loadAll()
    }

    fun setSelectedTab(index: Int) = _state.update { it.copy(selectedTab = index) }
    fun clearMessage() = _state.update { it.copy(message = null) }

    fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val tools = repository.listTools()
                val servers = repository.listMCPServers()
                val skills = repository.listSkills()
                _state.update { it.copy(
                    mcpTools = tools.mcpTools,
                    builtinTools = tools.builtinTools,
                    mcpServers = servers,
                    skills = skills,
                ) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed to load: ${e.message}") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    // Tool detail dialog
    fun showToolDetail(tool: Tool) = _state.update { it.copy(detailTool = tool) }
    fun dismissToolDetail() = _state.update { it.copy(detailTool = null) }

    // Skill editor
    fun openNewSkillEditor() = _state.update { it.copy(
        showSkillEditor = true,
        editingSkill = null,
        skillEditorName = "",
        skillEditorInstructions = "",
    ) }

    fun openEditSkillEditor(skill: Skill) = _state.update { it.copy(
        showSkillEditor = true,
        editingSkill = skill,
        skillEditorName = skill.name,
        skillEditorInstructions = skill.instructions,
    ) }

    fun dismissSkillEditor() = _state.update { it.copy(
        showSkillEditor = false,
        editingSkill = null,
    ) }

    fun setSkillEditorName(v: String) = _state.update { it.copy(skillEditorName = v) }
    fun setSkillEditorInstructions(v: String) = _state.update { it.copy(skillEditorInstructions = v) }

    fun saveSkill() {
        val s = _state.value
        if (s.skillEditorName.isBlank()) {
            _state.update { it.copy(message = "Skill name is required") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSavingSkill = true) }
            try {
                if (s.editingSkill != null) {
                    repository.updateSkill(
                        id = s.editingSkill.id,
                        name = s.skillEditorName.trim(),
                        instructions = s.skillEditorInstructions,
                    )
                } else {
                    repository.createSkill(
                        name = s.skillEditorName.trim(),
                        instructions = s.skillEditorInstructions,
                    )
                }
                _state.update { it.copy(
                    showSkillEditor = false,
                    editingSkill = null,
                    message = if (s.editingSkill != null) "Skill updated" else "Skill created",
                ) }
                loadSkills()
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSavingSkill = false) }
            }
        }
    }

    // Delete
    fun confirmDeleteSkill(skill: Skill) = _state.update { it.copy(deletingSkill = skill) }
    fun dismissDeleteSkill() = _state.update { it.copy(deletingSkill = null) }

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

    private fun loadSkills() {
        viewModelScope.launch {
            try {
                val skills = repository.listSkills()
                _state.update { it.copy(skills = skills) }
            } catch (_: Exception) {}
        }
    }
}
