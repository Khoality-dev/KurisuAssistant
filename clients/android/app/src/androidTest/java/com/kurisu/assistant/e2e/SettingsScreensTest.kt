package com.kurisu.assistant.e2e

import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The screens that edit what lives on the server — personas, skills, MCP
 * servers — each checked against what the mock stored, and About (#310).
 */
@RunWith(AndroidJUnit4::class)
class SettingsScreensTest : E2eTest() {

    private fun names(path: String, key: String = "name"): List<String> {
        val body = mock.getJson(path)
        val rows = (body as? JsonArray) ?: body.jsonObject.values.first { it is JsonArray }.jsonArray
        return rows.mapNotNull { it.jsonObject.string(key) }
    }

    private fun waitForServer(path: String, name: String, present: Boolean) {
        waitUntilTrue { (name in names(path)) == present }
        if (present) assertTrue("$name is on the server at $path", name in names(path))
        else assertFalse("$name is gone from $path", name in names(path))
    }

    private fun confirmDelete() =
        composeRule.onNode(hasText("Delete") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()

    @Test
    fun a_persona_is_created_and_deleted() {
        login()
        openDrawerItem("Personas")
        val name = unique("E2E persona")

        composeRule.onNodeWithText("New persona", useUnmergedTree = true).performClick()
        waitForText("Persona name")
        // The name is the editor's first text field.
        composeRule.onAllNodes(hasSetTextAction()).onFirst().performTextInput(name)
        composeRule.onNode(hasText("Create") and hasClickAction()).performClick()
        waitForText(name)
        waitForServer("/personas", name, present = true)

        composeRule.onNodeWithContentDescription("Edit $name").performClick()
        // The edit sheet opens a moment after the tap, and the button is below its
        // fold: wait for it, then scroll to it — a touch sent off screen lands nowhere.
        val deleteButton = hasText("Delete persona") and hasClickAction()
        // The merged tree, as the click uses: unmerged, the label carries no click action.
        assertTrue("the Delete persona button appears",
            waitUntilTrue { composeRule.onAllNodes(deleteButton).fetchSemanticsNodes().isNotEmpty() })
        composeRule.onNode(deleteButton).performScrollTo().performClick()
        waitForText("Conversations it answered", substring = true)
        confirmDelete()
        waitUntilGone(name)
        waitForServer("/personas", name, present = false)
    }

    @Test
    fun a_persona_voice_is_picked_by_name_and_stored_by_id() {
        login()
        openDrawerItem("Personas")
        waitForText("Kurisu")

        composeRule.onNodeWithContentDescription("Edit Kurisu").performClick()
        // The voice field shows its placeholder while none is set; a tap opens the list
        // of the engines' presets (#214), which used to fail to decode and read
        // "No voices available".
        waitForText("None")
        composeRule.onAllNodesWithText("None", useUnmergedTree = true).onFirst().performClick()
        waitForText("Kurisu (Japanese)")
        composeRule.onNodeWithText("Kurisu (Japanese)", useUnmergedTree = true).performClick()
        composeRule.onNode(hasText("Save") and hasClickAction()).performClick()

        waitUntilTrue { kurisuVoice() == "kurisu_ja_01" }
        assertTrue("the preset's id is stored, not its name: ${kurisuVoice()}", kurisuVoice() == "kurisu_ja_01")
        // The row reads the voice by name, as the picker did.
        waitForText("Kurisu (Japanese)", substring = true)
    }

    private fun kurisuVoice(): String? =
        mock.getJson("/personas").jsonArray.map { it.jsonObject }
            .single { it.string("name") == "Kurisu" }.string("voice_reference")

    @Test
    fun a_skill_is_created_and_deleted() {
        login()
        openDrawerItem("Skills")
        val name = unique("E2E skill")

        composeRule.onNodeWithContentDescription("New Skill").performClick()
        composeRule.onNodeWithText("Name").performTextInput(name)
        composeRule.onNodeWithText("Instructions").performTextInput("Answer in haiku.")
        composeRule.onNode(hasText("Create") and hasClickAction()).performClick()
        waitForText(name)
        waitForServer("/skills", name, present = true)

        // The newest skill is listed last.
        composeRule.onAllNodesWithContentDescription("Delete").onLast().performClick()
        waitForText("Delete \"$name\"?")
        confirmDelete()
        waitUntilGone(name)
        waitForServer("/skills", name, present = false)
    }

    @Test
    fun an_mcp_server_is_added_and_deleted() {
        login()
        openDrawerItem("Tools & MCP")
        val name = unique("E2E server")

        composeRule.onNodeWithContentDescription("Add MCP server").performClick()
        composeRule.onNodeWithText("Server name").performTextInput(name)
        composeRule.onNodeWithText("URL").performTextInput("http://127.0.0.1:9/sse")
        composeRule.onNode(hasText("Save") and hasClickAction()).performClick()
        waitForText(name)
        waitForServer("/mcp-servers", name, present = true)

        composeRule.onAllNodesWithContentDescription("Delete").onLast().performClick()
        waitForText("Delete server?")
        confirmDelete()
        waitUntilGone(name)
        waitForServer("/mcp-servers", name, present = false)
    }

    @Test
    fun about_names_the_backend_it_is_talking_to() {
        login()
        openDrawerItem("Settings")
        waitForText("About")
        composeRule.onNodeWithText("About").performClick()
        waitForText("Backend: ", substring = true)
        waitForText(" · wire ", substring = true)
        waitUntilGone("Backend: unreachable")
    }
}
