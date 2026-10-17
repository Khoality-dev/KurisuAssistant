package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Kurisu Drive (#17, #175): a file or folder in the account's own storage.
 *
 * Mirrors `routers/drive.py::_node_to_response` in the backend. A folder has
 * `size` 0 and no `mime` or `checksum`. The server guesses `mime` from the name
 * and never takes it from the client.
 */
@Serializable
data class DriveNode(
    val id: Int,
    @SerialName("parent_id") val parentId: Int? = null,
    val name: String,
    @SerialName("is_dir") val isDir: Boolean = false,
    val size: Long = 0,
    val mime: String? = null,
    val checksum: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** `GET /drive/usage`. Folders count towards none of these. */
@Serializable
data class DriveUsage(
    @SerialName("used_bytes") val usedBytes: Long = 0,
    @SerialName("quota_bytes") val quotaBytes: Long = 0,
    @SerialName("file_count") val fileCount: Int = 0,
    /** The largest single file the server takes. */
    @SerialName("max_file_bytes") val maxFileBytes: Long = 0,
)

/** `POST /drive/folders`. A null [parentId] is the drive's root, and is sent as `null`. */
@Serializable
data class DriveFolderCreate(
    @SerialName("parent_id") val parentId: Int?,
    val name: String,
)
