package com.kurisuassistant.android.utils

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

object Util {
    fun checkPermissions(activity: Activity?) {
        if (ContextCompat.checkSelfPermission(
                activity!!,
                Manifest.permission.RECORD_AUDIO
            )
            != PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.FOREGROUND_SERVICE
            )
            != PackageManager.PERMISSION_GRANTED)
            {
            ActivityCompat.requestPermissions(
                /* activity = */ activity,
                /* permissions = */ arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.FOREGROUND_SERVICE),
                /* requestCode = */ 0
            )
        }
    }

    fun getBitmap(context: Context, imgUri: Uri): Bitmap {
        var bitmap = BitmapFactory.decodeStream(context.contentResolver.openInputStream(imgUri))
        val matrix = Matrix()
        matrix.setRotate(90f)
        var ret = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        return ret
    }
}
