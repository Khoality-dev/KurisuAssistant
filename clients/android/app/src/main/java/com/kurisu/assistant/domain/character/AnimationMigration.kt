package com.kurisu.assistant.domain.character

import com.kurisu.assistant.data.model.*
import java.util.UUID

private fun randomHexId(): String =
    UUID.randomUUID().toString().replace("-", "").take(8)

private fun isOldNodeId(id: String): Boolean =
    id.startsWith("pose-")

private fun remapUrl(url: String, idMapping: Map<String, String>): String {
    var result = url
    for ((oldId, newId) in idMapping) {
        result = result.replace(oldId, newId)
    }
    return result
}

data class MigrationResult(
    val poseTree: PoseTree,
    val idMapping: Map<String, String>,
)

fun migratePoseTreeIds(poseTree: PoseTree): MigrationResult {
    val needsMigration = poseTree.nodes.any { isOldNodeId(it.id) }
    if (!needsMigration) return MigrationResult(poseTree, emptyMap())

    val idMapping = mutableMapOf<String, String>()
    for (node in poseTree.nodes) {
        if (isOldNodeId(node.id)) {
            idMapping[node.id] = randomHexId()
        }
    }

    val nodes = poseTree.nodes.map { n ->
        val newId = idMapping[n.id] ?: n.id
        val newPoseConfig = n.poseConfig?.let { pc ->
            pc.copy(
                baseImageUrl = remapUrl(pc.baseImageUrl, idMapping),
                leftEye = EyePart(pc.leftEye.patches.map { p ->
                    p.copy(imageUrl = remapUrl(p.imageUrl, idMapping))
                }),
                rightEye = EyePart(pc.rightEye.patches.map { p ->
                    p.copy(imageUrl = remapUrl(p.imageUrl, idMapping))
                }),
                mouth = MouthPart(pc.mouth.patches.map { p ->
                    p.copy(imageUrl = remapUrl(p.imageUrl, idMapping))
                }),
            )
        }
        n.copy(id = newId, poseConfig = newPoseConfig)
    }

    val edgeIdMapping = mutableMapOf<String, String>()
    val edges = poseTree.edges.map { e ->
        val newFrom = idMapping[e.fromNodeId] ?: e.fromNodeId
        val newTo = idMapping[e.toNodeId] ?: e.toNodeId
        val newEdgeId = "$newFrom-$newTo"
        edgeIdMapping[e.id] = newEdgeId

        e.copy(
            id = newEdgeId,
            fromNodeId = newFrom,
            toNodeId = newTo,
            transitions = e.transitions.map { t ->
                t.copy(
                    videoUrls = t.videoUrls?.map { url ->
                        var remapped = remapUrl(url, idMapping)
                        remapped = remapUrl(remapped, edgeIdMapping)
                        remapped = remapped.replace("/edges/edge-", "/edges/")
                        remapped
                    }
                )
            }
        )
    }

    val defaultPoseIds = poseTree.defaultPoseIds.map { idMapping[it] ?: it }

    return MigrationResult(
        poseTree = PoseTree(defaultPoseIds = defaultPoseIds, nodes = nodes, edges = edges),
        idMapping = idMapping,
    )
}

/**
 * Migrate legacy single-transition edges to the transitions[] format.
 */
fun migrateEdgeToTransitions(edge: AnimationEdge): AnimationEdge {
    // Already has properly formatted transitions
    if (edge.transitions.isNotEmpty() && edge.transitions.all { it.conditions.isNotEmpty() }) {
        return edge
    }

    // If transitions exist but conditions are empty, wrap them
    val defaultCond = TransitionCondition(type = "random", minIntervalMs = 5000, maxIntervalMs = 15000)

    val transitions = if (edge.transitions.isNotEmpty()) {
        edge.transitions.map { t ->
            if (t.conditions.isNotEmpty()) t
            else t.copy(conditions = listOf(defaultCond))
        }
    } else {
        listOf(EdgeTransition(
            conditions = listOf(defaultCond),
            videoUrls = null,
            playbackRate = null,
        ))
    }

    return edge.copy(transitions = transitions)
}
