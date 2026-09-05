package com.kurisu.assistant.ui.assistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.SubAgent
import com.kurisu.assistant.data.model.SubAgentCreate
import com.kurisu.assistant.data.model.SubAgentUpdate
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.SubAgentRepository
import com.kurisu.assistant.data.repository.ToolsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The Assistant screen's state.
 *
 * Everything here except [defaultPersona] and [subAgents] is one row —
 * `PATCH /assistant`. The screen deliberately holds no per-persona copy of a
 * model, a tool list or a memory document: under wire protocol 4 those are the
 * assistant's, and a persona that carried its own would be the old "main agent"
 * coming back.
 */
data class AssistantUiState(
    val isLoading: Boolean = true,
    /** Fatal: the assistant itself could not be read, so the screen has nothing to show. */
    val loadError: String? = null,
    /** Transient feedback for the snackbar. */
    val message: String? = null,
    val baseUrl: String = "",

    val assistant: Assistant? = null,
    val defaultPersona: Persona? = null,
    val subAgents: List<SubAgent> = emptyList(),

    val availableModels: List<ModelInfo> = emptyList(),
    val isRefreshingModels: Boolean = false,
    /** Every tool the backend offers, built-in and MCP, by name. */
    val allToolNames: List<String> = emptyList(),

    val isSaving: Boolean = false,

    // ── Trigger-word editor ──
    val triggerEditorOpen: Boolean = false,
    val triggerDraft: String = "",

    // ── Tool picker ──
    val toolPickerOpen: Boolean = false,
    val toolDraft: Set<String> = emptySet(),

    // ── Sub-agent editor ──
    val subEditorOpen: Boolean = false,
    val editingSubAgent: SubAgent? = null,
    val subDraftName: String = "",
    val subDraftDescription: String = "",
    val subDraftModelName: String = "",
    val subDraftSystemPrompt: String = "",
    val subDraftThink: Boolean = false,
    val subDraftTools: Set<String> = emptySet(),

    val deletingSubAgent: SubAgent? = null,
) {
    /** null `available_tools` means "every tool"; an empty list means none. */
    val usesEveryTool: Boolean get() = assistant?.availableTools == null

    val toolsSummary: String
        get() {
            val enabled = assistant?.availableTools ?: return "Every tool"
            return if (allToolNames.isEmpty()) "${enabled.size} enabled"
            else "${enabled.size} of ${allToolNames.size} enabled"
        }

    /** Blank is stored rather than null, so treat both as "no wake word". */
    val triggerWord: String? get() = assistant?.triggerWord?.takeIf { it.isNotBlank() }
}

