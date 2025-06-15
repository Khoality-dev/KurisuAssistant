package com.kurisuassistant.android.utils

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.annotation.RawRes
import androidx.collection.MutableIntList
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder

object Util {
    fun toByteArray(intArray:MutableIntList, le: Boolean = true): ByteArray {
        val bb = ByteBuffer.allocate(intArray.size * Short.SIZE_BYTES)
            .order(if (le) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN)
        for (i in 0 until intArray.size) {
            val shortValue = intArray[i].toShort()
            bb.putShort(shortValue)
        }
        return bb.array()
    }

    fun toShortArray(data: ByteArray, le: Boolean = true): ShortArray {
        val bb = ByteBuffer
            .wrap(data)
            .order(if (le) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN)

        // asIntBuffer() views the bytes as ints
        val shortBuf = bb.asShortBuffer()
        val result = ShortArray(shortBuf.remaining())
        shortBuf.get(result)
        return result
    }

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
            != PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.INTERNET)
            != PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.ACCESS_NETWORK_STATE)
            != PackageManager.PERMISSION_GRANTED
            )
            {
            ActivityCompat.requestPermissions(
                /* activity = */ activity,
                /* permissions = */ arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.FOREGROUND_SERVICE, Manifest.permission.ACCESS_NETWORK_STATE, Manifest.permission.INTERNET),
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

    fun loadWavFile(context: Context, @RawRes resId: Int): ShortArray {
        context.resources.openRawResource(resId).use { input ->
            // Skip 44-byte WAV header
            input.skip(44)

            // Read remaining bytes into a buffer
            val pcmBytes = input.readBytes()
            // Convert bytes to 16-bit samples
            val shorts = ShortArray(pcmBytes.size / 2)
            ByteBuffer.wrap(pcmBytes)
                .order(ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
                .get(shorts)
            return shorts
        }
    }
}
