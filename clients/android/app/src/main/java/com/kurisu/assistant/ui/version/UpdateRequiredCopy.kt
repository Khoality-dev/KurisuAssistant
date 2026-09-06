package com.kurisu.assistant.ui.version

/**
 * The sentence on the update gate. Pure so it can be unit-tested: which side
 * to update follows from which wire-protocol number is higher, and getting
 * that wrong sends the user to reinstall an app that was never the problem.
 */
object UpdateRequiredCopy {
    /**
     * [serverWire] below zero means the server refused the protocol without
     * saying which one it speaks (an HTTP 426 with an unreadable body), so
     * neither side can be blamed.
     */
    fun explain(clientWire: Int, serverWire: Int): String {
        if (serverWire < 0) {
            return "This app speaks wire protocol $clientWire and the server refused it " +
                "without saying which it speaks. Update the app, or ask the operator which version the server runs."
        }
        val versions = "This app speaks wire protocol $clientWire but the server speaks $serverWire."
        val action = if (serverWire > clientWire) {
            "Update the app."
        } else {
            "Ask the operator to update the server."
        }
        return "$versions $action"
    }
}
