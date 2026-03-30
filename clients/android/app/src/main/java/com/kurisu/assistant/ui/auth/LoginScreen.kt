package com.kurisu.assistant.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    onLoginSuccess: () -> Unit,
    viewModel: LoginViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val loginSuccess by viewModel.loginSuccess.collectAsState()
    var passwordVisible by remember { mutableStateOf(false) }

    LaunchedEffect(loginSuccess) {
        if (loginSuccess != null) onLoginSuccess()
    }

    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(state.error) {
        state.error?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearError()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 32.dp)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.Start,
        ) {
            Spacer(Modifier.height(80.dp))

            // Title — minimal, left-aligned
            Text(
                text = "Kurisu",
                style = MaterialTheme.typography.displayMedium.copy(
                    fontWeight = FontWeight.Light,
                    letterSpacing = (-1).sp,
                ),
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                text = "Assistant",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(48.dp))

            // Login / Register tabs — sharp, minimal
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = state.isLoginMode,
                    onClick = { viewModel.setLoginMode(true) },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                ) { Text("Login") }
                SegmentedButton(
                    selected = !state.isLoginMode,
                    onClick = { viewModel.setLoginMode(false) },
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                ) { Text("Register") }
            }

            Spacer(Modifier.height(28.dp))

            // Server URL
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = viewModel::setServerUrl,
                label = { Text("Server") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                shape = RoundedCornerShape(6.dp),
            )

            Spacer(Modifier.height(12.dp))

            // Username
            OutlinedTextField(
                value = state.username,
                onValueChange = viewModel::setUsername,
                label = { Text("Username") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(6.dp),
            )

            Spacer(Modifier.height(12.dp))

            // Password
            OutlinedTextField(
                value = state.password,
                onValueChange = viewModel::setPassword,
                label = { Text("Password") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(6.dp),
                visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            if (passwordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = "Toggle password visibility",
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )

            // Email (register only)
            if (!state.isLoginMode) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = state.email,
                    onValueChange = viewModel::setEmail,
                    label = { Text("Email (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(6.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Remember Me
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    checked = state.rememberMe,
                    onCheckedChange = viewModel::setRememberMe,
                )
                Text(
                    "Remember me",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(24.dp))

            // Submit button — full width, sharp
            Button(
                onClick = viewModel::submit,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = !state.isLoading,
                shape = RoundedCornerShape(6.dp),
            ) {
                if (state.isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        if (state.isLoginMode) "Login" else "Register",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}
