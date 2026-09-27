package com.kurisu.assistant.e2e

import androidx.test.platform.app.InstrumentationRegistry

/**
 * What the device looked like when a wait gave up: a screenshot and the log,
 * under /sdcard/Download/, where CI pulls them from (#310). Taken by the wait
 * helpers at the moment they fail — a JUnit rule runs only after `@After` has
 * closed the app, and captured the launcher instead.
 */
object FailureEvidence {
    fun capture(what: String) {
        val name = "e2e-${System.currentTimeMillis()}-" + what.replace(Regex("[^A-Za-z0-9]+"), "_").take(60)
        shell("screencap -p /sdcard/Download/$name.png")
        shell("logcat -d -v time -f /sdcard/Download/$name.log")
    }

    private fun shell(command: String) {
        runCatching {
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { fd ->
                // Read to the end: the command is not done until its output is drained.
                java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() }
            }
        }
    }
}
