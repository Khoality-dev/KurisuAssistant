package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.ApprovalAnswer
import com.kurisu.assistant.data.model.AssistantTask
import com.kurisu.assistant.data.model.TaskApproval
import com.kurisu.assistant.data.model.TaskUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Tasks (#352): what the assistant does on its own. The assistant plans them;
 * this lists them, opens one with its runs, and changes, pauses, stops or
 * deletes it.
 */
@Singleton
class TaskRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun listTasks(): List<AssistantTask> = api.listTasks()

    /** One task with its ten newest runs. */
    suspend fun getTask(id: Int): AssistantTask = api.getTask(id)

    suspend fun updateTask(id: Int, update: TaskUpdate): AssistantTask = api.updateTask(id, update)

    suspend fun setPaused(id: Int, paused: Boolean): AssistantTask =
        api.updateTask(id, TaskUpdate(paused = paused))

    /** Stop the run going now. An HTTP 409 means nothing was running. */
    suspend fun stopTask(id: Int) {
        api.stopTask(id)
    }

    suspend fun deleteTask(id: Int) {
        api.deleteTask(id)
    }

    /** Tool calls the account's task runs wait on it to approve (#352). */
    suspend fun listApprovals(): List<TaskApproval> = api.listTaskApprovals()

    /** Approve or deny a waiting call; the run carries on. An HTTP 409: it no longer waits. */
    suspend fun answerApproval(id: Int, approved: Boolean) {
        api.answerTaskApproval(id, ApprovalAnswer(approved = approved))
    }
}
