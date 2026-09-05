package com.kurisu.assistant.ui.personas

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
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
import com.kurisu.assistant.ui.common.personaInitials
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * Personas are presentation, and the rules that protect the chat from an empty
 * cast live on the server. This pins both halves: the editor never writes a
 * capability field, and the server's two refusals — the last persona cannot be
 * deleted, the default cannot be disabled — reach the user as sentences rather
 * than as a control that quietly does nothing.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PersonasViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var personaRepo: PersonaRepository
    private lateinit var assistantRepo: AssistantRepository
    private lateinit var ttsRepo: TtsRepository
    private lateinit var ttsQueue: TtsQueueManager
    private lateinit var api: KurisuApiService
    private lateinit var prefs: PreferencesDataStore
    private lateinit var coreState: CoreState

    private val kurisu = Persona(
        id = 1,
        name = "Kurisu",
        description = "The default",
        systemPrompt = "You are Kurisu. Dry, precise, allergic to filler.",
        preferredName = "Kho",
        voiceReference = "kurisu_neutral.wav",
    )
    private val coach = Persona(id = 3, name = "Coach", systemPrompt = "Encouraging in tone.")

    private val assistant = Assistant(id = 1, defaultPersonaId = 1)

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private fun keysOf(update: PersonaUpdate): Set<String> =
        (json.parseToJsonElement(json.encodeToString(PersonaUpdate.serializer(), update))
            as JsonObject).keys

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        personaRepo = mockk(relaxed = true)
        assistantRepo = mockk(relaxed = true)
        ttsRepo = mockk(relaxed = true)
        ttsQueue = mockk(relaxed = true)
        api = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        coreState = CoreState()

        coEvery { prefs.getBackendUrl() } returns "https://example.test"
        coEvery { personaRepo.listPersonas() } returns listOf(kurisu, coach)
        coEvery { assistantRepo.getAssistant() } returns assistant
        coEvery { ttsRepo.listVoices(any()) } returns listOf("kurisu_neutral.wav", "coach_warm.wav")
        coEvery { personaRepo.getImageUrl(any(), any()) } answers {
            "${firstArg<String>()}/images/${secondArg<String>()}"
        }
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun httpError(code: Int, detail: String) = HttpException(
        Response.error<Any>(
            code,
            """{"detail":"$detail"}""".toResponseBody("application/json".toMediaType()),
        )
    )

    private fun viewModel() = PersonasViewModel(
        personaRepository = personaRepo,
        assistantRepository = assistantRepo,
        ttsRepository = ttsRepo,
        ttsQueue = ttsQueue,
        api = api,
        prefs = prefs,
        coreState = coreState,
    )

    @Test
    fun `loads the personas, the default and the voice list`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        val s = vm.state.value
        assertThat(s.isLoading).isFalse()
        assertThat(s.personas.map { it.name }).containsExactly("Kurisu", "Coach").inOrder()
        assertThat(s.defaultPersonaId).isEqualTo(1)
        assertThat(s.availableVoices).hasSize(2)
    }

    @Test
    fun `a failed load leaves an error rather than an empty list`() = runTest {
        coEvery { personaRepo.listPersonas() } throws httpError(503, "Service unavailable")
        val vm = viewModel()
        advanceUntilIdle()

        assertThat(vm.state.value.loadError).isEqualTo("Service unavailable")
        assertThat(vm.state.value.personas).isEmpty()
    }

    @Test
    fun `the row bound to the open conversation is tracked from the core state`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        coreState.setCurrentPersonaId(3)
        advanceUntilIdle()

        assertThat(vm.state.value.openChatPersonaId).isEqualTo(3)
    }

    // ─── The default for new chats ────────────────────────────────────

    @Test
    fun `tapping a row moves the assistant's default, and nothing else`() = runTest {
        coEvery { assistantRepo.updateAssistant(any()) } returns assistant.copy(defaultPersonaId = 3)
        val vm = viewModel()
        advanceUntilIdle()

        vm.makeDefault(coach)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            assistantRepo.updateAssistant(AssistantUpdate(defaultPersonaId = 3))
        }
        assertThat(vm.state.value.defaultPersonaId).isEqualTo(3)
        // The default is a server-side pointer, not a local preference: two
        // devices must not be able to disagree about who answers.
        coVerify(exactly = 0) { personaRepo.updatePersona(any(), any()) }
    }

    @Test
    fun `tapping the row that is already the default does nothing`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.makeDefault(kurisu)
        advanceUntilIdle()

        coVerify(exactly = 0) { assistantRepo.updateAssistant(any()) }
    }

    @Test
    fun `a disabled persona cannot become the default, and says why`() = runTest {
        coEvery { assistantRepo.updateAssistant(any()) } throws
            httpError(400, "A disabled persona cannot be the default. Enable it first.")
        val vm = viewModel()
        advanceUntilIdle()

        vm.makeDefault(coach)
        advanceUntilIdle()

        assertThat(vm.state.value.message)
            .isEqualTo("A disabled persona cannot be the default. Enable it first.")
        assertThat(vm.state.value.defaultPersonaId).isEqualTo(1)
    }

    // ─── Editor ───────────────────────────────────────────────────────

    @Test
    fun `the editor opens on the persona's own fields and nothing capability-shaped`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openPersona(kurisu)

        val draft = vm.state.value.draft!!
        assertThat(draft.id).isEqualTo(1)
        assertThat(draft.name).isEqualTo("Kurisu")
        assertThat(draft.preferredName).isEqualTo("Kho")
        assertThat(draft.voiceReference).isEqualTo("kurisu_neutral.wav")
        assertThat(draft.isNew).isFalse()
    }

    @Test
    fun `a persona needs a name`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewPersona()
        vm.setDraftName("   ")
        vm.savePersona()
        advanceUntilIdle()

        assertThat(vm.state.value.message).isEqualTo("Name is required")
        // The editor stays open on the invalid draft rather than discarding it.
        assertThat(vm.state.value.draft).isNotNull()
        coVerify(exactly = 0) { personaRepo.createPersona(any()) }
    }

    @Test
    fun `creating a persona sends only presentation fields`() = runTest {
        coEvery { personaRepo.createPersona(any()) } returns coach
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewPersona()
        vm.setDraftName("  Coach  ")
        vm.setDraftSystemPrompt("Encouraging in tone.")
        vm.setDraftPreferredName("Kho")
        vm.savePersona()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            personaRepo.createPersona(
                PersonaCreate(
                    name = "Coach",
                    systemPrompt = "Encouraging in tone.",
                    preferredName = "Kho",
                )
            )
        }
        assertThat(vm.state.value.draft).isNull()
    }

    @Test
    fun `saving an existing persona never sends enabled, which has its own guarded route`() =
        runTest {
            coEvery { personaRepo.updatePersona(any(), any()) } returns kurisu
            val vm = viewModel()
            advanceUntilIdle()

            vm.openPersona(kurisu)
            vm.setDraftName("Kurisu II")
            vm.savePersona()
            advanceUntilIdle()

            val captured = mutableListOf<PersonaUpdate>()
            coVerify { personaRepo.updatePersona(1, capture(captured)) }
            val body = captured.last()
            // PATCH /personas/{id} accepts `enabled` but does NOT refuse to
            // disable the default; only PATCH /personas/{id}/enabled does. So
            // this body must never carry it.
            assertThat(keysOf(body)).doesNotContain("enabled")
            assertThat(body.name).isEqualTo("Kurisu II")
        }

    @Test
    fun `enabling and disabling goes through the guarded route and surfaces its refusal`() =
        runTest {
            coEvery { personaRepo.setPersonaEnabled(1, false) } throws
                httpError(400, "This is your default persona. Make another one the default first.")
            val vm = viewModel()
            advanceUntilIdle()

            vm.openPersona(kurisu)
            vm.setDraftEnabled(false)
            advanceUntilIdle()

            coVerify(exactly = 1) { personaRepo.setPersonaEnabled(1, false) }
            assertThat(vm.state.value.message)
                .isEqualTo("This is your default persona. Make another one the default first.")
            // The switch must snap back: the server said no.
            assertThat(vm.state.value.draft?.enabled).isTrue()
        }

    @Test
    fun `a persona that does not exist yet toggles enabled locally`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewPersona()
        vm.setDraftEnabled(false)
        advanceUntilIdle()

        assertThat(vm.state.value.draft?.enabled).isFalse()
        coVerify(exactly = 0) { personaRepo.setPersonaEnabled(any(), any()) }
    }

    @Test
    fun `a picked image becomes the draft's avatar before the persona is saved`() = runTest {
        coEvery { api.uploadImage(any()) } returns
            com.kurisu.assistant.data.model.ImageUploadResponse(
                imageUuid = "abc-123",
                url = "/images/abc-123",
            )
        val file = java.io.File.createTempFile("avatar", ".png").apply { writeBytes(byteArrayOf(1)) }
        val vm = viewModel()
        advanceUntilIdle()

        vm.openNewPersona()
        vm.uploadAvatar(file)
        advanceUntilIdle()

        assertThat(vm.state.value.draft?.avatarUuid).isEqualTo("abc-123")
        assertThat(vm.state.value.isUploadingAvatar).isFalse()
        file.delete()
    }

    @Test
    fun `the voice preview speaks through the app's one output path`() = runTest {
        val vm = viewModel()
        advanceUntilIdle()

        vm.openPersona(kurisu)
        vm.previewVoice()

        verify(exactly = 1) { ttsQueue.queueText(any(), "kurisu_neutral.wav") }
    }

    // ─── Delete ───────────────────────────────────────────────────────

    @Test
    fun `deleting the last persona is refused, and the refusal is the message`() = runTest {
        coEvery { personaRepo.deletePersona(1) } throws
            httpError(400, "This is your only persona. Create another one before deleting it.")
        val vm = viewModel()
        advanceUntilIdle()

        vm.confirmDelete(kurisu)
        vm.deletePersona()
        advanceUntilIdle()

        assertThat(vm.state.value.message)
            .isEqualTo("This is your only persona. Create another one before deleting it.")
        assertThat(vm.state.value.deleting).isNull()
    }

    @Test
    fun `deleting closes the editor that was open on it`() = runTest {
        coEvery { personaRepo.listPersonas() } returnsMany listOf(
            listOf(kurisu, coach),
            listOf(kurisu),
        )
        val vm = viewModel()
        advanceUntilIdle()

        vm.openPersona(coach)
        vm.confirmDelete(coach)
        vm.deletePersona()
        advanceUntilIdle()

        coVerify(exactly = 1) { personaRepo.deletePersona(3) }
        assertThat(vm.state.value.draft).isNull()
        assertThat(vm.state.value.personas.map { it.name }).containsExactly("Kurisu")
    }
}

