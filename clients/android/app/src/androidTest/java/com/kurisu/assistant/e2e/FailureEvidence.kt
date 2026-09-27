package com.kurisu.assistant.e2e

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * On a failure, keep what the device looked like: a screenshot and the log,
 * under /sdcard/Download/, where CI pulls them from (#310). A dump of the
 * Compose tree says nothing when the tree is empty, and the orchestrator
 * clears the app's own storage after every test.
 */
class FailureEvidence : TestWatcher() {
    override fun failed(e: Throwable, description: Description) {
        val name = "e2e-${description.testClass.simpleName}-${description.methodName}"
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
