package com.kurisu.assistant.domain.character

import android.graphics.Bitmap
import com.kurisu.assistant.data.model.*
import kotlin.math.*
import kotlin.random.Random

enum class BlinkState { OPEN, CLOSING, CLOSED, OPENING }
enum class CompositorState { IDLE, TRANSITIONING }

data class LoadedPatch(
    val bitmap: Bitmap,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

data class ProcessedPose(
    val name: String,
    val baseImage: Bitmap,
    val leftEyePatches: List<LoadedPatch>,
    val rightEyePatches: List<LoadedPatch>,
    val mouthPatches: List<LoadedPatch>,
)

data class EdgeTimer(
    var elapsed: Float = 0f,
    val target: Float,
    var primed: Boolean = false,
)

/**
 * Character animation compositor. Manages blink, breathing, mouth, and pose transitions.
 * Call update(dt) and draw() each frame.
 */
class CharacterCompositor(
    private val imageCache: ImageCache,
) {
    // Current state
    var pose: ProcessedPose? = null
        private set
    private var poseTree: PoseTree? = null
    private val allPoses = mutableMapOf<String, ProcessedPose>()
    var currentNodeId: String? = null
        private set
    var compositorState: CompositorState = CompositorState.IDLE
        private set

    // Blink state machine
    private var blinkState = BlinkState.OPEN
    private var blinkTimer = 0f
    private var nextBlinkIn = 0f
    private var leftEyeIndex = 0
    private var rightEyeIndex = 0

    // Breathing
    private var breathingTimer = 0f
    var breathingEnabled = true
    var breathingAmplitude = 3f
    var breathingPeriod = 3500f

    // Blink timing
    var blinkMinInterval = 2000f
    var blinkMaxInterval = 6000f
    var blinkCloseDuration = 100f
    var blinkHoldDuration = 50f
    var blinkOpenDuration = 100f

    // External inputs
    var mouthAmplitude = 0f
    var isAudioPlaying = false
    var isThinking = false

    // Gestures and faces (external)
    private val activeGestures = mutableSetOf<String>()
    private val activeFaces = mutableSetOf<String>()

    // Edge timers
    private val edgeTimers = mutableMapOf<String, EdgeTimer>()

    // Crossfade
    var crossfadeProgress = 1f
        private set
    private val crossfadeDuration = 150f
    private var previousBitmap: Bitmap? = null

    // Transition video callback
    var onTransitionVideo: ((videoUrl: String, playbackRate: Float, onComplete: () -> Unit) -> Unit)? = null

    private var apiBaseUrl = ""

    init {
        scheduleNextBlink()
    }

    private fun scheduleNextBlink() {
        nextBlinkIn = blinkMinInterval + Random.nextFloat() * (blinkMaxInterval - blinkMinInterval)
        blinkTimer = 0f
    }

    fun update(dtMs: Float) {
        // Always tick crossfade
        if (crossfadeProgress < 1f) {
            crossfadeProgress = min(crossfadeProgress + dtMs / crossfadeDuration, 1f)
        }

        if (compositorState == CompositorState.IDLE) {
            updateBlink(dtMs)
            if (breathingEnabled) breathingTimer += dtMs
            updateEdgeTimers(dtMs)
        }
    }

    private fun updateBlink(dt: Float) {
        blinkTimer += dt
        val numEyePatches = pose?.leftEyePatches?.size ?: 0
        if (numEyePatches == 0) {
            leftEyeIndex = 0
            rightEyeIndex = 0
            return
        }

        when (blinkState) {
            BlinkState.OPEN -> {
                leftEyeIndex = 0
                rightEyeIndex = 0
                if (blinkTimer >= nextBlinkIn) {
                    blinkState = BlinkState.CLOSING
                    blinkTimer = 0f
                }
            }
            BlinkState.CLOSING -> {
                val progress = min(blinkTimer / blinkCloseDuration, 1f)
                val idx = min(round(progress * numEyePatches).toInt(), numEyePatches)
                leftEyeIndex = idx
                rightEyeIndex = idx
                if (blinkTimer >= blinkCloseDuration) {
                    blinkState = BlinkState.CLOSED
                    blinkTimer = 0f
                }
            }
            BlinkState.CLOSED -> {
                leftEyeIndex = numEyePatches
                rightEyeIndex = numEyePatches
                if (blinkTimer >= blinkHoldDuration) {
                    blinkState = BlinkState.OPENING
                    blinkTimer = 0f
                }
            }
            BlinkState.OPENING -> {
                val progress = min(blinkTimer / blinkOpenDuration, 1f)
                val idx = max(round((1f - progress) * numEyePatches).toInt(), 0)
                leftEyeIndex = idx
                rightEyeIndex = idx
                if (blinkTimer >= blinkOpenDuration) {
                    leftEyeIndex = 0
                    rightEyeIndex = 0
                    blinkState = BlinkState.OPEN
                    blinkTimer = 0f
                    scheduleNextBlink()
                }
            }
        }
    }

    private fun updateEdgeTimers(dt: Float) {
        if (poseTree == null || currentNodeId == null) return

        for (timer in edgeTimers.values) {
            timer.elapsed += dt
            if (timer.elapsed >= timer.target) timer.primed = true
        }

        evaluateTransitions()

        // Clear gestures after evaluation (gestures are instantaneous)
        activeGestures.clear()
    }

    private fun evaluateTransitions() {
        val tree = poseTree ?: return
        val nodeId = currentNodeId ?: return

        for (edge in tree.edges) {
            if (edge.fromNodeId != nodeId) continue
            for ((ti, transition) in edge.transitions.withIndex()) {
                if (allConditionsMet(edge, transition, ti)) {
                    startTransition(edge, transition)
                    return
                }
            }
        }
    }

    private fun allConditionsMet(edge: AnimationEdge, transition: EdgeTransition, ti: Int): Boolean {
        return transition.conditions.all { cond ->
            when (cond.type) {
                "random" -> edgeTimers["${edge.id}:$ti"]?.primed == true
                "thinking" -> cond.booleanValue == isThinking
                "gesture" -> activeGestures.contains(cond.stringValue)
                "face" -> if (cond.visible == true) activeFaces.contains(cond.stringValue) else !activeFaces.contains(cond.stringValue)
                else -> false
            }
        }
    }

    private fun startTransition(edge: AnimationEdge, transition: EdgeTransition) {
        val urls = transition.videoUrls
        val videoUrl = if (!urls.isNullOrEmpty()) urls.random() else null

        if (videoUrl != null && onTransitionVideo != null) {
            val resolved = if (videoUrl.startsWith("http")) videoUrl else "$apiBaseUrl$videoUrl"
            compositorState = CompositorState.TRANSITIONING
            onTransitionVideo?.invoke(resolved, transition.playbackRate ?: 1f) {
                switchToPose(edge.toNodeId)
            }
        } else {
            switchToPose(edge.toNodeId)
        }
    }

    private fun switchToPose(nodeId: String) {
        // Capture current frame for crossfade
        crossfadeProgress = 0f

        val newPose = allPoses[nodeId]
        if (newPose != null) {
            pose = newPose
            currentNodeId = nodeId
        }

        // Apply per-node animation settings
        val node = poseTree?.nodes?.find { it.id == nodeId }
        node?.animationSettings?.let { applySettings(it) }

        // Reset blink
        blinkState = BlinkState.OPEN
        leftEyeIndex = 0
        rightEyeIndex = 0
        scheduleNextBlink()

        // Reset edge timers
        initEdgeTimers()

        compositorState = CompositorState.IDLE
    }

    private fun initEdgeTimers() {
        edgeTimers.clear()
        val tree = poseTree ?: return
        val nodeId = currentNodeId ?: return

        for (edge in tree.edges) {
            if (edge.fromNodeId != nodeId) continue
            for ((ti, transition) in edge.transitions.withIndex()) {
                val randomCond = transition.conditions.firstOrNull { it.isRandom }
                if (randomCond != null) {
                    val target = randomCond.minIntervalMs +
                        Random.nextFloat() * (randomCond.maxIntervalMs - randomCond.minIntervalMs)
                    edgeTimers["${edge.id}:$ti"] = EdgeTimer(target = target.toFloat())
                }
            }
        }
    }

    fun applySettings(settings: AnimationSettings) {
        breathingEnabled = settings.breathingEnabled
        breathingAmplitude = settings.breathingAmplitude
        breathingPeriod = settings.breathingPeriod
        blinkMinInterval = settings.blinkMinInterval
        blinkMaxInterval = settings.blinkMaxInterval
        blinkCloseDuration = settings.blinkCloseDuration
        blinkHoldDuration = settings.blinkHoldDuration
        blinkOpenDuration = settings.blinkOpenDuration
    }

    fun setGestures(gestures: List<String>) {
        activeGestures.clear()
        activeGestures.addAll(gestures)
    }

    fun setFaces(faces: List<String>) {
        activeFaces.clear()
        activeFaces.addAll(faces)
    }

    /** Get breathing Y offset for current frame */
    fun getBreathingOffsetY(scaleY: Float): Float {
        if (!breathingEnabled || breathingPeriod <= 0f) return 0f
        val phase = (breathingTimer / breathingPeriod) * Math.PI.toFloat() * 2f
        return sin(phase) * breathingAmplitude * scaleY
    }

    /** Get current eye patch indices */
    fun getLeftEyeIndex(): Int = leftEyeIndex
    fun getRightEyeIndex(): Int = rightEyeIndex

    /** Get mouth state (0 = closed, up to numMouthPatches) */
    fun getMouthState(): Int {
        if (!isAudioPlaying) return 0
        val num = pose?.mouthPatches?.size ?: return 0
        if (num == 0) return 0
        return round(mouthAmplitude * num).toInt()
    }

    /** Load a full pose tree */
    suspend fun loadPoseTree(poseTree: PoseTree, apiBaseUrl: String) {
        this.apiBaseUrl = apiBaseUrl
        val migratedEdges = poseTree.edges.map { migrateEdgeToTransitions(it) }
        this.poseTree = poseTree.copy(edges = migratedEdges)
        allPoses.clear()
        edgeTimers.clear()

        // Load all pose images
        for (node in poseTree.nodes) {
            val pc = node.poseConfig ?: continue
            val processed = processPoseConfig(pc, apiBaseUrl)
            if (processed != null) {
                allPoses[node.id] = processed
            }
        }

        // Set current node to random default
        val defaults = poseTree.defaultPoseIds.ifEmpty { listOfNotNull(poseTree.nodes.firstOrNull()?.id) }
        val chosenDefault = defaults.random()
        currentNodeId = chosenDefault
        pose = allPoses[chosenDefault]

        // Apply default node's animation settings
        val defaultNode = poseTree.nodes.find { it.id == chosenDefault }
        defaultNode?.animationSettings?.let { applySettings(it) }

        // Reset blink
        blinkState = BlinkState.OPEN
        leftEyeIndex = 0
        rightEyeIndex = 0
        scheduleNextBlink()

        initEdgeTimers()
        compositorState = CompositorState.IDLE
    }

    private suspend fun processPoseConfig(config: PoseConfig, apiBaseUrl: String): ProcessedPose? {
        fun resolveUrl(url: String) = if (url.startsWith("http")) url else "$apiBaseUrl$url"

        val baseImage = imageCache.getImage(resolveUrl(config.baseImageUrl)) ?: return null

        val leftPatches = config.leftEye.patches.mapNotNull { p ->
            val bmp = imageCache.getImage(resolveUrl(p.imageUrl)) ?: return@mapNotNull null
            LoadedPatch(bmp, p.x, p.y, p.width, p.height)
        }

        val rightPatches = config.rightEye.patches.mapNotNull { p ->
            val bmp = imageCache.getImage(resolveUrl(p.imageUrl)) ?: return@mapNotNull null
            LoadedPatch(bmp, p.x, p.y, p.width, p.height)
        }

        val mouthPatches = config.mouth.patches.mapNotNull { p ->
            val bmp = imageCache.getImage(resolveUrl(p.imageUrl)) ?: return@mapNotNull null
            LoadedPatch(bmp, p.x, p.y, p.width, p.height)
        }

        return ProcessedPose(config.name, baseImage, leftPatches, rightPatches, mouthPatches)
    }

    fun clearPose() {
        pose = null
        poseTree = null
        allPoses.clear()
        currentNodeId = null
        edgeTimers.clear()
        compositorState = CompositorState.IDLE
    }
}
