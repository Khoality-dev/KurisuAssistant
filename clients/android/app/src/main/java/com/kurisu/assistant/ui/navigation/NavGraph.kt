package com.kurisu.assistant.ui.navigation

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.kurisu.assistant.ui.auth.LoginScreen
import com.kurisu.assistant.ui.character.CharacterScreen
import com.kurisu.assistant.ui.chat.ChatScreen
import com.kurisu.assistant.ui.home.HomeScreen
import com.kurisu.assistant.ui.agents.AgentsScreen
import com.kurisu.assistant.ui.settings.SettingsScreen
import com.kurisu.assistant.ui.tools.ToolsScreen

object Routes {
    const val SPLASH = "splash"
    const val LOGIN = "login"
    const val HOME = "home"
    const val CHAT = "chat/{agentId}"
    const val SETTINGS = "settings"
    const val TOOLS = "tools"
    const val AGENTS = "agents"
    const val CHARACTER = "character/{agentId}"

    fun character(agentId: Int): String = "character/$agentId"

    fun chat(agentId: Int, triggerText: String? = null): String {
        val base = "chat/$agentId"
        return if (triggerText != null) {
            "$base?triggerText=${Uri.encode(triggerText)}"
        } else {
            base
        }
    }
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
                    navController.navigate(Routes.HOME) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.HOME) {
            HomeScreen(
                onAgentClick = { agentId ->
                    navController.navigate(Routes.chat(agentId))
                },
                onTriggerMatch = { agentId, text ->
                    navController.navigate(Routes.chat(agentId, text))
                },
                onNavigateToSettings = {
                    navController.navigate(Routes.SETTINGS)
                },
                onNavigateToTools = {
                    navController.navigate(Routes.TOOLS)
                },
                onNavigateToAgents = {
                    navController.navigate(Routes.AGENTS)
                },
                onNavigateToCharacter = { agentId ->
                    navController.navigate(Routes.character(agentId))
                },
            )
        }

        composable(
            route = "chat/{agentId}?triggerText={triggerText}",
            arguments = listOf(
                navArgument("agentId") { type = NavType.IntType },
                navArgument("triggerText") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) {
            ChatScreen(
                onBack = { navController.popBackStack() },
                onNavigateToSettings = { navController.navigate(Routes.SETTINGS) },
                onNavigateToCharacter = { agentId ->
                    navController.navigate(Routes.character(agentId))
                },
            )
        }

        composable(Routes.TOOLS) {
            ToolsScreen(
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.AGENTS) {
            AgentsScreen(
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onLogout = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(
            route = "character/{agentId}",
            arguments = listOf(
                navArgument("agentId") { type = NavType.IntType },
            ),
        ) {
            CharacterScreen(
                onBack = { navController.popBackStack() },
            )
        }
    }
}