/** The initials rule, which the design's hand-drawn ones do not follow. */
class PersonaInitialsTest {

    @Test
    fun `two tokens give one letter each`() {
        assertThat(personaInitials("code reader")).isEqualTo("CR")
        assertThat(personaInitials("web-digger")).isEqualTo("WD")
        assertThat(personaInitials("home_assistant")).isEqualTo("HA")
    }

    @Test
    fun `a single token gives its first two letters`() {
        assertThat(personaInitials("Kurisu")).isEqualTo("KU")
        // The design draws this as CH by hand; that is not derivable from the name.
        assertThat(personaInitials("Coach")).isEqualTo("CO")
    }

    @Test
    fun `more than two tokens still stops at two`() {
        assertThat(personaInitials("the very patient one")).isEqualTo("TV")
    }

    @Test
    fun `whitespace and empty names do not crash`() {
        assertThat(personaInitials("   ")).isEqualTo("?")
        assertThat(personaInitials("")).isEqualTo("?")
        assertThat(personaInitials("x")).isEqualTo("X")
    }

    @Test
    fun `the meta line names the voice, the rig and a disabled persona`() {
        assertThat(personaMeta("kurisu_neutral.wav", hasCharacterConfig = true))
            .isEqualTo("kurisu_neutral.wav · character")
        assertThat(personaMeta(null, hasCharacterConfig = false)).isEqualTo("no voice")
        assertThat(personaMeta("", hasCharacterConfig = false, enabled = false))
            .isEqualTo("no voice · disabled")
    }
}
