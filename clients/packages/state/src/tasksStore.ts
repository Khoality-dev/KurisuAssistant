import { create } from 'zustand';
import { apiClient, wsManager } from '@kurisu/api';
import type { AssistantTask, TaskApproval, TaskStatus, TaskUpdate } from '@kurisu/models';

/**
 * The Tasks screen (#352): work the assistant does on its own, now or on a
 * schedule. The assistant plans tasks; this lists them, opens one with its
 * recent runs, and changes, pauses, stops or deletes them.
 *
 * A run starts and ends with nobody watching, so the list cannot wait to be
 * reopened: `listenForChanges` refetches on the server's `tasks_changed`, the
 * open task included.
 */

export type TaskFilter = 'all' | TaskStatus;

export interface TaskGroup {
  status: TaskStatus;
  /** The group's name as the screen shows it. */
  label: string;
  tasks: AssistantTask[];
}

// A finished one-off is not here: the server leaves it out of `GET /tasks`, and
// its run stays a conversation (#352).
const GROUP_ORDER: Array<{ status: TaskStatus; label: string }> = [
  { status: 'waiting_for_approval', label: 'Waiting for approval' },
  { status: 'running', label: 'Running' },
  { status: 'scheduled', label: 'Scheduled' },
  { status: 'paused', label: 'Paused' },
];

/** Tasks in screen order, one group per status that has any, kept by `filter`. */
export function groupTasks(tasks: AssistantTask[], filter: TaskFilter): TaskGroup[] {
  return GROUP_ORDER
    .filter((g) => filter === 'all' || g.status === filter)
    .map((g) => ({ ...g, tasks: tasks.filter((t) => t.status === g.status) }))
    .filter((g) => g.tasks.length > 0);
}

export const TASK_FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: 'all', label: 'All' },
  ...GROUP_ORDER.map((g) => ({ id: g.status as TaskFilter, label: g.label })),
];

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a task next runs, said as a person would, in local time: "today 18:00",
 * "tomorrow 07:30", "Fri 19:00" within the week, "Fri 4 Dec, 09:00" beyond it.
 */
export function formatNextRun(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (at.getTime() <= now.getTime()) return 'due now';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${time}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${time}`;
}

/** When something happened, for a run row: "Today, 07:30", "Mon 12 Oct, 07:30". */
export function formatRunTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${time}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${time}`;
}

interface TasksState {
  tasks: AssistantTask[];
  /** Tool calls runs wait on the user to approve. */
  approvals: TaskApproval[];
  filter: TaskFilter;
  selectedTaskId: number | null;
  /** The open task, with its runs. */
  selectedTask: AssistantTask | null;
  loading: boolean;
  error: string | null;
  loadTasks: () => Promise<void>;
  setFilter: (filter: TaskFilter) => void;
  selectTask: (id: number | null) => Promise<void>;
  updateTask: (id: number, data: TaskUpdate) => Promise<void>;
  setPaused: (id: number, paused: boolean) => Promise<void>;
  stopTask: (id: number) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;
  /** The approval a run's conversation waits on, if any. */
  approvalForConversation: (conversationId: number | null | undefined) => TaskApproval | null;
  /** Answer a waiting call; the run carries on with it. */
  answerApproval: (id: number, approved: boolean, modifiedArgs?: Record<string, unknown>) => Promise<void>;
  /** Refetch on `tasks_changed`. Idempotent; returns the unsubscribe. */
  listenForChanges: () => () => void;
}

function describeFailure(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  return 'Could not reach the server. Try again.';
}

let listening: (() => void) | null = null;

export const useTasksStore = create<TasksState>((set, get) => {
  const replace = (task: AssistantTask) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === task.id ? { ...task, runs: undefined } : t)),
      selectedTask: s.selectedTaskId === task.id ? task : s.selectedTask,
    }));
  };

  return {
    tasks: [],
    approvals: [],
    filter: 'all',
    selectedTaskId: null,
    selectedTask: null,
    loading: false,
    error: null,

    loadTasks: async () => {
      set({ loading: true });
      try {
        const [tasks, approvals] = await Promise.all([
          apiClient.listTasks(),
          apiClient.listTaskApprovals().catch(() => get().approvals),
        ]);
        set((s) => ({
          tasks,
          approvals,
          loading: false,
          error: null,
          // A task deleted elsewhere closes its pane here too.
          ...(s.selectedTaskId !== null && !tasks.some((t) => t.id === s.selectedTaskId)
            ? { selectedTaskId: null, selectedTask: null }
            : {}),
        }));
      } catch (error) {
        set({ loading: false, error: describeFailure(error) });
      }
    },

    setFilter: (filter) => set({ filter }),

    approvalForConversation: (conversationId) => {
      if (conversationId === null || conversationId === undefined) return null;
      return get().approvals.find((a) => a.conversation_id === conversationId) ?? null;
    },

    answerApproval: async (id, approved, modifiedArgs) => {
      try {
        await apiClient.answerTaskApproval(id, approved, modifiedArgs);
        set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id), error: null }));
      } catch (error) {
        set({ error: describeFailure(error) });
      }
      await get().loadTasks();
      const open = get().selectedTaskId;
      if (open !== null) await get().selectTask(open);
    },

    selectTask: async (id) => {
      set({ selectedTaskId: id, selectedTask: id === null ? null : get().tasks.find((t) => t.id === id) ?? null });
      if (id === null) return;
      try {
        const task = await apiClient.getTask(id);
        if (get().selectedTaskId === id) set({ selectedTask: task });
      } catch (error) {
        set({ error: describeFailure(error) });
      }
    },

    updateTask: async (id, data) => {
      try {
        replace(await apiClient.updateTask(id, data));
        set({ error: null });
      } catch (error) {
        set({ error: describeFailure(error) });
        throw error;
      }
    },

    setPaused: async (id, paused) => {
      await get().updateTask(id, { paused });
    },

    stopTask: async (id) => {
      try {
        await apiClient.stopTask(id);
        set({ error: null });
      } catch (error) {
        set({ error: describeFailure(error) });
      }
      await get().loadTasks();
      if (get().selectedTaskId === id) await get().selectTask(id);
    },

    deleteTask: async (id) => {
      try {
        await apiClient.deleteTask(id);
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id),
          ...(s.selectedTaskId === id ? { selectedTaskId: null, selectedTask: null } : {}),
          error: null,
        }));
      } catch (error) {
        set({ error: describeFailure(error) });
      }
    },

    listenForChanges: () => {
      if (!listening) {
        const onChanged = () => {
          const { selectedTaskId } = get();
          void get().loadTasks().then(async () => {
            if (selectedTaskId !== null && get().selectedTaskId === selectedTaskId) {
              try {
                const task = await apiClient.getTask(selectedTaskId);
                if (get().selectedTaskId === selectedTaskId) set({ selectedTask: task });
              } catch {
                // Deleted meanwhile: loadTasks has already closed the pane.
              }
            }
          });
        };
        wsManager.on('tasks_changed', onChanged as never);
        listening = () => {
          wsManager.off('tasks_changed', onChanged as never);
          listening = null;
        };
      }
      return listening;
    },
  };
});
