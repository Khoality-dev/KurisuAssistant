import React from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import {
  Autorenew as RunningIcon,
  Delete as DeletedIcon,
  Edit as UpdatedIcon,
  Schedule as ScheduledIcon,
  StopCircle as StopIcon,
  TaskAlt as TasksIcon,
} from '@mui/icons-material';
import type { TaskToolResult } from '@kurisu/models';
import { formatNextRun, useLayoutStore, useTasksStore } from '@kurisu/state';

/**
 * A task tool's result in the chat (#352): what the assistant just started or
 * scheduled, as a card rather than a collapsed tool call, with the way into the
 * Tasks screen. The task in the card is the one the tool answered with; the
 * Tasks screen holds its current state.
 */

const LOOKS: Record<TaskToolResult['action'], { heading: string; icon: React.ReactNode; bg: string; fg: string; border: string }> = {
  started: { heading: 'Running in the background', icon: <RunningIcon fontSize="small" />, bg: '#F0FDF4', fg: '#166534', border: '#DCFCE7' },
  scheduled: { heading: 'Task scheduled', icon: <ScheduledIcon fontSize="small" />, bg: '#EFF6FF', fg: '#1D4ED8', border: '#DBEAFE' },
  updated: { heading: 'Task changed', icon: <UpdatedIcon fontSize="small" />, bg: '#EFF6FF', fg: '#1D4ED8', border: '#DBEAFE' },
  stopped: { heading: 'Task stopped', icon: <StopIcon fontSize="small" />, bg: '#F5F5F5', fg: '#525252', border: '#E5E7EB' },
  not_running: { heading: 'Task not running', icon: <StopIcon fontSize="small" />, bg: '#F5F5F5', fg: '#525252', border: '#E5E7EB' },
  deleted: { heading: 'Task deleted', icon: <DeletedIcon fontSize="small" />, bg: '#F5F5F5', fg: '#525252', border: '#E5E7EB' },
};

export const TaskResultCard: React.FC<{ result: TaskToolResult }> = ({ result }) => {
  const { task, action } = result;
  const look = LOOKS[action];
  const setActivePage = useLayoutStore((s) => s.setActivePage);
  const { selectTask, stopTask } = useTasksStore();
  const live = useTasksStore((s) => s.tasks.find((t) => t.id === task.id));
  const running = (live ?? task).status === 'running';

  const openInTasks = () => {
    setActivePage('tasks');
    void selectTask(task.id);
  };

  const details: string[] = [];
  if (action === 'started') details.push('Keeps going if you close the app');
  else details.push(task.schedule_label);
  if (action !== 'deleted' && task.next_run_at && task.status === 'scheduled') {
    details.push(`next run ${formatNextRun(task.next_run_at)}`);
  }

  return (
    <Paper variant="outlined" data-testid={`task-card-${task.id}`} sx={{ overflow: 'hidden', borderRadius: 1.5, maxWidth: 560 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.75, py: 1.25, bgcolor: look.bg, color: look.fg, borderBottom: `1px solid ${look.border}` }}>
        {look.icon}
        <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{look.heading}</Typography>
      </Box>
      <Box sx={{ px: 1.75, py: 1.5, display: 'flex', alignItems: 'center', gap: 1.75, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{task.title}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{details.join(' · ')}</Typography>
        </Box>
        {action !== 'deleted' && (
          <Button size="small" variant="outlined" startIcon={<TasksIcon />} onClick={openInTasks}>Open in Tasks</Button>
        )}
        {action === 'started' && running && (
          <Button size="small" color="error" startIcon={<StopIcon />} onClick={() => void stopTask(task.id)}>Stop</Button>
        )}
      </Box>
    </Paper>
  );
};
