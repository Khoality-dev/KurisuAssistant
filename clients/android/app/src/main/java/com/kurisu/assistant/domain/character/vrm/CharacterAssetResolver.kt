package com.kurisu.assistant.domain.character.vrm

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

private val SHA256 = Regex("^[0-9a-f]{64}$")
private val CLIP_ID = Regex("^[0-9a-f]{8}$")
private val MODEL_PATH = Regex("^(\\d+)/vrm/model$")
private val CLIP_PATH = Regex("^(\\d+)/vrma/([0-9a-f]{8})$")

/** The newest files the device keeps, by size. */
const val CHARACTER_CACHE_MAX_BYTES = 256L * 1024 * 1024

/**
 * The files a bound persona's VRM config names, by the digests the server
 * stored them under. Every server-supplied string that becomes part of a file
 * name is checked first (`CharacterConfigKind` checks the same).
 */
data class VrmAssetRefs(
    val personaId: Int,
    val modelSha256: String?,
    /** Clip id → sha256. */
    val clips: Map<String, String>,
) {
    companion object {
        /** Null when the config is not a VRM one, or names anything this device would not trust as a file name. */
        fun of(personaId: Int, config: JsonObject?): VrmAssetRefs? {
            val vrm = config?.get("vrm") as? JsonObject ?: return null
            val model = vrm["model"] as? JsonObject
            val modelSha = model?.let { (it["sha256"] as? JsonPrimitive)?.content ?: return null }
            if (modelSha != null && !SHA256.matches(modelSha)) return null
            val clips = mutableMapOf<String, String>()
            (vrm["clips"] as? JsonArray)?.forEach { clip ->
                clip as? JsonObject ?: return null
                val id = (clip["id"] as? JsonPrimitive)?.content ?: return null
                val sha = (clip["sha256"] as? JsonPrimitive)?.content ?: return null
                if (!CLIP_ID.matches(id) || !SHA256.matches(sha)) return null
                clips[id] = sha
            }
            return VrmAssetRefs(personaId, modelSha, clips)
        }
    }
}

/** One asset the page may ask for: where it is on the server and what its bytes must hash to. */
data class AssetTarget(val path: String, val sha256: String, val extension: String)

/** What the page gets back: a status, a type, and the file when there is one. */
data class Served(val status: Int, val mime: String, val file: File?)

/** Downloads [path] (under `/character-assets/`) into [into]; returns the HTTP status. */
fun interface CharacterAssetFetcher {
    fun fetch(path: String, into: File): Int
}

/**
 * Answers the character page's requests under `/character-assets/` (#246).
 *
 * The page fetches the config's root-relative URLs verbatim, as it does on the
 * desktop, and this answers them on the page's own origin: from
 * `cacheDir/character/{sha256}.vrm` when the bytes still hash to the digest the
 * config carries, otherwise by downloading through [fetcher] — the app's
 * authenticated client — so the bearer token never enters the web content. A
 * download that does not hash to that digest is refused and not kept. Only the
 * bound persona's own model and listed clips are answered; anything else is
 * a 404 without touching the network.
 *
 * Plain Kotlin, so it is tested on the JVM; `AuthedCharacterAssetHandler`
 * turns its answer into a `WebResourceResponse`.
 */
class CharacterAssetResolver(
    private val cacheDir: File,
    private val fetcher: CharacterAssetFetcher,
    private val maxBytes: Long = CHARACTER_CACHE_MAX_BYTES,
) {
    /** The bound persona's assets; null answers everything with a 404. */
    @Volatile var refs: VrmAssetRefs? = null

    fun resolve(path: String): AssetTarget? {
        val refs = refs ?: return null
        MODEL_PATH.matchEntire(path)?.let { m ->
            if (m.groupValues[1].toIntOrNull() != refs.personaId) return null
            val sha = refs.modelSha256 ?: return null
            return AssetTarget(path, sha, "vrm")
        }
        CLIP_PATH.matchEntire(path)?.let { m ->
            if (m.groupValues[1].toIntOrNull() != refs.personaId) return null
            val sha = refs.clips[m.groupValues[2]] ?: return null
            return AssetTarget(path, sha, "vrma")
        }
        return null
    }

    fun handle(path: String): Served = resolve(path)?.let(::serve) ?: Served(404, MIME, null)

    fun serve(target: AssetTarget): Served {
        cacheDir.mkdirs()
        val file = File(cacheDir, "${target.sha256}.${target.extension}")
        if (file.isFile && digestOf(file) == target.sha256) {
            file.setLastModified(System.currentTimeMillis())
            return Served(200, MIME, file)
        }
        file.delete()
        val part = File(cacheDir, "${target.sha256}.${target.extension}.part")
        try {
            val status = try {
                fetcher.fetch(target.path, part)
            } catch (e: IOException) {
                return Served(502, MIME, null)
            }
            if (status !in 200..299) return Served(status, MIME, null)
            if (digestOf(part) != target.sha256) return Served(502, MIME, null)
            if (!part.renameTo(file)) return Served(500, MIME, null)
            return Served(200, MIME, file)
        } finally {
            part.delete()
        }
    }

    /** Drop the least recently used files until the cache fits its budget. */
    fun evict() {
        val files = cacheDir.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() } ?: return
        var total = 0L
        for (f in files) {
            total += f.length()
            if (total > maxBytes) f.delete()
        }
    }

    private fun digestOf(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        // VRM and VRMA are both glTF binaries.
        const val MIME = "model/gltf-binary"
    }
}

/**
 * Downloads through the app's own [client] — the one carrying `AuthInterceptor`,
 * as Coil and `ImageCache` do — from the backend [baseUrl] says now.
 */
class OkHttpCharacterAssetFetcher(
    private val client: OkHttpClient,
    private val baseUrl: () -> String,
) : CharacterAssetFetcher {
    override fun fetch(path: String, into: File): Int {
        val request = Request.Builder().url("${baseUrl().trimEnd('/')}/character-assets/$path").build()
        client.newCall(request).execute().use { response ->
            if (response.isSuccessful) {
                into.outputStream().use { out -> response.body?.byteStream()?.copyTo(out) }
            }
            return response.code
        }
    }
}
