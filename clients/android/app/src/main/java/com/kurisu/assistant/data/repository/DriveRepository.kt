package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.DriveFolderCreate
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.remote.api.KurisuApiService
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.RequestBody
import okhttp3.ResponseBody
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Kurisu Drive (#175): the account's files on the server, the same `/drive/…`
 * endpoints the desktop explorer browses. A null folder id is the root.
 */
@Singleton
class DriveRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun usage(): DriveUsage = api.getDriveUsage()

    suspend fun list(folderId: Int?): List<DriveNode> = api.listDriveNodes(folderId)

    suspend fun createFolder(parentId: Int?, name: String): DriveNode =
        api.createDriveFolder(DriveFolderCreate(parentId = parentId, name = name))

    suspend fun rename(id: Int, name: String): DriveNode =
        api.updateDriveNode(id, JsonObject(mapOf("name" to JsonPrimitive(name))))

    /** A null [folderId] is the root, sent as an explicit `null`: leaving it out would keep the parent. */
    suspend fun move(id: Int, folderId: Int?): DriveNode =
        api.updateDriveNode(id, JsonObject(mapOf("parent_id" to (folderId?.let(::JsonPrimitive) ?: JsonNull))))

    suspend fun delete(id: Int) {
        api.deleteDriveNode(id)
    }

    suspend fun upload(name: String, folderId: Int?, overwrite: Boolean, body: RequestBody): DriveNode =
        api.uploadDriveFile(name = name, parentId = folderId, overwrite = overwrite, body = body)

    /** Streamed: the caller reads it and must close it. */
    suspend fun download(id: Int): ResponseBody = api.downloadDriveFile(id)
}
