package com.kurisu.assistant.domain.character

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Caches character assets fetched from the server.
 *
 * Fetches go through the shared [OkHttpClient] so the auth interceptor attaches
 * the bearer token. These assets are served from an authenticated endpoint; a
 * bare `URL(url).openStream()` sends no credentials and comes back 401.
 */
@Singleton
class ImageCache @Inject constructor(
    private val httpClient: OkHttpClient,
) {

    private val cache = LruCache<String, Bitmap>(32) // up to 32 images

    suspend fun getImage(url: String): Bitmap? {
        cache.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder().url(url).build()
                httpClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@withContext null
                    val bitmap = response.body?.byteStream()?.let(BitmapFactory::decodeStream)
                    if (bitmap != null) {
                        cache.put(url, bitmap)
                    }
                    bitmap
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    fun clear() {
        cache.evictAll()
    }
}
