package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.FaceIdentity
import com.kurisu.assistant.data.model.FaceIdentityDetail
import com.kurisu.assistant.data.model.FacePhoto
import com.kurisu.assistant.data.remote.api.KurisuApiService
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FaceRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun listFaces(): List<FaceIdentity> = api.listFaces()

    suspend fun getFace(id: Int): FaceIdentityDetail = api.getFace(id)

    suspend fun deleteFace(id: Int) = api.deleteFace(id)

    suspend fun deleteFacePhoto(identityId: Int, photoId: Int) =
        api.deleteFacePhoto(identityId, photoId)

    suspend fun createFace(name: String, photo: File): FaceIdentity {
        val part = photo.toMultipart("photo")
        return api.createFace(name = name, photo = part)
    }

    suspend fun addFacePhoto(identityId: Int, photo: File): FacePhoto {
        val part = photo.toMultipart("photo")
        return api.addFacePhoto(id = identityId, photo = part)
    }

    private fun File.toMultipart(name: String): MultipartBody.Part {
        val mime = when (extension.lowercase()) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            else -> "image/jpeg"
        }
        val body = asRequestBody(mime.toMediaType())
        return MultipartBody.Part.createFormData(name, this.name, body)
    }
}
