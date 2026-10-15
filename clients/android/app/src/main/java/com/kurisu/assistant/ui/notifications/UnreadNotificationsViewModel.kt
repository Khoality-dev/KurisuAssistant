package com.kurisu.assistant.ui.notifications

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.data.repository.NotificationRepository
import com.kurisu.assistant.domain.notifications.NotificationTarget
import com.kurisu.assistant.domain.notifications.notificationTarget
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The bell on the Chats screen and the unread list it opens (#353). Both are
 * the server's: the count and the list come from `GET /notifications`, fetched
 * when this opens and again whenever the socket says something arrived or was
 * read. Opening an item reads it — on every device — and says where it points.
 */
@HiltViewModel
class UnreadNotificationsViewModel @Inject constructor(
    private val repository: NotificationRepository,
) : ViewModel() {

    val unread: StateFlow<List<NotificationEvent>> = repository.unread
    val unreadCount: StateFlow<Int> = repository.unreadCount

    init {
        viewModelScope.launch { repository.refresh() }
    }

    /** Read it, and say where it points. */
    fun open(notification: NotificationEvent): NotificationTarget {
        viewModelScope.launch { repository.markRead(notification.id) }
        return notificationTarget(notification)
    }

    fun markAllRead() {
        viewModelScope.launch { repository.markAllRead() }
    }
}
