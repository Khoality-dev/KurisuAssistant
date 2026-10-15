package com.kurisu.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.kurisu.assistant.data.repository.NotificationRepository
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.service.NotificationNavigation
import com.kurisu.assistant.service.ForegroundNotifications
import com.kurisu.assistant.service.NotificationDelivery
import com.kurisu.assistant.service.NotificationTargetIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.remote.api.ProtocolMismatchSignal
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.data.repository.VersionCheck
import com.kurisu.assistant.data.repository.VersionRepository
import com.kurisu.assistant.ui.navigation.KurisuNavGraph
import com.kurisu.assistant.ui.navigation.Routes
import com.kurisu.assistant.ui.theme.KurisuTheme
import com.kurisu.assistant.ui.update.installApk
import com.kurisu.assistant.ui.version.UpdateFlow
import com.kurisu.assistant.ui.version.UpdateFlowState
import com.kurisu.assistant.ui.version.UpdateRequiredScreen
import com.kurisu.assistant.ui.version.VersionCheckPlaceholder
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var authRepository: AuthRepository
    @Inject lateinit var prefs: PreferencesDataStore
    @Inject lateinit var dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor
    @Inject lateinit var versionRepository: VersionRepository
    @Inject lateinit var updateRepository: UpdateRepository
    @Inject lateinit var protocolMismatchSignal: ProtocolMismatchSignal
    @Inject lateinit var notificationNavigation: NotificationNavigation
    @Inject lateinit var notificationDelivery: NotificationDelivery
    @Inject lateinit var foregroundNotifications: ForegroundNotifications
    @Inject lateinit var coreState: CoreState
    @Inject lateinit var notificationRepository: NotificationRepository

    /** A tapped notification: read it on the server, and go where it points (#353). */
    private fun openTappedNotification(intent: Intent?) {
        val target = NotificationTargetIntent.read(intent) ?: return
        NotificationTargetIntent.notificationId(intent)?.let { id ->
            lifecycleScope.launch { notificationRepository.markRead(id) }
        }
        notificationNavigation.open(target)
    }

    /** Android 13+ asks before an app may post notifications (#353). */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Register for push and listen while signed in, if this phone has notifications on (#353). */
    private fun startNotifications() {
        lifecycleScope.launch {
            if (!prefs.getNotificationsEnabled()) return@launch
            notificationDelivery.start()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    // The socket path while the app is in front (#353); closed, Firebase pushes.
    override fun onStart() {
        super.onStart()
        foregroundNotifications.onAppStarted()
    }

    override fun onStop() {
        foregroundNotifications.onAppStopped()
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openTappedNotification(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) openTappedNotification(intent)

        setContent {
            val themeMode by prefs.themeModeFlow().collectAsState(initial = "system")

            KurisuTheme(themeMode = themeMode) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    var versionCheck by remember { mutableStateOf<VersionCheck?>(null) }
                    var startDestination by remember { mutableStateOf<String?>(null) }
                    // "Change server" on the update gate (#150): the mismatch stands,
                    // but the user has asked for the login form to correct the URL.
                    var gateDismissed by remember { mutableStateOf(false) }
                    val scope = rememberCoroutineScope()

                    LaunchedEffect(Unit) {
                        val url = prefs.getBackendUrl()
                        dynamicBaseUrlInterceptor.setCachedBaseUrl(url)

                        versionCheck = versionRepository.check()

                        // Compatible OR Unreachable → proceed (offline launches must still work).
                        // Only Mismatch is a hard gate.
                        if (versionCheck !is VersionCheck.Mismatch) {
                            startDestination = try {
                                val user = authRepository.initializeAuth()
                                if (user != null) startNotifications()
                                if (user != null) Routes.CONVERSATIONS else Routes.LOGIN
                            } catch (_: Exception) {
                                Routes.LOGIN
                            }
                        }
                    }

                    // A 426 or a 4426 close mid-session: the server changed protocol
                    // under a signed-in client. Same gate as the startup check (#150).
                    val liveMismatch by protocolMismatchSignal.mismatch.collectAsState()
                    LaunchedEffect(liveMismatch) {
                        val info = liveMismatch ?: return@LaunchedEffect
                        versionCheck = VersionCheck.Mismatch(info)
                        gateDismissed = false
                    }

                    // The gate's own update flow (#264): every step lands in a state
                    // the screen renders, and a failure is a sentence, not a swallowed
                    // exception.
                    var updateFlow by remember { mutableStateOf<UpdateFlowState>(UpdateFlowState.Idle) }

                    val check = versionCheck
                    when {
                        check is VersionCheck.Mismatch && !gateDismissed -> UpdateRequiredScreen(
                            info = check.info,
                            flow = updateFlow,
                            onUpdate = {
                                scope.launch {
                                    updateFlow = UpdateFlowState.Checking
                                    val release = try {
                                        updateRepository.checkForUpdate()
                                    } catch (e: Exception) {
                                        updateFlow = UpdateFlow.failed("check for updates", e)
                                        return@launch
                                    }
                                    val asset = release?.assets?.firstOrNull { it.name.endsWith(".apk") }
                                    if (release == null || asset == null) {
                                        updateFlow = UpdateFlowState.None
                                        return@launch
                                    }
                                    updateFlow = UpdateFlowState.Downloading(release.tagName, 0f)
                                    try {
                                        val file = updateRepository.downloadApk(asset.browserDownloadUrl) { progress ->
                                            updateFlow = UpdateFlowState.Downloading(release.tagName, progress)
                                        }
                                        updateFlow = UpdateFlowState.Ready(release.tagName, file)
                                    } catch (e: Exception) {
                                        updateFlow = UpdateFlow.failed("download the update", e)
                                    }
                                }
                            },
                            onInstall = {
                                (updateFlow as? UpdateFlowState.Ready)?.let { installApk(this@MainActivity, it.file) }
                            },
                            onChangeServer = {
                                scope.launch {
                                    // The session belongs to the server that was just
                                    // refused; drop it so the login form starts clean.
                                    // LoginViewModel prefills the URL from prefs and
                                    // re-caches it in DynamicBaseUrlInterceptor on submit.
                                    authRepository.logout()
                                    protocolMismatchSignal.clear()
                                    startDestination = Routes.LOGIN
                                    gateDismissed = true
                                }
                            },
                        )
                        else -> {
                            val dest = startDestination
                            if (dest == null) {
                                VersionCheckPlaceholder()
                            } else {
                                val navController = rememberNavController()
                                val pendingTarget by notificationNavigation.pending.collectAsState()
                                KurisuNavGraph(
                                    navController = navController,
                                    startDestination = dest,
                                    onSignedIn = ::startNotifications,
                                    onSignedOut = notificationDelivery::stop,
                                    notificationTarget = pendingTarget,
                                    onOpenConversation = { coreState.setConversationId(it) },
                                    onNotificationTargetHandled = notificationNavigation::handled,
                                    onOpenNotificationTarget = notificationNavigation::open,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
