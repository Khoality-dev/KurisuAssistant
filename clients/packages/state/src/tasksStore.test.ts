import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AssistantTask, TaskApproval } from '@kurisu/models';

/**
 * The Tasks screen (#352): tasks grouped by what they are doing, a filter over
 * the groups, the next run said the way a person would, and a list that keeps
 * up when the server says tasks changed — a run starting on its own is the
 * whole point of a task, so the screen cannot wait to be reopened.
 */

const handlers: Record<string, (event: unknown) => void> = {};
let serverTasks: AssistantTask[] = [];
let serverApprovals: TaskApproval[] = [];

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: {
    listTasks: vi.fn(async () => serverTasks),
    listTaskApprovals: vi.fn(async () => serverApprovals),
    answerTaskApproval: vi.fn(async (id: number) => {
      serverApprovals = serverApprovals.filter((a) => a.id !== id);
      return {};
    }),
    getTask: vi.fn(async (id: number) => ({ ...serverTasks.find((t) => t.id === id)!, runs: [] })),
    updateTask: vi.fn(async (id: number, data: { paused?: boolean }) => {
      const task = serverTasks.find((t) => t.id === id)!;
      return { ...task, status: data.paused ? 'paused' : 'scheduled', runs: [] };
    }),
    stopTask: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined),
  },
  wsManager: {
    on: vi.fn((type: string, handler: (event: unknown) => void) => { handlers[type] = handler; }),
    off: vi.fn(),
  },
}));

import { apiClient } from '@kurisu/api';
import { TASK_FILTERS, formatNextRun, groupTasks, useTasksStore } from './tasksStore';

