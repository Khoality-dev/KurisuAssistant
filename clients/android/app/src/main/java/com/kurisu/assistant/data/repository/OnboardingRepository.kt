package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.domain.drive.UploadSource
import com.kurisu.assistant.domain.onboarding.OnboardingApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okio.BufferedSink
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/** Onboarding's calls (#342), against the real API. */
@Singleton
class OnboardingRepository @Inject constructor(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
) : OnboardingApi {

    /** Whether the server says this account is owed its onboarding. */
    suspend fun isPending(): Boolean = api.getUserProfile().onboardingPending

    override suspend fun patchProfile(body: JsonObject) {
        api.patchUserProfile(body)
    }

    override suspend fun models(): ModelsResponse = api.getModels()

    override suspend fun createPersona(data: PersonaCreate): Persona = api.createPersona(data)

    override suspend fun patchAssistant(body: JsonObject) {
        api.patchAssistant(body)
    }

    /**
     * Stream [source] up as the persona's model. The server wants its sha256
     * first, so the file is read twice — once to hash, once to send — rather
     * than held in memory: a model can be 100 MB.
     */
    override suspend fun uploadVrm(personaId: Int, source: UploadSource, onProgress: (Long, Long?) -> Unit) {
        val sha256 = withContext(Dispatchers.IO) {
            val md = MessageDigest.getInstance("SHA-256")
            source.open().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    md.update(buffer, 0, n)
                }
            }
            md.digest().joinToString("") { "%02x".format(it) }
        }
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength(): Long = source.size ?: -1
            override fun writeTo(sink: BufferedSink) {
                var sent = 0L
                source.open().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        sink.write(buffer, 0, n)
                        sent += n
                        onProgress(sent, source.size)
                    }
                }
            }
        }
        api.uploadVrmModel(personaId, sha256, source.name, body)
    }

    /** Where an uploaded picture is shown from; Coil's client carries the token. */
    suspend fun imageUrl(uuid: String): String = "${prefs.getBackendUrl().trimEnd('/')}/images/$uuid"

    /** A picture for the persona; answers its image id. */
    suspend fun uploadAvatar(file: File): String {
        val mime = when (file.extension.lowercase()) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            else -> "image/jpeg"
        }
        val part = MultipartBody.Part.createFormData("file", file.name, file.asRequestBody(mime.toMediaType()))
        return api.uploadImage(part).imageUuid
    }
}
