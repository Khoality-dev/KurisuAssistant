import { describe, expect, it } from 'vitest';
import { parseTaskToolResult } from './taskResult';

/**
 * A task tool's result is JSON the chat turns into a card (#352). Anything that
 * is not one — another tool, an error, a truncated stream — stays an ordinary
 * tool bubble, so the parser must say no rather than guess.
 */

const task = { id: 7, title: 'Morning briefing', status: 'scheduled', schedule_label: 'Weekdays at 07:30' };

describe('parseTaskToolResult', () => {
  it('reads a task tool result', () => {
    const result = parseTaskToolResult('task_schedule', JSON.stringify({ action: 'scheduled', task }));
    expect(result?.action).toBe('scheduled');
    expect(result?.task.title).toBe('Morning briefing');
  });

  it('is null for another tool, even with the same shape', () => {
    expect(parseTaskToolResult('history_list', JSON.stringify({ action: 'scheduled', task }))).toBeNull();
  });

  it('is null for an error, a list, or text that is not JSON', () => {
    expect(parseTaskToolResult('task_schedule', JSON.stringify({ error: 'bad time' }))).toBeNull();
    expect(parseTaskToolResult('task_list', JSON.stringify({ tasks: [task] }))).toBeNull();
    expect(parseTaskToolResult('task_start', '{"action": "sta')).toBeNull();
    expect(parseTaskToolResult(null, JSON.stringify({ action: 'started', task }))).toBeNull();
  });
});
