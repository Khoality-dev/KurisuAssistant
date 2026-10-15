package com.kurisu.assistant.ui.navigation

import com.kurisu.assistant.ui.notifications.UnreadNotificationsScreen
import androidx.compose.runtime.LaunchedEffect
import com.kurisu.assistant.domain.notifications.NotificationTarget
import com.kurisu.assistant.ui.settings.NotificationsScreen
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.kurisu.assistant.ui.about.AboutScreen
import com.kurisu.assistant.ui.assistant.AssistantScreen
import com.kurisu.assistant.ui.auth.LoginScreen
import com.kurisu.assistant.ui.calendar.CalendarScreen
import com.kurisu.assistant.ui.calendar.LocalOpenCalendar
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
import com.kurisu.assistant.ui.tasks.TasksScreen

object Routes {
    const val LOGIN = "login"

    /** The app's home: the list of conversations. */
    const val CONVERSATIONS = "conversations"
    const val CHAT = "chat"

    /** The assistant's own work, now or on a schedule (#352). */
    const val TASKS = "tasks"

    /** Tasks with one open, from a task card in the chat. */
    fun task(id: Int) = "$TASKS?open=$id"

    /** The user's events and reminders (#282). Built in, not a plugin. */
    const val CALENDAR = "calendar"

    /** With an optional `reminderId`: open on that entry (a notification's tap, #353). */
    const val CALENDAR_PATTERN = "calendar?reminderId={reminderId}"

    fun calendar(reminderId: Int? = null): String =
        if (reminderId == null) CALENDAR else "calendar?reminderId=$reminderId"

    /** Where a tapped notification lands (#353); null leaves the app where it is. */
    fun forNotification(target: NotificationTarget): String? = when (target) {
        is NotificationTarget.Conversation -> CHAT
        is NotificationTarget.Calendar -> calendar(target.reminderId)
        NotificationTarget.App -> null
    }

    /** The one assistant: model, provider, tools, memory, wake word. */
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
    const val NOTIFICATIONS = "notifications"
    /** What is unread, opened from the bell on Chats (#353). */
    const val UNREAD = "unread"
}

@Composable
fun KurisuNavGraph(
    navController: NavHostController,
    startDestination: String,
    onSignedIn: () -> Unit = {},
    onSignedOut: () -> Unit = {},
    notificationTarget: NotificationTarget? = null,
    onOpenConversation: (Int) -> Unit = {},
    onNotificationTargetHandled: () -> Unit = {},
    onOpenNotificationTarget: (NotificationTarget) -> Unit = {},
) {
    // A tapped notification (#353): a conversation opens in the chat, a
    // reminder on the calendar at that entry (#282).
    LaunchedEffect(notificationTarget) {
        val target = notificationTarget ?: return@LaunchedEffect
        if (target is NotificationTarget.Conversation) onOpenConversation(target.conversationId)
        Routes.forNotification(target)?.let { route -> navController.navigate(route) { launchSingleTop = true } }
        onNotificationTargetHandled()
    }

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
        onSignedOut()
        navController.navigate(Routes.LOGIN) {
            popUpTo(0) { inclusive = true }
        }
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    onSignedIn()
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
                    // chat only has to be shown; null is a brand-new chat, which the
                    // backend answers as the persona in use, or as the assistant
                    // itself when there is none (#354).
                    onOpenChat = { navController.navigate(Routes.CHAT) },
                    onOpenMenu = openDrawer,
                    onOpenNotifications = { navController.navigate(Routes.UNREAD) },
                )
            }
        }

        composable(
            Routes.CALENDAR_PATTERN,
            arguments = listOf(navArgument("reminderId") { type = NavType.IntType; defaultValue = -1 }),
        ) { entry ->
            val reminderId = entry.arguments?.getInt("reminderId")?.takeIf { it > 0 }
            AppDrawerHost(
                currentRoute = Routes.CALENDAR,
                onNavigate = ::openTopLevel,
                onLoggedOut = ::logout,
            ) { openDrawer ->
                CalendarScreen(onOpenMenu = openDrawer, openReminderId = reminderId)
            }
        }

        composable(Routes.CHAT) {
            AppDrawerHost(
                currentRoute = Routes.CONVERSATIONS,
                onNavigate = ::openTopLevel,
                onLoggedOut = ::logout,
            ) { openDrawer ->
                // A calendar card in the chat opens the entry it is about (#282).
                CompositionLocalProvider(LocalOpenCalendar provides { id -> navController.navigate(Routes.calendar(id)) }) {
                ChatScreen(
                    onOpenMenu = openDrawer,
                    // Plain navigate, not openTopLevel: that one pops back to
                    // Conversations, and this has to come back to the chat.
                    onNavigateToPersonas = { navController.navigate(Routes.PERSONAS) },
                    onNavigateToAssistant = { navController.navigate(Routes.ASSISTANT) },
                    onNavigateToChats = { openTopLevel(Routes.CONVERSATIONS) },
                    onNavigateToTask = { id -> navController.navigate(Routes.task(id)) },
                )
                }
            }
        }

        composable(
            route = "${Routes.TASKS}?open={open}",
            arguments = listOf(navArgument("open") { type = NavType.IntType; defaultValue = -1 }),
        ) { entry ->
            AppDrawerHost(
                currentRoute = Routes.TASKS,
                onNavigate = ::openTopLevel,
                onLoggedOut = ::logout,
            ) { openDrawer ->
                TasksScreen(
                    onOpenMenu = openDrawer,
                    openTaskId = entry.arguments?.getInt("open")?.takeIf { it > 0 },
                    // A run's conversation is already on CoreState; show the chat.
                    onOpenChat = { navController.navigate(Routes.CHAT) },
                )
            }
        }

        composable(Routes.ASSISTANT) {
            AssistantScreen(onBack = { navController.popBackStack() })
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
                onNavigateToNotifications = { navController.navigate(Routes.NOTIFICATIONS) },
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
        composable(Routes.NOTIFICATIONS) {
            NotificationsScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.UNREAD) {
            UnreadNotificationsScreen(
                onBack = { navController.popBackStack() },
                onOpenTarget = onOpenNotificationTarget,
            )
        }
    }
}
