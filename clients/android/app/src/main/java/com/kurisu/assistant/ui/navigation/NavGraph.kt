package com.kurisu.assistant.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.kurisu.assistant.ui.agents.AgentsScreen
import com.kurisu.assistant.ui.auth.LoginScreen
import com.kurisu.assistant.ui.chat.ChatScreen
import com.kurisu.assistant.ui.personas.PersonasScreen
import com.kurisu.assistant.ui.settings.AccountScreen
import com.kurisu.assistant.ui.settings.AppearanceScreen
import com.kurisu.assistant.ui.settings.SkillsScreen
import com.kurisu.assistant.ui.settings.ToolsMcpScreen
import com.kurisu.assistant.ui.settings.TtsAsrScreen

object Routes {
    const val LOGIN = "login"
    const val CHAT = "chat"
    const val ACCOUNT = "account"
    const val TTS_ASR = "tts_asr"
    const val APPEARANCE = "appearance"
    const val PERSONAS = "personas"
    const val AGENTS = "agents"
    const val TOOLS_MCP = "tools_mcp"
    const val SKILLS = "skills"
}

@Composable
fun KurisuNavGraph(
    navController: NavHostController,
    startDestination: String,
) {
    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Routes.CHAT) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.CHAT) {
            ChatScreen(
                onNavigateToAccount = { navController.navigate(Routes.ACCOUNT) },
                onNavigateToTtsAsr = { navController.navigate(Routes.TTS_ASR) },
                onNavigateToAppearance = { navController.navigate(Routes.APPEARANCE) },
                onNavigateToPersonas = { navController.navigate(Routes.PERSONAS) },
                onNavigateToAgents = { navController.navigate(Routes.AGENTS) },
                onNavigateToToolsMcp = { navController.navigate(Routes.TOOLS_MCP) },
                onNavigateToSkills = { navController.navigate(Routes.SKILLS) },
                onLogout = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.ACCOUNT) {
            AccountScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.TTS_ASR) {
            TtsAsrScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.APPEARANCE) {
            AppearanceScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.PERSONAS) {
            PersonasScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.AGENTS) {
            AgentsScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.TOOLS_MCP) {
            ToolsMcpScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.SKILLS) {
            SkillsScreen(onBack = { navController.popBackStack() })
        }
    }
}
