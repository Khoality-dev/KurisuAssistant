package com.kurisu.assistant

import android.os.Bundle
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

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

                    val check = versionCheck
                    when {
                        check is VersionCheck.Mismatch && !gateDismissed -> UpdateRequiredScreen(
                            info = check.info,
                            onCheckForUpdate = {
                                scope.launch {
                                    val release = updateRepository.checkForUpdate()
                                    if (release != null) {
                                        val asset = release.assets.firstOrNull { it.name.endsWith(".apk") }
                                        if (asset != null) {
                                            val file = updateRepository.downloadApk(asset.browserDownloadUrl) {}
                                            installApk(this@MainActivity, file)
                                        }
                                    }
                                }
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
                                KurisuNavGraph(navController = navController, startDestination = dest)
                            }
                        }
                    }
                }
            }
        }
    }
}
