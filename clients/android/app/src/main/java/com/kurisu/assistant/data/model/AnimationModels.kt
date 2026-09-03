package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PatchInfo(
    @SerialName("image_url") val imageUrl: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

@Serializable
data class EyePart(
    val patches: List<PatchInfo> = emptyList(),
)

@Serializable
data class MouthPart(
    val patches: List<PatchInfo> = emptyList(),
)

@Serializable
data class PoseConfig(
    val name: String,
    @SerialName("base_image_url") val baseImageUrl: String,
    @SerialName("left_eye") val leftEye: EyePart = EyePart(),
    @SerialName("right_eye") val rightEye: EyePart = EyePart(),
    val mouth: MouthPart = MouthPart(),
)

@Serializable
data class TransitionCondition(
    val type: String = "random",
    @SerialName("min_interval_ms") val minIntervalMs: Long = 5000,
    @SerialName("max_interval_ms") val maxIntervalMs: Long = 15000,
    val value: kotlinx.serialization.json.JsonPrimitive? = null,
    val visible: Boolean? = null,
) {
    val isRandom get() = type == "random"
    val isThinking get() = type == "thinking"
    val isGesture get() = type == "gesture"
    val isFace get() = type == "face"
    val booleanValue get() = value?.content?.toBooleanStrictOrNull() ?: false
    val stringValue get() = value?.content ?: ""
}

// Type aliases for readability in compositor
typealias RandomCondition = TransitionCondition
typealias ThinkingCondition = TransitionCondition
typealias GestureCondition = TransitionCondition
typealias FaceCondition = TransitionCondition

@Serializable
data class AnimationSettings(
    @SerialName("breathing_enabled") val breathingEnabled: Boolean = true,
    @SerialName("breathing_amplitude") val breathingAmplitude: Float = 3f,
    @SerialName("breathing_period") val breathingPeriod: Float = 3500f,
    @SerialName("blink_min_interval") val blinkMinInterval: Float = 2000f,
    @SerialName("blink_max_interval") val blinkMaxInterval: Float = 6000f,
    @SerialName("blink_close_duration") val blinkCloseDuration: Float = 100f,
    @SerialName("blink_hold_duration") val blinkHoldDuration: Float = 50f,
    @SerialName("blink_open_duration") val blinkOpenDuration: Float = 100f,
)

@Serializable
data class AnimationNode(
    val id: String,
    val name: String,
    val type: String = "pose",
    @SerialName("pose_config") val poseConfig: PoseConfig? = null,
    @SerialName("animation_settings") val animationSettings: AnimationSettings? = null,
    val position: NodePosition = NodePosition(),
)

@Serializable
data class NodePosition(val x: Float = 0f, val y: Float = 0f)

@Serializable
data class EdgeTransition(
    val conditions: List<TransitionCondition> = emptyList(),
    @SerialName("video_urls") val videoUrls: List<String>? = null,
    @SerialName("playback_rate") val playbackRate: Float? = null,
)

@Serializable
data class AnimationEdge(
    val id: String,
    @SerialName("from_node_id") val fromNodeId: String,
    @SerialName("to_node_id") val toNodeId: String,
    val transitions: List<EdgeTransition> = emptyList(),
)

@Serializable
data class PoseTree(
    @SerialName("default_pose_ids") val defaultPoseIds: List<String> = emptyList(),
    val nodes: List<AnimationNode> = emptyList(),
    val edges: List<AnimationEdge> = emptyList(),
)

@Serializable
data class CharacterConfig(
    @SerialName("agent_id") val agentId: Int,
    @SerialName("pose_tree") val poseTree: PoseTree,
)