@HiltViewModel
class AssistantViewModel @Inject constructor(
    private val assistantRepository: AssistantRepository,
    private val personaRepository: PersonaRepository,
    private val subAgentRepository: SubAgentRepository,
    private val toolsRepository: ToolsRepository,
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(AssistantUiState())
    val state: StateFlow<AssistantUiState> = _state

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, loadError = null) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val assistant = assistantRepository.getAssistant()
                val subAgents = subAgentRepository.listSubAgents()
                _state.update {
                    it.copy(assistant = assistant, subAgents = subAgents, baseUrl = baseUrl)
                }
                loadDefaultPersona(assistant)
            } catch (e: Exception) {
                // A first load that fails leaves the screen with nothing to draw,
                // so it becomes a retryable screen state. A REFRESH that fails
                // still has the old data on screen, so it is a snackbar — routing
                // it to `loadError` would hide it behind a branch that never runs.
                val reason = apiErrorMessage(e, "Could not load the assistant")
                _state.update {
                    if (it.assistant == null) it.copy(loadError = reason)
                    else it.copy(message = reason)
                }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }

            // Editor inputs. A failure here costs a dropdown, not the screen.
            refreshModels()
            runCatching {
                val tools = toolsRepository.listTools()
                (tools.builtinTools + tools.mcpTools).map { it.function.name }.distinct().sorted()
            }.onSuccess { names -> _state.update { it.copy(allToolNames = names) } }
        }
    }

    private suspend fun loadDefaultPersona(assistant: Assistant) {
        val id = assistant.defaultPersonaId
        if (id == null) {
            _state.update { it.copy(defaultPersona = null) }
            return
        }
        // A 404 here means the pointer is stale, not that the screen is broken.
        val persona = runCatching { personaRepository.getPersona(id) }.getOrNull()
        _state.update { it.copy(defaultPersona = persona) }
    }

    fun refreshModels() {
        viewModelScope.launch {
            _state.update { it.copy(isRefreshingModels = true) }
            try {
                val models = assistantRepository.listModels()
                _state.update { it.copy(availableModels = models) }
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not load models")) }
            } finally {
                _state.update { it.copy(isRefreshingModels = false) }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    // ─── The one patch ────────────────────────────────────────────────
    //
    // Every capability control on this screen funnels through here, so the whole
    // screen is a single `PATCH /assistant` carrying only the field the user
    // touched. Nothing is applied optimistically: the switches read out of
    // `state.assistant`, which only moves once the server has agreed, so a
    // rejected change visibly snaps back instead of lying.

    private fun patchAssistant(update: AssistantUpdate, feedback: String? = null) {
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                val updated = assistantRepository.updateAssistant(update)
                _state.update { it.copy(assistant = updated, message = feedback) }
                if (update.defaultPersonaId != null) loadDefaultPersona(updated)
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not save")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    /**
     * The provider travels with the model: they are two columns describing one
     * choice, and sending the name alone would point the assistant at a model
     * the old provider cannot serve.
     */
    fun setModel(model: ModelInfo) {
        if (model.name == _state.value.assistant?.modelName &&
            model.provider == _state.value.assistant?.providerType
        ) return
        patchAssistant(AssistantUpdate(modelName = model.name, providerType = model.provider))
    }

    fun setThink(enabled: Boolean) {
        if (enabled == _state.value.assistant?.think) return
        patchAssistant(AssistantUpdate(think = enabled))
    }

    fun setMemoryEnabled(enabled: Boolean) {
        if (enabled == _state.value.assistant?.memoryEnabled) return
        patchAssistant(AssistantUpdate(memoryEnabled = enabled))
    }

    // ─── Trigger word ─────────────────────────────────────────────────

    fun openTriggerEditor() = _state.update {
        it.copy(triggerEditorOpen = true, triggerDraft = it.triggerWord.orEmpty())
    }

    fun setTriggerDraft(value: String) = _state.update { it.copy(triggerDraft = value) }

    fun dismissTriggerEditor() = _state.update { it.copy(triggerEditorOpen = false) }

    /**
     * A cleared wake word is stored as "" rather than null.
     *
     * `AssistantUpdate` is `@EncodeDefault(NEVER)` on every field, so a null is
     * omitted from the body rather than sent — which is exactly what keeps a
     * one-field patch partial, and also means this client cannot express
     * "set trigger_word to NULL". Blank round-trips and reads as "no wake word"
     * everywhere on this screen, so it is the honest way to clear it.
     */
    fun saveTriggerWord() {
        val draft = _state.value.triggerDraft.trim()
        _state.update { it.copy(triggerEditorOpen = false) }
        if (draft == _state.value.triggerWord.orEmpty()) return
        patchAssistant(
            AssistantUpdate(triggerWord = draft),
            feedback = if (draft.isEmpty()) "Wake word cleared" else "Wake word → $draft",
        )
    }

    // ─── Tools ────────────────────────────────────────────────────────

    fun openToolPicker() = _state.update {
        // "Every tool" is shown as every chip selected: that is what it means,
        // and it makes turning one off a single tap.
        val selected = it.assistant?.availableTools?.toSet() ?: it.allToolNames.toSet()
        it.copy(toolPickerOpen = true, toolDraft = selected)
    }

    fun dismissToolPicker() = _state.update { it.copy(toolPickerOpen = false) }

    fun toggleToolDraft(name: String) = _state.update {
        it.copy(toolDraft = if (name in it.toolDraft) it.toolDraft - name else it.toolDraft + name)
    }

    fun selectAllToolDrafts() = _state.update { it.copy(toolDraft = it.allToolNames.toSet()) }

    fun clearToolDrafts() = _state.update { it.copy(toolDraft = emptySet()) }

    fun saveTools() {
        val s = _state.value
        val chosen = s.allToolNames.filter { it in s.toolDraft }
        _state.update { it.copy(toolPickerOpen = false) }
        if (chosen.toSet() == s.assistant?.availableTools?.toSet()) return
        patchAssistant(AssistantUpdate(availableTools = chosen))
    }

    // ─── Sub-agents ───────────────────────────────────────────────────

    fun openNewSubAgent() = _state.update {
        it.copy(
            subEditorOpen = true,
            editingSubAgent = null,
            subDraftName = "",
            subDraftDescription = "",
            subDraftModelName = it.assistant?.modelName
                ?: it.availableModels.firstOrNull()?.name.orEmpty(),
            subDraftSystemPrompt = "",
            subDraftThink = false,
            subDraftTools = emptySet(),
        )
    }

    fun openSubAgentEditor(subAgent: SubAgent) = _state.update {
        it.copy(
            subEditorOpen = true,
            editingSubAgent = subAgent,
            subDraftName = subAgent.name,
            subDraftDescription = subAgent.description,
            subDraftModelName = subAgent.modelName.orEmpty(),
            subDraftSystemPrompt = subAgent.systemPrompt,
            subDraftThink = subAgent.think,
            subDraftTools = subAgent.availableTools?.toSet() ?: emptySet(),
        )
    }

    fun dismissSubAgentEditor() =
        _state.update { it.copy(subEditorOpen = false, editingSubAgent = null) }

    fun setSubDraftName(v: String) = _state.update { it.copy(subDraftName = v) }
    fun setSubDraftDescription(v: String) = _state.update { it.copy(subDraftDescription = v) }
    fun setSubDraftModelName(v: String) = _state.update { it.copy(subDraftModelName = v) }
    fun setSubDraftSystemPrompt(v: String) = _state.update { it.copy(subDraftSystemPrompt = v) }
    fun setSubDraftThink(v: Boolean) = _state.update { it.copy(subDraftThink = v) }

    fun toggleSubDraftTool(name: String) = _state.update {
        it.copy(
            subDraftTools =
                if (name in it.subDraftTools) it.subDraftTools - name else it.subDraftTools + name
        )
    }

    fun saveSubAgent() {
        val s = _state.value
        val name = s.subDraftName.trim()
        if (name.isBlank()) {
            _state.update { it.copy(message = "Name is required") }
            return
        }
        val model = s.subDraftModelName.trim()
        if (model.isBlank()) {
            _state.update { it.copy(message = "Model is required") }
            return
        }
        // An empty tool set means "no tools" on update, but on create it is the
        // difference between an explicit empty list and "inherit every tool" —
        // send null there so a new worker is not born unable to do anything.
        val tools = s.allToolNames.filter { it in s.subDraftTools }
        val editing = s.editingSubAgent

        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                if (editing != null) {
                    subAgentRepository.updateSubAgent(
                        editing.id,
                        SubAgentUpdate(
                            name = name,
                            description = s.subDraftDescription.trim(),
                            systemPrompt = s.subDraftSystemPrompt,
                            modelName = model,
                            think = s.subDraftThink,
                            availableTools = tools,
                        ),
                    )
                    _state.update { it.copy(message = "Sub-agent updated") }
                } else {
                    subAgentRepository.createSubAgent(
                        SubAgentCreate(
                            name = name,
                            description = s.subDraftDescription.trim().ifBlank { null },
                            systemPrompt = s.subDraftSystemPrompt.ifBlank { null },
                            modelName = model,
                            think = s.subDraftThink,
                            availableTools = tools.ifEmpty { null },
                        ),
                    )
                    _state.update { it.copy(message = "Sub-agent created") }
                }
                _state.update { it.copy(subEditorOpen = false, editingSubAgent = null) }
                reloadSubAgents()
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not save the sub-agent")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun confirmDeleteSubAgent(subAgent: SubAgent) =
        _state.update { it.copy(deletingSubAgent = subAgent) }

    fun dismissDeleteSubAgent() = _state.update { it.copy(deletingSubAgent = null) }

    fun deleteSubAgent() {
        val subAgent = _state.value.deletingSubAgent ?: return
        viewModelScope.launch {
            try {
                subAgentRepository.deleteSubAgent(subAgent.id)
                _state.update { it.copy(deletingSubAgent = null, message = "${subAgent.name} deleted") }
                reloadSubAgents()
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        deletingSubAgent = null,
                        message = apiErrorMessage(e, "Could not delete the sub-agent"),
                    )
                }
            }
        }
    }

    private suspend fun reloadSubAgents() {
        runCatching { subAgentRepository.listSubAgents() }
            .onSuccess { list -> _state.update { it.copy(subAgents = list) } }
    }
}
