package com.kurisu.assistant.e2e

import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.Statement

/**
 * Run a failed full-app test once more, from its `@Before` (#310).
 *
 * CI's software-rendered emulator now and then shows nothing at all — an empty
 * Compose tree beside "Failed to find ColorBuffer" in its log — and which test
 * it lands on changes from run to run. One retry absorbs that; a real failure
 * fails twice. Every retry is printed, so a flake stays visible in the log
 * instead of passing silently.
 */
class RetryOnce : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            try {
                base.evaluate()
            } catch (first: Throwable) {
                if (first is org.junit.AssumptionViolatedException) throw first
                println("E2E RETRY ${description.displayName}: ${first.javaClass.simpleName}: ${first.message?.lineSequence()?.firstOrNull()}")
                base.evaluate()
            }
        }
    }
}
