package com.kurisu.assistant

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.ui.navigation.KurisuNavGraph
import com.kurisu.assistant.ui.navigation.Routes
import com.kurisu.assistant.ui.theme.KurisuTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var authRepository: AuthRepository
    @Inject lateinit var prefs: PreferencesDataStore
    @Inject lateinit var dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            KurisuTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    var startDestination by remember { mutableStateOf<String?>(null) }

                    LaunchedEffect(Unit) {
                        // Initialize base URL
                        val url = prefs.getBackendUrl()
                        dynamicBaseUrlInterceptor.setCachedBaseUrl(url)

                        // Validate stored token (with fallback to login on any failure)
                        startDestination = try {
                            val user = authRepository.initializeAuth()
                            if (user != null) Routes.HOME else Routes.LOGIN
                        } catch (_: Exception) {
                            Routes.LOGIN
                        }
                    }

                    val dest = startDestination
                    if (dest == null) {
                        // Splash / loading
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else {
                        val navController = rememberNavController()
                        KurisuNavGraph(navController = navController, startDestination = dest)
                    }
                }
            }
        }
    }
}
