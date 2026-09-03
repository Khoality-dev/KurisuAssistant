package com.kurisu.assistant.domain.character

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.AnimationEdge
import com.kurisu.assistant.data.model.AnimationNode
import com.kurisu.assistant.data.model.EdgeTransition
import com.kurisu.assistant.data.model.PoseConfig
import com.kurisu.assistant.data.model.PoseTree
import com.kurisu.assistant.data.model.TransitionCondition
import org.junit.Test

class AnimationMigrationTest {

    @Test
    fun `no migration when no old ids present`() {
        val tree = PoseTree(
            defaultPoseIds = listOf("abc12345"),
            nodes = listOf(AnimationNode(id = "abc12345", name = "a")),
            edges = emptyList(),
        )
        val result = migratePoseTreeIds(tree)
        assertThat(result.idMapping).isEmpty()
        assertThat(result.poseTree).isSameInstanceAs(tree)
    }

    @Test
    fun `migrates old pose- ids to random hex`() {
        val tree = PoseTree(
            defaultPoseIds = listOf("pose-idle"),
            nodes = listOf(
                AnimationNode(id = "pose-idle", name = "idle"),
                AnimationNode(id = "pose-happy", name = "happy"),
            ),
            edges = emptyList(),
        )
        val result = migratePoseTreeIds(tree)
        assertThat(result.idMapping).hasSize(2)
        assertThat(result.idMapping.keys).containsExactly("pose-idle", "pose-happy")
        result.idMapping.values.forEach {
            assertThat(it).matches("[0-9a-f]{8}")
        }

        val migratedNodes = result.poseTree.nodes
        assertThat(migratedNodes.map { it.id })
            .containsExactly(result.idMapping["pose-idle"], result.idMapping["pose-happy"])
        assertThat(result.poseTree.defaultPoseIds)
            .containsExactly(result.idMapping["pose-idle"])
    }

    @Test
    fun `migrates old ids inside pose config image urls`() {
        val tree = PoseTree(
            nodes = listOf(
                AnimationNode(
                    id = "pose-idle",
                    name = "idle",
                    poseConfig = PoseConfig(
                        name = "idle",
                        baseImageUrl = "/poses/pose-idle/base.png",
                    ),
                ),
            ),
        )
        val result = migratePoseTreeIds(tree)
        val newId = result.idMapping["pose-idle"]!!
        val newConfig = result.poseTree.nodes.first().poseConfig!!
        assertThat(newConfig.baseImageUrl).contains(newId)
        assertThat(newConfig.baseImageUrl).doesNotContain("pose-idle")
    }

    @Test
    fun `migrates edges and strips edge- prefix in video urls`() {
        val tree = PoseTree(
            nodes = listOf(
                AnimationNode(id = "pose-a", name = "a"),
                AnimationNode(id = "pose-b", name = "b"),
            ),
            edges = listOf(
                AnimationEdge(
                    id = "edge-1",
                    fromNodeId = "pose-a",
                    toNodeId = "pose-b",
                    transitions = listOf(
                        EdgeTransition(
                            videoUrls = listOf("/edges/edge-1/video.mp4"),
                        )
                    ),
                )
            ),
        )
        val result = migratePoseTreeIds(tree)
        val newEdge = result.poseTree.edges.first()
        val newFrom = result.idMapping["pose-a"]!!
        val newTo = result.idMapping["pose-b"]!!

        assertThat(newEdge.fromNodeId).isEqualTo(newFrom)
        assertThat(newEdge.toNodeId).isEqualTo(newTo)
        assertThat(newEdge.id).isEqualTo("$newFrom-$newTo")

        val url = newEdge.transitions.first().videoUrls!!.first()
        assertThat(url).doesNotContain("/edges/edge-")
        assertThat(url).contains("$newFrom-$newTo")
    }

    @Test
    fun `migrateEdgeToTransitions adds default transition when empty`() {
        val edge = AnimationEdge(
            id = "e1",
            fromNodeId = "a",
            toNodeId = "b",
            transitions = emptyList(),
        )
        val migrated = migrateEdgeToTransitions(edge)
        assertThat(migrated.transitions).hasSize(1)
        val cond = migrated.transitions.first().conditions.first()
        assertThat(cond.type).isEqualTo("random")
        assertThat(cond.minIntervalMs).isEqualTo(5000L)
        assertThat(cond.maxIntervalMs).isEqualTo(15000L)
    }

    @Test
    fun `migrateEdgeToTransitions wraps transitions with empty conditions`() {
        val edge = AnimationEdge(
            id = "e1",
            fromNodeId = "a",
            toNodeId = "b",
            transitions = listOf(EdgeTransition(conditions = emptyList())),
        )
        val migrated = migrateEdgeToTransitions(edge)
        assertThat(migrated.transitions.first().conditions).hasSize(1)
    }

    @Test
    fun `migrateEdgeToTransitions returns same edge when already well-formed`() {
        val edge = AnimationEdge(
            id = "e1",
            fromNodeId = "a",
            toNodeId = "b",
            transitions = listOf(
                EdgeTransition(
                    conditions = listOf(TransitionCondition(type = "gesture")),
                )
            ),
        )
        val migrated = migrateEdgeToTransitions(edge)
        assertThat(migrated).isEqualTo(edge)
    }
}
