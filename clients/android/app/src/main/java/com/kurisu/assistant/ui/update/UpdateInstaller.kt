package com.kurisu.assistant.ui.update

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Fires the system "install APK" intent for the given file. The OS will prompt for the
 * `REQUEST_INSTALL_PACKAGES` permission if not already granted — that prompt is unavoidable
 * and is the only user step that survives an "auto-update" flow.
 */
fun installApk(context: Context, file: File) {
    val uri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.fileprovider",
        file,
    )
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
}
