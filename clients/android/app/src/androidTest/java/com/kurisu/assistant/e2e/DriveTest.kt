package com.kurisu.assistant.e2e

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Kurisu Drive on the phone (#175), against the mock's drive: browsing
 * into a folder, rename, move and delete, a file picked on the phone put on
 * the drive (and a taken name kept as both), and a file tapped downloaded and
 * handed to an app that opens it.
 *
 * The system file picker and the app that opens a file are not this app's, so
 * espresso-intents answers the picker and catches the open. Every test works
 * in a folder of its own: the mock's drive lasts the whole run.
 */
@RunWith(AndroidJUnit4::class)
class DriveTest : E2eTest() {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun recordIntents() {
        Intents.init()
    }

    @After
    fun releaseIntents() {
        Intents.release()
    }

    private fun idOf(response: String): Int = Json.parseToJsonElement(response).jsonObject.getValue("id").jsonPrimitive.int

    private fun folder(parentId: Int?, name: String): Int =
        idOf(mock.post("/drive/folders", """{"parent_id":${parentId ?: "null"},"name":"$name"}"""))

    private fun file(parentId: Int, name: String, content: String): Int =
        idOf(mock.postBytes("/drive/files?name=${Uri.encode(name)}&parent_id=$parentId", content.toByteArray()))

    private fun children(folderId: Int): List<JsonObject> =
        mock.getJson("/drive/nodes?parent_id=$folderId").jsonArray.map { it.jsonObject }

    private fun names(folderId: Int): List<String> = children(folderId).map { it.getValue("name").jsonPrimitive.content }

    /** Signs in, opens Drive, and goes into [name] at the drive's root. */
    private fun openFolder(name: String) {
        login()
        openDrawerItem("Drive")
        waitForNode("the drive's list", hasTestTag("drive-list"))
        composeRule.waitUntil(MockBackend.UI_TIMEOUT_MS) {
            runCatching { composeRule.onNodeWithTag("drive-list").performScrollToNode(hasText(name)) }.isSuccess
        }
        composeRule.onNodeWithText(name).performClick()
        waitForNode("the path at $name", hasText(name) and hasAnyAncestor(hasTestTag("drive-path")))
    }

    private fun rowMenu(name: String, item: String) {
        composeRule.onNodeWithContentDescription("More for $name").performClick()
        waitForText(item)
        composeRule.onNode(hasText(item) and hasClickAction()).performClick()
    }

    @Test
    fun a_folder_opens_and_what_is_in_it_can_be_renamed_moved_and_deleted() {
        val name = unique("Drive test")
        val folderId = folder(null, name)
        val archiveId = folder(folderId, "Archive")
        file(folderId, "hello.txt", "hello from the drive")

        openFolder(name)
        waitForText("Archive")
        waitForText("hello.txt")
        waitForText("20 B", substring = true)

        rowMenu("hello.txt", "Rename")
        composeRule.onNode(hasSetTextAction()).performTextReplacement("renamed.txt")
        composeRule.onNode(hasText("Save") and hasClickAction()).performClick()
        assertTrue("the rename never reached the server", waitUntilTrue { "renamed.txt" in names(folderId) })
        waitForText("renamed.txt")

        rowMenu("renamed.txt", "Move")
        waitForText("Move renamed.txt")
        val sheet = hasAnyAncestor(hasTestTag("drive-move-sheet"))
        composeRule.onNode(hasText("Archive") and sheet).performClick()
        waitForNode("the sheet inside Archive", hasText("Archive") and hasAnyAncestor(hasTestTag("drive-move-path")))
        composeRule.onNode(hasText("Move here") and hasClickAction()).performClick()
        assertTrue("the move never reached the server", waitUntilTrue { "renamed.txt" in names(archiveId) })
        waitUntilGone("renamed.txt")

        rowMenu("Archive", "Delete")
        waitForText("Delete Archive?")
        composeRule.onNode(hasText("Delete") and hasClickAction()).performClick()
        assertTrue("the delete never reached the server", waitUntilTrue { "Archive" !in names(folderId) })
        assertNull(mock.getOrNull("/drive/nodes/$archiveId"))
        waitUntilGone("Archive")
    }

    @Test
    fun a_file_picked_on_the_phone_goes_on_the_drive_and_a_taken_name_can_keep_both() {
        val name = unique("Drive upload")
        val folderId = folder(null, name)
        val picked = File(context.cacheDir, "drive/picked/notes.txt").apply {
            parentFile!!.mkdirs()
            writeText("picked on the phone")
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", picked)
        intending(hasAction(Intent.ACTION_OPEN_DOCUMENT)).respondWith(
            Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)),
        )

        openFolder(name)
        composeRule.onNodeWithContentDescription("Add").performClick()
        composeRule.onNode(hasText("Upload files") and hasClickAction()).performClick()
        assertTrue("the upload never reached the server", waitUntilTrue { "notes.txt" in names(folderId) })
        val id = children(folderId).single { it.getValue("name").jsonPrimitive.content == "notes.txt" }
            .getValue("id").jsonPrimitive.int
        assertEquals("picked on the phone", mock.get("/drive/files/$id/content"))
        waitForText("notes.txt")

        composeRule.onNodeWithContentDescription("Add").performClick()
        composeRule.onNode(hasText("Upload files") and hasClickAction()).performClick()
        waitForText("notes.txt is already here")
        composeRule.onNode(hasText("Keep both") and hasClickAction()).performClick()
        assertTrue("the second copy never reached the server", waitUntilTrue { "notes (1).txt" in names(folderId) })
        waitForText("notes (1).txt")
    }

    @Test
    fun a_file_tapped_is_downloaded_and_handed_to_an_app_that_opens_it() {
        val name = unique("Drive open")
        val folderId = folder(null, name)
        file(folderId, "hello.txt", "hello from the drive")
        intending(hasAction(Intent.ACTION_VIEW)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))

        openFolder(name)
        waitForText("hello.txt")
        composeRule.onNodeWithText("hello.txt").performClick()

        var opened: Intent? = null
        assertTrue(
            "nothing was opened",
            waitUntilTrue { Intents.getIntents().lastOrNull { it.action == Intent.ACTION_VIEW }?.also { opened = it } != null },
        )
        assertEquals("text/plain", opened!!.type)
        val text = context.contentResolver.openInputStream(opened!!.data!!)!!.bufferedReader().use { it.readText() }
        assertEquals("hello from the drive", text)
    }
}
