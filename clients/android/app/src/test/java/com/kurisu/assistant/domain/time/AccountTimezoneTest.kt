package com.kurisu.assistant.domain.time

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.UserProfile
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * The account's time zone (#352) is filled from this phone the first time it is
 * empty — once, without asking — and never overwritten afterwards. The desktop's
 * `fillTimezoneIfUnset` does the same.
 */
class AccountTimezoneTest {

    @Test
    fun `an empty account is filled from the phone`() = runTest {
        val sent = mutableListOf<String>()
        val user = fillTimezoneIfUnset(UserProfile(username = "a"), "Europe/Paris") { sent += it }
        assertThat(sent).containsExactly("Europe/Paris")
        assertThat(user.timezone).isEqualTo("Europe/Paris")
    }

    @Test
    fun `an account that has one is left alone`() = runTest {
        val sent = mutableListOf<String>()
        val user = fillTimezoneIfUnset(UserProfile(username = "a", timezone = "Asia/Tokyo"), "Europe/Paris") { sent += it }
        assertThat(sent).isEmpty()
        assertThat(user.timezone).isEqualTo("Asia/Tokyo")
    }

    @Test
    fun `nothing happens without a zone, or when the server says no`() = runTest {
        assertThat(fillTimezoneIfUnset(UserProfile(username = "a"), null) { error("not called") }.timezone).isNull()
        assertThat(fillTimezoneIfUnset(UserProfile(username = "a"), "Mars/Olympus") { error("422") }.timezone).isNull()
    }
}
