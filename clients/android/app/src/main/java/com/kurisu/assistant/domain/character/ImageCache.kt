package com.kurisu.assistant.domain.character

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ImageCache @Inject constructor() {

    private val cache = LruCache<String, Bitmap>(32) // up to 32 images

    suspend fun getImage(url: String): Bitmap? {
        cache.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            try {
                val stream = URL(url).openStream()
                val bitmap = BitmapFactory.decodeStream(stream)
                stream.close()
                if (bitmap != null) {
                    cache.put(url, bitmap)
                }
                bitmap
            } catch (e: Exception) {
                null
            }
        }
    }

    fun clear() {
        cache.evictAll()
    }
}
