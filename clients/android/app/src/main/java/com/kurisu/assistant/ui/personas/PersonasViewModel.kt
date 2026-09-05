package com.kurisu.assistant.ui.personas

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.model.PersonaUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.ui.assistant.apiErrorMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import javax.inject.Inject

/**
 * The persona editor's draft.
 *
 * Presentation only — there is deliberately no model, no tool list, no memory
 * and no trigger word here. Those belong to the one assistant, and a persona
 * that carried a copy of them would be the old "main agent" all over again.
 */
data class PersonaDraft(
    /** null while creating. */
    val id: Int? = null,
    val name: String = "",
    val description: String = "",
    val preferredName: String = "",
    val voiceReference: String = "",
    val systemPrompt: String = "",
    val avatarUuid: String? = null,
    val enabled: Boolean = true,
    val hasCharacterConfig: Boolean = false,
) {
    val isNew: Boolean get() = id == null
}

data class PersonasUiState(
    val isLoading: Boolean = true,
    /** Fatal: the list could not be read at all. */
    val loadError: String? = null,
    val message: String? = null,
    val baseUrl: String = "",

    val personas: List<Persona> = emptyList(),
    val defaultPersonaId: Int? = null,
    /** Who is answering the conversation that is currently open, if any. */
    val openChatPersonaId: Int? = null,

    val availableVoices: List<String> = emptyList(),
    val isSaving: Boolean = false,
    val isUploadingAvatar: Boolean = false,

    /** Non-null while the full-screen editor is open. */
    val draft: PersonaDraft? = null,
    val deleting: Persona? = null,
)

