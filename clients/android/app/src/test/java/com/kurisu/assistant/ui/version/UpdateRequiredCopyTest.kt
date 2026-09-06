package com.kurisu.assistant.ui.version

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The update gate must say which side is behind (#150). A user who reads
 * "update the app" when the server is the old one reinstalls for nothing.
 */
class UpdateRequiredCopyTest {

    @Test
    fun `a newer server means the app must update`() {
        val copy = UpdateRequiredCopy.explain(clientWire = 5, serverWire = 6)

        assertThat(copy).isEqualTo(
            "This app speaks wire protocol 5 but the server speaks 6. Update the app.",
        )
    }

    @Test
    fun `an older server means the operator must update it`() {
        val copy = UpdateRequiredCopy.explain(clientWire = 5, serverWire = 4)

        assertThat(copy).isEqualTo(
            "This app speaks wire protocol 5 but the server speaks 4. Ask the operator to update the server.",
        )
    }

    @Test
    fun `an unknown server number blames neither side`() {
        val copy = UpdateRequiredCopy.explain(clientWire = 5, serverWire = -1)

        assertThat(copy).contains("wire protocol 5")
        assertThat(copy).contains("without saying which it speaks")
        assertThat(copy).doesNotContain("-1")
    }

    @Test
    fun `both numbers are always named`() {
        val copy = UpdateRequiredCopy.explain(clientWire = 7, serverWire = 12)

        assertThat(copy).contains("7")
        assertThat(copy).contains("12")
    }
}
