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
                                if (user != null) Routes.CHAT else Routes.LOGIN
                            } catch (_: Exception) {
                                Routes.LOGIN
                            }
                        }
                    }

                    when (val check = versionCheck) {
                        is VersionCheck.Mismatch -> UpdateRequiredScreen(
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
