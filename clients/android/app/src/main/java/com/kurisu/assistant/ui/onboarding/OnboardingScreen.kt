package com.kurisu.assistant.ui.onboarding

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.ViewInAr
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.kurisu.assistant.domain.onboarding.FinishPart
import com.kurisu.assistant.domain.onboarding.ONBOARDING_PROVIDERS
import com.kurisu.assistant.domain.onboarding.OnboardingStep
import com.kurisu.assistant.ui.personas.copyToCache

/**
 * A new account's onboarding (#342), one step a screen: the model, an optional
 * persona with its voice and character, and the wake word. [onFinished] opens
 * the first conversation; [onSkipped] goes on to the app as it is.
 */
@Composable
fun OnboardingScreen(
    onFinished: () -> Unit,
    onSkipped: () -> Unit,
    viewModel: OnboardingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                OnboardingEvent.Finished -> onFinished()
                OnboardingEvent.Skipped -> onSkipped()
            }
        }
    }

    // Back walks the steps; from the first, it offers to skip rather than leaving silently.
    BackHandler(enabled = !state.finishing) {
        if (state.stepIndex > 0) viewModel.back() else viewModel.askSkip()
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (state.finishing) {
            Finishing(state, onTryAgain = viewModel::finish, onBack = viewModel::leaveFinishing)
        } else {
            Steps(state, viewModel)
        }
    }

    if (state.confirmSkip) {
        AlertDialog(
            onDismissRequest = viewModel::dismissSkip,
            title = { Text("Skip setup?") },
            text = {
                Text(
                    "You’ll chat with the assistant itself, with no wake word. What you picked here isn’t saved, " +
                        "and this won’t come up again on any device. Personas are in Settings whenever you want one.",
                )
            },
            confirmButton = { TextButton(onClick = viewModel::skip) { Text("Skip") } },
            dismissButton = { TextButton(onClick = viewModel::dismissSkip) { Text("Keep going") } },
        )
    }
}

@Composable
private fun Steps(state: OnboardingUiState, vm: OnboardingViewModel) {
    Column(modifier = Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.stepIndex > 0) {
                IconButton(onClick = vm::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            } else {
                Spacer(Modifier.width(12.dp))
            }
            Text(
                "Step ${state.stepIndex + 1} of ${state.steps.size}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = vm::askSkip) { Text("Skip") }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            state.steps.indices.forEach { i ->
                Box(
                    Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp)).background(
                        if (i <= state.stepIndex) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                )
            }
        }

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(state.step.title, style = MaterialTheme.typography.headlineMedium)
            when (state.step) {
                OnboardingStep.MODEL -> ModelStep(state, vm)
                OnboardingStep.PERSONA -> PersonaStep(state, vm)
                OnboardingStep.VOICE -> VoiceStep(state, vm)
                OnboardingStep.CHARACTER -> CharacterStep(state, vm)
                OnboardingStep.WAKE_WORD -> WakeWordStep(state, vm)
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        }

        Row(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.End) {
            if (state.isLast) {
                Button(onClick = vm::finish) { Text("Start chatting") }
            } else {
                Button(onClick = vm::next, enabled = state.canGoOn) { Text("Next") }
            }
        }
    }
}

@Composable
private fun Explanation(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ModelStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    Explanation("One model answers for the assistant and every persona. You can change it later from the chat header.")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ONBOARDING_PROVIDERS.forEach { p ->
            FilterChip(selected = state.providerId == p.id, onClick = { vm.setProvider(p.id) }, label = { Text(p.label) })
        }
    }
    val provider = ONBOARDING_PROVIDERS.first { it.id == state.providerId }
    val connected = state.providerModels.size
    OutlinedTextField(
        value = state.providerValue,
        onValueChange = vm::setProviderValue,
        label = { Text(provider.input) },
        placeholder = { if (provider.id == "ollama") Text("http://192.168.1.20:11434") },
        singleLine = true,
        isError = state.providerProblem != null,
        visualTransformation = if (provider.id == "ollama") VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = if (provider.id == "ollama") KeyboardType.Uri else KeyboardType.Password),
        supportingText = {
            when {
                state.providerProblem != null -> Text(state.providerProblem)
                connected > 0 -> Text("Connected · $connected model${if (connected == 1) "" else "s"}")
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedButton(onClick = vm::connect, enabled = !state.connecting) {
        Text(if (state.connecting) "Connecting…" else "Connect")
    }
    state.providerModels.forEach { m ->
        Choice(
            selected = state.model == m,
            title = m.name,
            subtitle = provider.label,
            onClick = { vm.pickModel(m) },
        )
    }
}

@Composable
private fun PersonaStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri?.let { copyToCache(context, it)?.let(vm::uploadAvatar) }
    }
    Explanation("Optional. A persona gives the assistant a name, a voice and a face. You can add or change one later in Settings.")
    Choice(
        selected = !state.withPersona,
        title = "No persona",
        subtitle = "Talk to the assistant itself. Voice and character are skipped.",
        onClick = { vm.setWithPersona(false) },
    )
    Choice(
        selected = state.withPersona,
        title = "Create a persona",
        subtitle = "Then pick its voice and character.",
        onClick = { vm.setWithPersona(true) },
    ) {
        if (state.withPersona) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Box(
                        Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (state.avatarUrl != null) {
                            AsyncImage(model = state.avatarUrl, contentDescription = "Picture", modifier = Modifier.fillMaxSize())
                        } else {
                            Icon(Icons.Outlined.Person, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                    }
                    OutlinedButton(onClick = { picker.launch("image/*") }, enabled = !state.uploadingAvatar) {
                        Text(if (state.uploadingAvatar) "Uploading…" else "Add picture")
                    }
                }
                OutlinedTextField(value = state.name, onValueChange = vm::setName, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = state.preferredName,
                    onValueChange = vm::setPreferredName,
                    label = { Text("Calls you") },
                    placeholder = { Text("Your name, or a nickname") },
                    supportingText = { Text("Optional") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun VoiceStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    Explanation("How ${state.name.trim()} sounds when replies are read aloud and in voice mode.")
    Choice(selected = state.voice == null, title = "No voice", subtitle = "Text replies only", onClick = { vm.pickVoice(null) })
    state.voices.forEach { v ->
        Choice(
            selected = state.voice == v.id,
            title = v.name.ifBlank { v.id },
            subtitle = v.model,
            onClick = { vm.pickVoice(v.id) },
            trailing = {
                IconButton(onClick = { vm.previewVoice(v.id) }) {
                    Icon(Icons.Outlined.PlayCircle, contentDescription = "Hear ${v.name.ifBlank { v.id }}", tint = MaterialTheme.colorScheme.primary)
                }
            },
        )
    }
    if (state.voices.isEmpty()) Explanation("This server has no voices yet. You can pick one later in Settings.")
}

@Composable
private fun CharacterStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri?.let { vm.pickVrm(it.toString()) }
    }
    Explanation("What ${state.name.trim()} looks like beside the chat and in voice mode.")
    Choice(
        selected = state.wantsModel,
        title = "3D model",
        subtitle = "A VRM file. It moves, blinks and lip-syncs while ${state.name.trim()} speaks.",
        onClick = { vm.setWantsModel(true) },
    ) {
        if (state.wantsModel) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(top = 10.dp).fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.ViewInAr, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Text(
                    state.vrmName?.let { name -> state.vrmSize?.let { "$name · ${"%.1f".format(it / (1024.0 * 1024.0))} MB" } ?: name } ?: "No file chosen",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { picker.launch(arrayOf("*/*")) }) { Text(if (state.vrmName != null) "Change" else "Choose file") }
            }
        }
    }
    Choice(
        selected = !state.wantsModel,
        title = "None for now",
        subtitle = "The picture from the persona step stands in.",
        onClick = { vm.setWantsModel(false) },
    )
}

