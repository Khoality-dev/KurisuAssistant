package com.kurisu.assistant.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.kurisu.assistant.ui.about.AboutScreen
import com.kurisu.assistant.ui.assistant.AssistantScreen
import com.kurisu.assistant.ui.auth.LoginScreen
import com.kurisu.assistant.ui.chat.ChatScreen
import com.kurisu.assistant.ui.conversations.ConversationsScreen
import com.kurisu.assistant.ui.faces.FaceIdentitiesScreen
import com.kurisu.assistant.ui.personas.PersonasScreen
import com.kurisu.assistant.ui.settings.AccountScreen
import com.kurisu.assistant.ui.settings.AppearanceScreen
import com.kurisu.assistant.ui.settings.SettingsScreen
import com.kurisu.assistant.ui.settings.SkillsScreen
import com.kurisu.assistant.ui.settings.ToolsMcpScreen
import com.kurisu.assistant.ui.settings.TtsAsrScreen

object Routes {
    const val LOGIN = "login"

    /** The app's home: the list of conversations. */
    const val CONVERSATIONS = "conversations"
    const val CHAT = "chat"

    /** The one assistant: model, provider, tools, memory, wake word, sub-agents. */
    const val ASSISTANT = "assistant"

    /** The many personas: name, prompt, voice, avatar, character. */
    const val PERSONAS = "personas"

    const val TOOLS_MCP = "tools_mcp"
    const val SKILLS = "skills"

    /** Grouped rows; every leaf below is reached from here. */
    const val SETTINGS = "settings"
    const val ACCOUNT = "account"
    const val TTS_ASR = "tts_asr"
    const val APPEARANCE = "appearance"
    const val FACES = "faces"
    const val ABOUT = "about"
}

@Composable
fun KurisuNavGraph(
    navController: NavHostController,
    startDestination: String,
) {
    // Drawer destinations sit directly above Chats rather than stacking: picking
    // Personas from Skills must not leave Skills on the back stack for the
    // system back button to walk through.
    fun openTopLevel(route: String) {
        navController.navigate(route) {
            popUpTo(Routes.CONVERSATIONS) { inclusive = false }
            launchSingleTop = true
        }
    }

    fun logout() {
        navController.navigate(Routes.LOGIN) {
            popUpTo(0) { inclusive = true }
        }
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Routes.CONVERSATIONS) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.CONVERSATIONS) {
            AppDrawerHost(
                currentRoute = Routes.CONVERSATIONS,
                onNavigate = ::openTopLevel,
                onLoggedOut = ::logout,
            ) { openDrawer ->
                ConversationsScreen(
                    // The view model has already put the id on CoreState, so the
                    // chat only has to be shown; null is a brand-new chat and the
                    // backend binds the default persona on its first message.
                    onOpenChat = { navController.navigate(Routes.CHAT) },
                    onOpenMenu = openDrawer,
                )
            }
        }

        composable(Routes.CHAT) {
            AppDrawerHost(
                currentRoute = Routes.CONVERSATIONS,
                onNavigate = ::openTopLevel,
                onLoggedOut = ::logout,
            ) { openDrawer ->
                ChatScreen(
                    onOpenMenu = openDrawer,
                    onNavigateToPersonas = { navController.navigate(Routes.PERSONAS) },
                )
            }
        }

        composable(Routes.ASSISTANT) {
            AssistantScreen(
                onBack = { navController.popBackStack() },
                onNavigateToPersonas = { navController.navigate(Routes.PERSONAS) },
            )
        }
        composable(Routes.PERSONAS) {
            PersonasScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.TOOLS_MCP) {
            ToolsMcpScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.SKILLS) {
            SkillsScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onNavigateToAccount = { navController.navigate(Routes.ACCOUNT) },
                onNavigateToAppearance = { navController.navigate(Routes.APPEARANCE) },
                onNavigateToTtsAsr = { navController.navigate(Routes.TTS_ASR) },
                onNavigateToFaces = { navController.navigate(Routes.FACES) },
                onNavigateToAbout = { navController.navigate(Routes.ABOUT) },
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
        composable(Routes.FACES) {
            FaceIdentitiesScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.ABOUT) {
            AboutScreen(onBack = { navController.popBackStack() })
        }
    }
}
