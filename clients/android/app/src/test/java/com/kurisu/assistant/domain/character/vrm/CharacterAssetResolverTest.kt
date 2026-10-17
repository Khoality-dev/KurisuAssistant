package com.kurisu.assistant.domain.character.vrm

import com.google.common.truth.Truth.assertThat
import com.google.common.truth.Truth.assertWithMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

/**
 * The page asks for its model and clips at the config's own root-relative URLs
 * (`/character-assets/{persona}/vrm/model`), and Kotlin answers them: from the
 * device cache when the digest matches, otherwise downloaded with the app's
 * authenticated client. The bearer token never enters the web content (#246).
 */
class CharacterAssetResolverTest {

    @get:Rule val tmp = TemporaryFolder()

    private val model = "glTF-model-bytes".toByteArray()
    private val clip = "glTF-clip-bytes".toByteArray()
    private val modelSha = sha256(model)
    private val clipSha = sha256(clip)

    private lateinit var cacheDir: File
    private val fetched = mutableListOf<String>()
    private var answers: (String) -> Pair<Int, ByteArray?> = { path ->
        when (path) {
            "1/vrm/model" -> 200 to model
            "1/vrma/a1b2c3d4" -> 200 to clip
            else -> 404 to null
        }
    }
    private val fetcher = CharacterAssetFetcher { path, into ->
        fetched += path
        val (status, body) = answers(path)
        if (body != null) into.writeBytes(body)
        status
    }

    private fun config(personaId: Int = 1, sha: String = modelSha) = Json.parseToJsonElement(
        """
        {"kind":"vrm","pose_tree":null,"vrm":{
          "model":{"url":"/character-assets/$personaId/vrm/model","sha256":"$sha","bytes":16,"uploaded_at":"2026-09-20T00:00:00Z"},
          "clips":[{"id":"a1b2c3d4","name":"Idle","url":"/character-assets/$personaId/vrma/a1b2c3d4","sha256":"$clipSha","bytes":15,"loop":true}]
        }}
        """.trimIndent(),
    ).jsonObject

    private lateinit var resolver: CharacterAssetResolver

    @Before
    fun setUp() {
        cacheDir = tmp.newFolder("character")
        resolver = CharacterAssetResolver(cacheDir, fetcher)
        resolver.refs = VrmAssetRefs.of(1, config())
    }

    @After
    fun tearDown() = Unit

    @Test
    fun `the model is downloaded once, checked, and then served from the device`() {
        val first = resolver.handle("1/vrm/model")
        assertThat(first.status).isEqualTo(200)
        assertThat(first.mime).isEqualTo("model/gltf-binary")
        assertThat(first.file!!.readBytes()).isEqualTo(model)
        assertThat(first.file!!.name).isEqualTo("$modelSha.vrm")

        val second = resolver.handle("1/vrm/model")
        assertThat(second.status).isEqualTo(200)
        assertThat(fetched).containsExactly("1/vrm/model")
    }

    @Test
    fun `a clip is served the same way under its own digest`() {
        val served = resolver.handle("1/vrma/a1b2c3d4")
        assertThat(served.status).isEqualTo(200)
        assertThat(served.file!!.name).isEqualTo("$clipSha.vrma")
    }

    @Test
    fun `a cached file whose bytes no longer match is fetched again`() {
        File(cacheDir, "$modelSha.vrm").writeBytes("corrupt".toByteArray())
        val served = resolver.handle("1/vrm/model")
        assertThat(served.status).isEqualTo(200)
        assertThat(served.file!!.readBytes()).isEqualTo(model)
        assertThat(fetched).containsExactly("1/vrm/model")
    }

    @Test
    fun `a download that is not the file the config names is refused and not kept`() {
        answers = { 200 to "something else".toByteArray() }
        val served = resolver.handle("1/vrm/model")
        assertThat(served.status).isEqualTo(502)
        assertThat(served.file).isNull()
        assertThat(cacheDir.listFiles()!!.toList()).isEmpty()
    }

    @Test
    fun `the server's refusal reaches the page as its status`() {
        answers = { 401 to null }
        assertThat(resolver.handle("1/vrm/model").status).isEqualTo(401)
        answers = { 404 to null }
        assertThat(resolver.handle("1/vrma/a1b2c3d4").status).isEqualTo(404)
        assertThat(cacheDir.listFiles()!!.toList()).isEmpty()
    }

    @Test
    fun `only the bound persona's own model and clips are answered`() {
        // Another persona, a clip the config does not list, a path that tries to
        // climb out of the prefix, and anything else under /character-assets/.
        for (path in listOf("2/vrm/model", "1/vrma/deadbeef", "1/vrm/../../etc/passwd", "1/vrm/model/x", "1/base.png", "")) {
            assertWithMessage(path).that(resolver.handle(path).status).isEqualTo(404)
        }
        assertThat(fetched).isEmpty()
        resolver.refs = null
        assertThat(resolver.handle("1/vrm/model").status).isEqualTo(404)
    }

    @Test
    fun `a digest that is not one is never turned into a file name`() {
        assertThat(VrmAssetRefs.of(1, config(sha = "../../shared_prefs/x"))).isNull()
        assertThat(VrmAssetRefs.of(1, config(sha = modelSha.uppercase()))).isNull()
    }

    @Test
    fun `the cache keeps the newest files under its budget`() {
        val small = CharacterAssetResolver(cacheDir, fetcher, maxBytes = 25)
        File(cacheDir, "a".repeat(64) + ".vrm").apply { writeBytes(ByteArray(10)); setLastModified(1_000) }
        File(cacheDir, "b".repeat(64) + ".vrm").apply { writeBytes(ByteArray(10)); setLastModified(2_000) }
        File(cacheDir, "c".repeat(64) + ".vrma").apply { writeBytes(ByteArray(10)); setLastModified(3_000) }
        small.evict()
        assertThat(cacheDir.listFiles()!!.map { it.name.first() }).containsExactly('b', 'c')
    }

    @Test
    fun `the download goes through the app's client to the server's own path`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(model)))
        server.enqueue(MockResponse().setResponseCode(401))
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val okhttp = OkHttpCharacterAssetFetcher(OkHttpClient()) { base }
            val into = tmp.newFile("download.part")
            assertThat(okhttp.fetch("1/vrm/model", into)).isEqualTo(200)
            assertThat(into.readBytes()).isEqualTo(model)
            assertThat(server.takeRequest().path).isEqualTo("/character-assets/1/vrm/model")

            val refused = tmp.newFile("refused.part")
            assertThat(okhttp.fetch("1/vrm/model", refused)).isEqualTo(401)
            assertThat(refused.length()).isEqualTo(0)
        } finally {
            server.shutdown()
        }
    }

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