@HiltViewModel
class PersonasViewModel @Inject constructor(
    private val personaRepository: PersonaRepository,
    private val assistantRepository: AssistantRepository,
    private val ttsRepository: TtsRepository,
    // The app's one speech output path, so a voice preview goes through the same
    // backend choice and speaker-device preference as everything else the
    // assistant says.
    private val ttsQueue: TtsQueueManager,
    // Called directly for `POST /images`: an avatar is an ordinary uploaded image
    // whose uuid is then patched onto the persona, and there is no persona-scoped
    // upload route to wrap.
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
    coreState: CoreState,
) : ViewModel() {

    private val _state = MutableStateFlow(PersonasUiState())
    val state: StateFlow<PersonasUiState> = _state

    init {
        load()
        viewModelScope.launch {
            coreState.state.collect { core ->
                _state.update { it.copy(openChatPersonaId = core.currentPersonaId) }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, loadError = null) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val personas = personaRepository.listPersonas()
                val assistant = assistantRepository.getAssistant()
                _state.update {
                    it.copy(
                        personas = personas,
                        defaultPersonaId = assistant.defaultPersonaId,
                        baseUrl = baseUrl,
                    )
                }
            } catch (e: Exception) {
                // Same split as the Assistant screen: a first load that fails is a
                // retryable screen state, a failed refresh is a snackbar over the
                // list that is still on screen.
                val reason = apiErrorMessage(e, "Could not load personas")
                _state.update {
                    if (it.personas.isEmpty()) it.copy(loadError = reason)
                    else it.copy(message = reason)
                }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }

            // A missing voice list costs the editor a dropdown, not the screen.
            runCatching { ttsRepository.listVoices(null) }
                .onSuccess { voices -> _state.update { it.copy(availableVoices = voices) } }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun avatarUrl(uuid: String?): String? =
        uuid?.let { personaRepository.getImageUrl(_state.value.baseUrl, it) }

    // ─── The default for new chats ────────────────────────────────────

    /**
     * Tapping a row makes it the default persona for new conversations.
     *
     * This is `assistants.default_persona_id`, not a local preference: a new chat
     * binds to it silently on the server, so a device-local copy would let two
     * phones disagree about who answers.
     */
    fun makeDefault(persona: Persona) {
        if (persona.id == _state.value.defaultPersonaId) return
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                val assistant = assistantRepository.updateAssistant(
                    AssistantUpdate(defaultPersonaId = persona.id)
                )
                _state.update {
                    it.copy(
                        defaultPersonaId = assistant.defaultPersonaId,
                        message = "New chats will use ${persona.name}",
                    )
                }
            } catch (e: Exception) {
                // A disabled persona is refused here by the backend; the reason is
                // the message, so show it rather than a silent no-op.
                _state.update { it.copy(message = apiErrorMessage(e, "Could not set the default")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    // ─── Editor ───────────────────────────────────────────────────────

    fun openNewPersona() = _state.update { it.copy(draft = PersonaDraft()) }

    fun openPersona(persona: Persona) = _state.update {
        it.copy(
            draft = PersonaDraft(
                id = persona.id,
                name = persona.name,
                description = persona.description,
                preferredName = persona.preferredName.orEmpty(),
                voiceReference = persona.voiceReference.orEmpty(),
                systemPrompt = persona.systemPrompt,
                avatarUuid = persona.avatarUuid,
                enabled = persona.enabled,
                hasCharacterConfig = persona.characterConfig != null,
            )
        )
    }

    fun dismissEditor() = _state.update { it.copy(draft = null) }

    private fun editDraft(block: (PersonaDraft) -> PersonaDraft) =
        _state.update { s -> s.draft?.let { s.copy(draft = block(it)) } ?: s }

    fun setDraftName(v: String) = editDraft { it.copy(name = v) }
    fun setDraftDescription(v: String) = editDraft { it.copy(description = v) }
    fun setDraftPreferredName(v: String) = editDraft { it.copy(preferredName = v) }
    fun setDraftVoiceReference(v: String) = editDraft { it.copy(voiceReference = v) }
    fun setDraftSystemPrompt(v: String) = editDraft { it.copy(systemPrompt = v) }

    /** Speak one line in the draft's voice so the name in the dropdown means something. */
    fun previewVoice() {
        val draft = _state.value.draft ?: return
        val voice = draft.voiceReference.trim().ifBlank { null }
        val name = draft.name.trim().ifBlank { "your assistant" }
        ttsQueue.queueText("Hello. This is $name.", voice)
    }

    /**
     * Upload an image and hang it on the draft.
     *
     * The uuid is only written to the persona when the draft is saved, so
     * cancelling the editor leaves the persona's face alone. A new persona can
     * pick an avatar before it exists because the image is uploaded on its own
     * and the uuid rides along in the create body.
     */
    fun uploadAvatar(file: File) {
        viewModelScope.launch {
            _state.update { it.copy(isUploadingAvatar = true) }
            try {
                val mime = when (file.extension.lowercase()) {
                    "png" -> "image/png"
                    "webp" -> "image/webp"
                    else -> "image/jpeg"
                }
                val part = MultipartBody.Part.createFormData(
                    "file", file.name, file.asRequestBody(mime.toMediaType())
                )
                val uploaded = api.uploadImage(part)
                editDraft { it.copy(avatarUuid = uploaded.imageUuid) }
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not upload the image")) }
            } finally {
                _state.update { it.copy(isUploadingAvatar = false) }
            }
        }
    }

    /**
     * Enable or disable an existing persona, applied straight away.
     *
     * It goes through `PATCH /personas/{id}/enabled` rather than riding along in
     * the save body because only that route refuses to disable the persona the
     * assistant defaults to — patching `enabled` on the plain route would slip
     * past the guard and leave new chats with nobody to answer them.
     */
    fun setDraftEnabled(enabled: Boolean) {
        val draft = _state.value.draft ?: return
        val id = draft.id
        if (id == null) {
            editDraft { it.copy(enabled = enabled) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                val updated = personaRepository.setPersonaEnabled(id, enabled)
                editDraft { it.copy(enabled = updated.enabled) }
                replaceInList(updated)
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not change that")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun savePersona() {
        val draft = _state.value.draft ?: return
        val name = draft.name.trim()
        if (name.isBlank()) {
            _state.update { it.copy(message = "Name is required") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                if (draft.id == null) {
                    personaRepository.createPersona(
                        PersonaCreate(
                            name = name,
                            description = draft.description.trim().ifBlank { null },
                            systemPrompt = draft.systemPrompt.ifBlank { null },
                            preferredName = draft.preferredName.trim().ifBlank { null },
                            voiceReference = draft.voiceReference.trim().ifBlank { null },
                            avatarUuid = draft.avatarUuid,
                        )
                    )
                    _state.update { it.copy(message = "$name created") }
                } else {
                    // `enabled` is absent on purpose — it is applied immediately
                    // through the guarded route, not saved with the rest.
                    personaRepository.updatePersona(
                        draft.id,
                        PersonaUpdate(
                            name = name,
                            description = draft.description.trim(),
                            systemPrompt = draft.systemPrompt,
                            preferredName = draft.preferredName.trim(),
                            voiceReference = draft.voiceReference.trim(),
                            avatarUuid = draft.avatarUuid,
                        )
                    )
                    _state.update { it.copy(message = "$name saved") }
                }
                _state.update { it.copy(draft = null) }
                reload()
            } catch (e: Exception) {
                _state.update { it.copy(message = apiErrorMessage(e, "Could not save the persona")) }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    // ─── Delete ───────────────────────────────────────────────────────

    fun confirmDelete(persona: Persona) = _state.update { it.copy(deleting = persona) }
    fun dismissDelete() = _state.update { it.copy(deleting = null) }

    /**
     * Delete a persona.
     *
     * The backend refuses to delete the last one — a user with none cannot start
     * a chat — and returns the reason as the error detail. Surfacing it is the
     * difference between an explained rule and a button that does nothing.
     */
    fun deletePersona() {
        val persona = _state.value.deleting ?: return
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                personaRepository.deletePersona(persona.id)
                _state.update {
                    it.copy(
                        deleting = null,
                        // Close the editor if it was open on the one just deleted.
                        draft = if (it.draft?.id == persona.id) null else it.draft,
                        message = "${persona.name} deleted",
                    )
                }
                reload()
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        deleting = null,
                        message = apiErrorMessage(e, "Could not delete the persona"),
                    )
                }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    private fun replaceInList(persona: Persona) = _state.update { s ->
        s.copy(personas = s.personas.map { if (it.id == persona.id) persona else it })
    }

    private suspend fun reload() {
        runCatching {
            val personas = personaRepository.listPersonas()
            val assistant = assistantRepository.getAssistant()
            personas to assistant.defaultPersonaId
        }.onSuccess { (personas, defaultId) ->
            _state.update { it.copy(personas = personas, defaultPersonaId = defaultId) }
        }
    }
}
