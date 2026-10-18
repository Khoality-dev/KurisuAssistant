package com.kurisu.assistant.ui.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.domain.onboarding.ONBOARDING_PROVIDERS

/**
 * A new account's onboarding (#342): one screen, the model (#376) — once the
 * assistant has one it can be asked for the rest. [onFinished] opens the first
 * conversation; [onSkipped] goes on to the app as it is.
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

    // Back offers to skip rather than leaving silently.
    BackHandler(enabled = !state.finishing) { viewModel.askSkip() }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        ModelStep(state, viewModel)
    }

    if (state.confirmSkip) {
        AlertDialog(
            onDismissRequest = viewModel::dismissSkip,
            title = { Text("Skip setup?") },
            text = {
                Text(
                    "The assistant needs a model before it can answer, so your first message will ask you to choose one. " +
                        "This won’t come up again on any device.",
                )
            },
            confirmButton = { TextButton(onClick = viewModel::skip) { Text("Skip") } },
            dismissButton = { TextButton(onClick = viewModel::dismissSkip) { Text("Keep going") } },
        )
    }
}

@Composable
private fun ModelStep(state: OnboardingUiState, vm: OnboardingViewModel) {
    Column(modifier = Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = vm::askSkip) { Text("Skip") }
        }

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Model", style = MaterialTheme.typography.headlineMedium)
            Text(
                "One model answers for the assistant and every persona. You can change it later from the chat header.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Dropdown(
                label = "Provider",
                value = state.provider.label,
                options = ONBOARDING_PROVIDERS.map { it.label },
                onPick = { i -> vm.setProvider(ONBOARDING_PROVIDERS[i].id) },
            )

            val ollama = state.providerId == "ollama"
            val connected = state.providerModels.size
            OutlinedTextField(
                value = state.providerValue,
                onValueChange = vm::setProviderValue,
                label = { Text(state.provider.input) },
                placeholder = { if (ollama) Text("http://192.168.1.20:11434") },
                singleLine = true,
                isError = state.providerProblem != null,
                visualTransformation = if (ollama) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = if (ollama) KeyboardType.Uri else KeyboardType.Password),
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

            Dropdown(
                label = "Model",
                value = state.model?.takeIf { it.provider == state.providerId }?.name.orEmpty(),
                options = state.providerModels.map { it.name },
                onPick = { i -> vm.pickModel(state.providerModels[i]) },
                enabled = state.providerModels.isNotEmpty(),
            )

            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        }

        Row(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.End) {
            Button(onClick = vm::finish, enabled = state.canFinish) {
                Text(if (state.finishing) "Saving…" else "Start chatting")
            }
        }
    }
}

/** A read-only field that opens a menu of [options]; [onPick] gets the index picked. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dropdown(
    label: String,
    value: String,
    options: List<String>,
    onPick: (Int) -> Unit,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded && enabled, onExpandedChange = { if (enabled) expanded = it }) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            options.forEachIndexed { i, option ->
                DropdownMenuItem(
                    text = { Text(option) },
                    onClick = {
                        onPick(i)
                        expanded = false
                    },
                )
            }
        }
    }
}
