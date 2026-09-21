package com.kurisu.assistant.ui.version

import java.io.File

/**
 * Where an update asked for from the gate has got to (#264).
 *
 * The gate used to fire "Check for updates" and say nothing afterwards —
 * a download you could not see, an error you never heard of, and "Update the
 * app" still on screen when the app was already the newest one. These are the
 * states the screen renders; the reducer and the sentences are pure so they
 * are unit-tested, and `MainActivity` only feeds them.
 */
sealed interface UpdateFlowState {
    data object Idle : UpdateFlowState
    data object Checking : UpdateFlowState
    data class Downloading(val version: String, val progress: Float) : UpdateFlowState
    data class Ready(val version: String, val file: File) : UpdateFlowState
    /** The check ran and this is the newest release there is. */
    data object None : UpdateFlowState
    data class Error(val message: String) : UpdateFlowState
}

object UpdateFlow {
    /** The sentence under the button, or null when there is nothing to say yet. */
    fun describe(state: UpdateFlowState, appVersion: String): String? = when (state) {
        UpdateFlowState.Idle -> null
        UpdateFlowState.Checking -> "Checking for a newer release…"
        is UpdateFlowState.Downloading ->
            "Downloading ${state.version}… ${(state.progress * 100).toInt().coerceIn(0, 100)}%"
        is UpdateFlowState.Ready -> "Version ${state.version} is downloaded. Install it to finish."
        UpdateFlowState.None ->
            "You already have the newest release ($appVersion). The server is what has to be updated."
        is UpdateFlowState.Error -> state.message
    }

    /** What the one button reads, or null while nothing can be pressed. */
    fun buttonLabel(state: UpdateFlowState): String? = when (state) {
        UpdateFlowState.Idle, UpdateFlowState.None, is UpdateFlowState.Error -> "Update now"
        UpdateFlowState.Checking, is UpdateFlowState.Downloading -> null
        is UpdateFlowState.Ready -> "Install update"
    }

    /**
     * Whether the gate should offer this app an update at all. The server
     * being behind is the operator's to fix (#150); a server that refused
     * without saying which protocol it speaks (wire below zero) may be either,
     * so the offer stays — the check then says whether anything is newer.
     */
    fun offersUpdate(clientWire: Int, serverWire: Int): Boolean =
        serverWire < 0 || serverWire > clientWire

    /** The error sentence for a failed check or download. */
    fun failed(stage: String, throwable: Throwable): UpdateFlowState.Error =
        UpdateFlowState.Error("Could not $stage: ${throwable.message ?: throwable::class.simpleName}")
}
