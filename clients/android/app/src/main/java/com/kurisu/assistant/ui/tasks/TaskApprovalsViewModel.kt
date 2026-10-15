package com.kurisu.assistant.ui.tasks

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.TaskApproval
import com.kurisu.assistant.data.model.TasksChangedEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.TaskRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The calls task runs wait on the user to approve (#352), for the chat: a run's
 * conversation has no live turn behind it, so its approval is found and
 * answered over REST, in the same sheet a chat turn's approval uses. Follows
 * `tasks_changed`, so an approval appears and leaves without a reload.
 */
@HiltViewModel
class TaskApprovalsViewModel @Inject constructor(
    private val taskRepository: TaskRepository,
    private val wsManager: WebSocketManager,
) : ViewModel() {

    private val _approvals = MutableStateFlow<List<TaskApproval>>(emptyList())
    val approvals: StateFlow<List<TaskApproval>> = _approvals

    init {
        viewModelScope.launch { refresh() }
        viewModelScope.launch {
            wsManager.events.collect { event -> if (event is TasksChangedEvent) refresh() }
        }
    }

    private suspend fun refresh() {
        runCatching { taskRepository.listApprovals() }
            .onSuccess { _approvals.value = it }
            .onFailure { Log.w("TaskApprovals", "Could not load task approvals", it) }
    }

    /** The call [conversationId] waits on, if it is a task run's that waits. */
    fun forConversation(conversationId: Int?): TaskApproval? =
        conversationId?.let { id -> _approvals.value.firstOrNull { it.conversationId == id } }

    fun answer(approvalId: Int, approved: Boolean) {
        _approvals.value = _approvals.value.filterNot { it.id == approvalId }
        viewModelScope.launch {
            runCatching { taskRepository.answerApproval(approvalId, approved) }
                .onFailure { Log.w("TaskApprovals", "Could not answer approval $approvalId", it) }
            refresh()
        }
    }
}
