package com.kurisu.assistant.domain.character

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/**
 * The one reader of `character_config` on this client (#235).
 *
 * A VRM persona used to open the sheet on "This persona has no character
 * configured." while the persona list said "character"; the reader now names the
 * kind, and a config without one is not guessed at — the backend stamps every row
 * and refuses a save without `kind`, so a kind-less object is not "an old pose
 * graph", it is something this build cannot classify.
 */
class CharacterConfigKindTest {

    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private val tree = """{"default_pose_ids":[],"nodes":[],"edges":[]}"""
    private val sha = "a".repeat(64)

    @Test
    fun `nothing is NONE`() {
        assertThat(CharacterConfigKind.of(null)).isEqualTo(CharacterConfigKind.NONE)
    }

    @Test
    fun `a pose graph is drawn only when it carries a tree`() {
        assertThat(CharacterConfigKind.of(obj("""{"kind":"pose_graph","pose_tree":$tree}""")))
            .isEqualTo(CharacterConfigKind.POSE_GRAPH)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"pose_graph"}""")))
            .isEqualTo(CharacterConfigKind.NONE)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"pose_graph","pose_tree":null}""")))
            .isEqualTo(CharacterConfigKind.NONE)
    }

    @Test
    fun `a vrm config is recognised, whichever member sits beside it`() {
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm"}"""))).isEqualTo(CharacterConfigKind.VRM)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm","vrm":{"model":null,"clips":[]}}""")))
            .isEqualTo(CharacterConfigKind.VRM)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm","pose_tree":$tree,"vrm":{"model":{"sha256":"$sha"},"clips":[{"id":"deadbeef","sha256":"$sha"}]}}""")))
            .isEqualTo(CharacterConfigKind.VRM)
    }

    @Test
    fun `a missing or unknown kind is UNSUPPORTED, never a pose graph`() {
        assertThat(CharacterConfigKind.of(obj("""{"pose_tree":$tree}"""))).isEqualTo(CharacterConfigKind.UNSUPPORTED)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"hologram","pose_tree":$tree}""")))
            .isEqualTo(CharacterConfigKind.UNSUPPORTED)
        assertThat(CharacterConfigKind.of(obj("""{"kind":7}"""))).isEqualTo(CharacterConfigKind.UNSUPPORTED)
    }

    @Test
    fun `a vrm reference this device would turn into a file name is checked first`() {
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm","vrm":{"model":{"sha256":"../etc"}}}""")))
            .isEqualTo(CharacterConfigKind.UNSUPPORTED)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm","vrm":{"clips":[{"id":"../x","sha256":"$sha"}]}}""")))
            .isEqualTo(CharacterConfigKind.UNSUPPORTED)
        assertThat(CharacterConfigKind.of(obj("""{"kind":"vrm","vrm":"soon"}""")))
            .isEqualTo(CharacterConfigKind.UNSUPPORTED)
    }

    @Test
    fun `each kind has its sentence, and only a pose graph has none`() {
        assertThat(CharacterConfigKind.POSE_GRAPH.unrenderableMessage()).isNull()
        assertThat(CharacterConfigKind.NONE.unrenderableMessage())
            .isEqualTo("This persona has no character configured.")
        assertThat(CharacterConfigKind.VRM.unrenderableMessage())
            .isEqualTo("3D character — update the app to see it.")
        assertThat(CharacterConfigKind.UNSUPPORTED.unrenderableMessage())
            .isEqualTo("This character needs a newer app.")
        assertThat(CharacterConfigKind.VRM.metaLabel()).isEqualTo("3D character")
        assertThat(CharacterConfigKind.UNSUPPORTED.metaLabel()).isEqualTo("character (needs update)")
        assertThat(CharacterConfigKind.NONE.metaLabel()).isNull()
        assertThat(CharacterConfigKind.VRM.rowStatus()).isEqualTo("3D model")
        assertThat(CharacterConfigKind.UNSUPPORTED.rowStatus()).isEqualTo("Needs update")
    }
}