@Composable
private fun WakeWordStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    val who = if (state.withPersona) state.name.trim() else "the assistant"
    Explanation("With voice mode on, saying it starts talking to $who. Pick a word you don’t say often by accident.")
    OutlinedTextField(
        value = state.wakeWord,
        onValueChange = vm::setWakeWord,
        label = { Text("Wake word") },
        placeholder = { if (!state.withPersona) Text("e.g. Computer") },
        supportingText = {
            Text(if (state.withPersona) "Starts as the persona’s name. Leave it empty for no wake word." else "Voice mode needs one. Leave it empty to set it later in Settings.")
        },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    val summary = buildList {
        add(state.model?.name ?: "No model yet")
        if (state.withPersona) {
            add(state.voice?.let { id -> state.voices.firstOrNull { it.id == id }?.name ?: id } ?: "No voice")
            add(if (state.wantsModel && state.vrmName != null) "3D model" else "No character yet")
        } else {
            add("no persona")
        }
    }.joinToString(" · ")
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(if (state.withPersona) state.name.trim() else "The assistant", style = MaterialTheme.typography.titleMedium)
            Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val wake = state.wakeWord.trim()
            Text(
                if (wake.isNotEmpty()) "Say “$wake” in voice mode" else "No wake word yet",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A selectable card: a radio, a title, a line under it, and what it opens. */
@Composable
private fun Choice(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().selectable(selected = selected, onClick = onClick, role = Role.RadioButton),
            ) {
                RadioButton(selected = selected, onClick = null)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                    Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                trailing?.invoke()
            }
            content?.invoke(this)
        }
    }
}

@Composable
private fun Finishing(state: OnboardingUiState, onTryAgain: () -> Unit, onBack: () -> Unit) {
    val parts = buildList {
        if (state.withPersona) {
            add(FinishPart.PERSONA to "Persona and voice")
            if (state.wantsModel && state.vrmName != null) add(FinishPart.CHARACTER to "Uploading ${state.vrmName}")
        }
        add(FinishPart.ASSISTANT to "Model, wake word and who answers")
    }
    val at = parts.indexOfFirst { it.first == state.part }
    Column(
        modifier = Modifier.fillMaxSize().systemBarsPadding().padding(32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            if (state.withPersona) "Setting up ${state.name.trim()}" else "Setting up the assistant",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(bottom = 24.dp),
        )
        parts.forEachIndexed { i, (part, label) ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp)) {
                when {
                    state.part == FinishPart.DONE || i < at -> Icon(Icons.Outlined.CheckCircle, contentDescription = "Done", tint = MaterialTheme.colorScheme.primary)
                    i == at && state.error == null -> CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp)
                    else -> Box(Modifier.size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant))
                }
                Column(Modifier.padding(start = 16.dp).weight(1f)) {
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                    if (part == FinishPart.CHARACTER && i == at && state.error == null) {
                        state.uploadFraction?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) }
                    }
                }
            }
        }
        state.error?.let { error ->
            Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 16.dp)) {
                OutlinedButton(onClick = onBack) { Text("Back") }
                Button(onClick = onTryAgain) { Text("Try again") }
            }
        }
        if (state.error == null) {
            Text(
                "Your first chat opens when this is done.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 24.dp),
            )
        }
    }
}
