import type { TaskToolResult } from './types';

/** The six task tools (#352); every one but `task_list` answers with a task. */
export const TASK_TOOL_NAMES = [
  'task_start', 'task_schedule', 'task_list', 'task_update', 'task_stop', 'task_delete',
] as const;

const ACTIONS = new Set(['started', 'scheduled', 'updated', 'stopped', 'not_running', 'deleted']);

/**
 * A task tool's result as the chat's task card reads it, or null when the tool
 * message is anything else and should stay an ordinary tool bubble.
 */
export function parseTaskToolResult(toolName: string | null | undefined, content: string | null | undefined): TaskToolResult | null {
  if (!toolName || !(TASK_TOOL_NAMES as readonly string[]).includes(toolName) || !content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { action, task } = parsed as { action?: unknown; task?: unknown };
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (!task || typeof task !== 'object' || typeof (task as { id?: unknown }).id !== 'number') return null;
  return parsed as TaskToolResult;
}