function task(id: number, status: AssistantTask['status'], title = `task ${id}`): AssistantTask {
  return {
    id, title, instructions: 'do it', status, repeat: 'daily', timezone: 'UTC', run_at: null,
    time: '08:00', days: [], every_hours: null, schedule_label: 'Every day at 08:00',
    next_run_at: null, last_run_at: null, planned_in_conversation_id: null,
    created_at: null, updated_at: null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('groupTasks', () => {
  const tasks = [
    task(1, 'paused'), task(2, 'running'), task(3, 'scheduled'), task(4, 'finished'),
    task(5, 'scheduled'), task(6, 'waiting_for_approval'),
  ];

  it('groups waiting, running, scheduled, paused, in that order, leaving out empty groups', () => {
    const groups = groupTasks(tasks, 'all');
    expect(groups.map((g) => g.status)).toEqual(['waiting_for_approval', 'running', 'scheduled', 'paused']);
    expect(groups[2].tasks.map((t) => t.id)).toEqual([3, 5]);
    expect(groupTasks([task(1, 'paused')], 'all').map((g) => g.status)).toEqual(['paused']);
  });

  it('a finished one-off is not on the Tasks tab at all', () => {
    expect(groupTasks(tasks, 'all').flatMap((g) => g.tasks).map((t) => t.id)).not.toContain(4);
    expect(TASK_FILTERS.map((f) => f.id)).not.toContain('finished');
  });

  it('a filter keeps one group', () => {
    expect(groupTasks(tasks, 'scheduled').map((g) => g.status)).toEqual(['scheduled']);
  });

  it('labels each group with a name, not an instruction', () => {
    expect(groupTasks(tasks, 'all').map((g) => g.label)).toEqual(['Waiting for approval', 'Running', 'Scheduled', 'Paused']);
  });
});

describe('formatNextRun', () => {
  // Tuesday 13 October 2026, 14:20 local.
  const now = new Date(2026, 9, 13, 14, 20);

  it('names today and tomorrow, then the weekday, then the date', () => {
    expect(formatNextRun(new Date(2026, 9, 13, 18, 0).toISOString(), now)).toBe('today 18:00');
    expect(formatNextRun(new Date(2026, 9, 14, 7, 30).toISOString(), now)).toBe('tomorrow 07:30');
    expect(formatNextRun(new Date(2026, 9, 16, 19, 0).toISOString(), now)).toBe('Fri 19:00');
    expect(formatNextRun(new Date(2026, 11, 4, 9, 0).toISOString(), now)).toBe('Fri 4 Dec, 09:00');
  });

  it('a time already past reads as due now', () => {
    expect(formatNextRun(new Date(2026, 9, 13, 14, 0).toISOString(), now)).toBe('due now');
  });

  it('no next run is an empty string', () => {
    expect(formatNextRun(null, now)).toBe('');
  });
});

describe('useTasksStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverTasks = [task(1, 'scheduled'), task(2, 'paused')];
    serverApprovals = [];
    useTasksStore.setState({ tasks: [], approvals: [], selectedTaskId: null, selectedTask: null, filter: 'all' });
  });

  const approval = (id: number, taskId: number, conversationId: number): TaskApproval => ({
    id, run_id: 100 + id, task_id: taskId, task_title: `task ${taskId}`, conversation_id: conversationId,
    tool_name: 'drive_write', tool_args: { path: '/a.md' }, description: 'Write /a.md', status: 'pending',
    requested_at: '2026-10-13T10:00:00Z', expires_at: '2026-10-14T10:00:00Z',
  });

  it('loads the approvals runs are waiting on, and finds the one for a conversation', async () => {
    serverApprovals = [approval(7, 1, 40)];
    await useTasksStore.getState().loadTasks();
    expect(useTasksStore.getState().approvals.map((a) => a.id)).toEqual([7]);
    expect(useTasksStore.getState().approvalForConversation(40)?.id).toBe(7);
    expect(useTasksStore.getState().approvalForConversation(41)).toBeNull();
  });

  it('answering an approval sends it and refetches', async () => {
    serverApprovals = [approval(7, 1, 40)];
    await useTasksStore.getState().loadTasks();
    await useTasksStore.getState().answerApproval(7, true);
    expect(apiClient.answerTaskApproval).toHaveBeenCalledWith(7, true, undefined);
    expect(useTasksStore.getState().approvals).toEqual([]);
  });

  it('loads the tasks and opens one with its runs', async () => {
    await useTasksStore.getState().loadTasks();
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual([1, 2]);

    await useTasksStore.getState().selectTask(2);
    expect(useTasksStore.getState().selectedTask?.id).toBe(2);
    expect(apiClient.getTask).toHaveBeenCalledWith(2);
  });

  it('pausing updates the task in the list and in the open pane', async () => {
    await useTasksStore.getState().loadTasks();
    await useTasksStore.getState().selectTask(1);
    await useTasksStore.getState().setPaused(1, true);
    expect(apiClient.updateTask).toHaveBeenCalledWith(1, { paused: true });
    expect(useTasksStore.getState().tasks.find((t) => t.id === 1)?.status).toBe('paused');
    expect(useTasksStore.getState().selectedTask?.status).toBe('paused');
  });

  it('deleting removes the task and closes its pane', async () => {
    await useTasksStore.getState().loadTasks();
    await useTasksStore.getState().selectTask(1);
    await useTasksStore.getState().deleteTask(1);
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual([2]);
    expect(useTasksStore.getState().selectedTaskId).toBeNull();
  });

  it('refetches when the server says tasks changed, the open task too', async () => {
    useTasksStore.getState().listenForChanges();
    await useTasksStore.getState().loadTasks();
    await useTasksStore.getState().selectTask(1);
    vi.clearAllMocks();

    serverTasks = [task(1, 'running'), task(2, 'paused'), task(3, 'scheduled')];
    handlers.tasks_changed({ type: 'tasks_changed', task_id: 1 });
    await flush();
    await flush();

    expect(apiClient.listTasks).toHaveBeenCalled();
    expect(apiClient.getTask).toHaveBeenCalledWith(1);
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(useTasksStore.getState().selectedTask?.status).toBe('running');
  });
});
