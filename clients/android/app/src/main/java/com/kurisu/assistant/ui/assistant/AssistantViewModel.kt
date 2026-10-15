package com.kurisu.assistant.ui.assistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.repository.AssistantRepository
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
 * Everything here is one row — `PATCH /assistant`. The screen deliberately holds
 * no per-persona copy of a model, a tool list or a memory document: under wire
 * protocol 4 those are the assistant's, and a persona that carried its own would
 * be the old "main agent" coming back. There are no sub-agents to set up either
 * (#354): the assistant spawns one itself when it needs help.
 *
 * The assistant's model is not set from here. It is picked from the chat header
 * (`ChatViewModel.pickModel`), and the persona in use from the Personas screen
 * (#197).
 */
data class AssistantUiState(
    val isLoading: Boolean = true,
    /** Fatal: the assistant itself could not be read, so the screen has nothing to show. */
    val loadError: String? = null,
    /** Transient feedback for the snackbar. */
    val message: String? = null,

    val assistant: Assistant? = null,

    /** Every tool the backend offers, built-in and MCP, by name. */
    val allToolNames: List<String> = emptyList(),

    val isSaving: Boolean = false,

    // ── Trigger-word editor ──
    val triggerEditorOpen: Boolean = false,
    val triggerDraft: String = "",

    // ── Tool picker ──
    val toolPickerOpen: Boolean = false,
    val toolDraft: Set<String> = emptySet(),
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
    private val toolsRepository: ToolsRepository,
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
                val assistant = assistantRepository.getAssistant()
                _state.update { it.copy(assistant = assistant) }
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

            // The tool picker's input. A failure here costs a list, not the screen.
            runCatching {
                val tools = toolsRepository.listTools()
                (tools.builtinTools + tools.mcpTools).map { it.function.name }.distinct().sorted()
            }.onSuccess { names -> _state.update { it.copy(allToolNames = names) } }
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
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not save")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
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
}
