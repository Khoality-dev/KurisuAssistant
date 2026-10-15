import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Autorenew as RunningIcon,
  CheckCircle as DoneIcon,
  ChevronRight as ChevronRightIcon,
  Close as CloseIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Error as FailedIcon,
  EventAvailable as OnceIcon,
  Forum as ForumIcon,
  HourglassTop as WaitingIcon,
  Check as ApproveIcon,
  Block as DenyIcon,
  Pause as PauseIcon,
  PauseCircle as PausedIcon,
  PlayArrow as ResumeIcon,
  Repeat as RepeatIcon,
  StopCircle as StopIcon,
  TaskAlt as FinishedIcon,
  Update as NextRunIcon,
} from '@mui/icons-material';
import type { AssistantTask, TaskDay, TaskRun, TaskScheduleUpdate } from '@kurisu/models';
import {
  TASK_FILTERS,
  formatNextRun,
  formatRunTime,
  groupTasks,
  useConversationStore,
  useTasksStore,
} from '@kurisu/state';

/**
 * Tasks (#352): the assistant's own work, running now or on a schedule. The
 * assistant plans them in a chat; this screen shows what exists, opens one with
 * its recent runs, and changes, pauses, stops or deletes it. A run is a
 * conversation, and opening one loads it in the chat panel.
 */

const ICONS: Record<string, { icon: React.ReactNode; bg: string; fg: string }> = {
  waiting: { icon: <WaitingIcon fontSize="small" />, bg: '#FFFBEB', fg: '#92400E' },
  running: { icon: <RunningIcon fontSize="small" />, bg: '#F0FDF4', fg: '#166534' },
  repeat: { icon: <RepeatIcon fontSize="small" />, bg: '#EFF6FF', fg: '#1D4ED8' },
  once: { icon: <OnceIcon fontSize="small" />, bg: '#EFF6FF', fg: '#1D4ED8' },
  paused: { icon: <PausedIcon fontSize="small" />, bg: '#F5F5F5', fg: '#737373' },
  finished: { icon: <FinishedIcon fontSize="small" />, bg: '#F5F5F5', fg: '#737373' },
};

function iconFor(task: AssistantTask) {
  if (task.status === 'waiting_for_approval') return ICONS.waiting;
  if (task.status === 'running') return ICONS.running;
  if (task.status === 'paused') return ICONS.paused;
  if (task.status === 'finished') return ICONS.finished;
  return task.repeat === 'once' || task.repeat === 'now' ? ICONS.once : ICONS.repeat;
}

/** The line under a task's title: its schedule, and what it is doing about it. */
export function taskSummary(task: AssistantTask, now: Date = new Date()): string {
  switch (task.status) {
    case 'waiting_for_approval':
      return `${task.schedule_label} · waiting for your approval`;
    case 'running':
      return `${task.schedule_label} · running now`;
    case 'paused':
      return `${task.schedule_label} · paused`;
    case 'finished':
      return task.last_run_at ? `${task.schedule_label} · ran ${formatRunTime(task.last_run_at, now)}` : task.schedule_label;
    default:
      return task.next_run_at
        ? `${task.schedule_label} · next ${formatNextRun(task.next_run_at, now)}`
        : task.schedule_label;
  }
}

const RUN_ICONS: Record<TaskRun['status'], { icon: React.ReactNode; color: string; label: string }> = {
  waiting_for_approval: { icon: <WaitingIcon fontSize="small" />, color: '#92400E', label: 'Waiting for your approval' },
  running: { icon: <RunningIcon fontSize="small" />, color: '#166534', label: 'Running' },
  done: { icon: <DoneIcon fontSize="small" />, color: '#16A34A', label: 'Done' },
  failed: { icon: <FailedIcon fontSize="small" />, color: '#DC2626', label: 'Failed' },
  stopped: { icon: <StopIcon fontSize="small" />, color: '#737373', label: 'Stopped' },
};

const TaskRow: React.FC<{ task: AssistantTask; selected: boolean; divider: boolean }> = ({ task, selected, divider }) => {
  const { selectTask, setPaused, stopTask, answerApproval } = useTasksStore();
  const approval = task.pending_approval;
  const look = iconFor(task);
  return (
    <Box
      data-testid={`task-row-${task.id}`}
      onClick={() => selectTask(task.id)}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.75, px: 2, py: 1.75, cursor: 'pointer',
        borderTop: divider ? '1px solid' : 'none', borderColor: 'divider',
        bgcolor: selected ? 'action.selected' : 'background.paper',
        boxShadow: selected ? (t) => `inset 3px 0 0 ${t.palette.primary.main}` : 'none',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
      }}
    >
      <Box sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: look.bg, color: look.fg }}>
        {look.icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 14.5, fontWeight: 600 }} noWrap>{task.title}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{taskSummary(task)}</Typography>
      </Box>
      {approval && (
        <>
          <Tooltip title={`Approve ${approval.tool_name}`}>
            <IconButton aria-label="Approve" size="small" sx={{ color: 'success.main' }} onClick={(e) => { e.stopPropagation(); void answerApproval(approval.id, true); }}>
              <ApproveIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={`Deny ${approval.tool_name}`}>
            <IconButton aria-label="Deny" size="small" sx={{ color: 'error.main' }} onClick={(e) => { e.stopPropagation(); void answerApproval(approval.id, false); }}>
              <DenyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </>
      )}
      {(task.status === 'running' || task.status === 'waiting_for_approval') && (
        <Tooltip title="Stop">
          <IconButton aria-label="Stop" size="small" sx={{ color: 'error.main' }} onClick={(e) => { e.stopPropagation(); void stopTask(task.id); }}>
            <StopIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {task.status === 'scheduled' && (
        <Tooltip title="Pause">
          <IconButton aria-label="Pause" size="small" onClick={(e) => { e.stopPropagation(); void setPaused(task.id, true); }}>
            <PauseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {task.status === 'paused' && (
        <Tooltip title="Resume">
          <IconButton aria-label="Resume" size="small" onClick={(e) => { e.stopPropagation(); void setPaused(task.id, false); }}>
            <ResumeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
};

const DAYS: Array<{ id: TaskDay; label: string }> = [
  { id: 'mon', label: 'Mon' }, { id: 'tue', label: 'Tue' }, { id: 'wed', label: 'Wed' }, { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' }, { id: 'sat', label: 'Sat' }, { id: 'sun', label: 'Sun' },
];

const REPEATS: Array<{ id: TaskScheduleUpdate['repeat']; label: string }> = [
  { id: 'once', label: 'Once' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Some days of the week' },
  { id: 'hourly', label: 'Every few hours' },
];


/** Edit: title, instructions and schedule. A one-off "right away" task keeps its schedule. */
const TaskEditDialog: React.FC<{ task: AssistantTask; onClose: () => void }> = ({ task, onClose }) => {
  const updateTask = useTasksStore((s) => s.updateTask);
  const error = useTasksStore((s) => s.error);
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const editableSchedule = task.repeat !== 'now';
  const [repeat, setRepeat] = useState<TaskScheduleUpdate['repeat']>(task.repeat === 'now' ? 'once' : task.repeat);
  const [time, setTime] = useState(task.time ?? '08:00');
  const [days, setDays] = useState<TaskDay[]>(task.days.length ? task.days : ['mon']);
  const [everyHours, setEveryHours] = useState(task.every_hours ?? 1);
  const [at, setAt] = useState(() => {
    if (!task.run_at) return '';
    const d = new Date(task.run_at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    setSaving(true);
    setFailed(false);
    // No zone: the server reads the times in the account's (Settings › Account).
    const schedule: TaskScheduleUpdate = { repeat };
    if (repeat === 'once') schedule.at = at;
    if (repeat === 'daily' || repeat === 'weekdays' || repeat === 'weekly') schedule.time = time;
    if (repeat === 'weekly') schedule.days = days;
    if (repeat === 'hourly') schedule.every_hours = everyHours;
    try {
      await updateTask(task.id, {
        title,
        instructions,
        ...(editableSchedule ? { schedule } : {}),
      });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit task</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        {failed && error && <Alert severity="error">{error}</Alert>}
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth size="small" />
        <TextField label="Task instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} fullWidth multiline minRows={3} />
        {editableSchedule && (
          <>
            <TextField select label="Repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as TaskScheduleUpdate['repeat'])} size="small">
              {REPEATS.map((r) => <MenuItem key={r.id} value={r.id}>{r.label}</MenuItem>)}
            </TextField>
            {repeat === 'once' && (
              <TextField label="Date and time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} size="small" InputLabelProps={{ shrink: true }} />
            )}
            {(repeat === 'daily' || repeat === 'weekdays' || repeat === 'weekly') && (
              <TextField label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} size="small" InputLabelProps={{ shrink: true }} />
            )}
            {repeat === 'weekly' && (
              <ToggleButtonGroup
                value={days}
                onChange={(_e, value: TaskDay[]) => value.length && setDays(value)}
                size="small"
                aria-label="Days"
              >
                {DAYS.map((d) => <ToggleButton key={d.id} value={d.id}>{d.label}</ToggleButton>)}
              </ToggleButtonGroup>
            )}
            {repeat === 'hourly' && (
              <TextField label="Hours between runs" type="number" value={everyHours} onChange={(e) => setEveryHours(Math.max(1, Number(e.target.value) || 1))} size="small" inputProps={{ min: 1 }} />
            )}
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Times are in your account's time zone, set under Settings › Account.
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving || !title.trim() || !instructions.trim()}>Save</Button>
      </DialogActions>
    </Dialog>
  );
};

/** The call a run waits on the user for, with the answer (#352). */
const PendingApproval: React.FC<{ task: AssistantTask }> = ({ task }) => {
  const answerApproval = useTasksStore((s) => s.answerApproval);
  const approval = task.pending_approval;
  if (!approval) return null;
  const args = Object.entries(approval.tool_args ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  return (
    <Paper variant="outlined" data-testid="task-pending-approval" sx={{ p: 1.5, borderColor: '#FCD34D', bgcolor: '#FFFBEB', color: '#78350F' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
        <WaitingIcon fontSize="small" />
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>Waiting for your approval</Typography>
      </Box>
      <Typography sx={{ fontSize: 13.5, fontWeight: 600, fontFamily: 'monospace' }}>{approval.tool_name}</Typography>
      {approval.description && <Typography variant="body2">{approval.description}</Typography>}
      {args && <Typography component="pre" sx={{ fontSize: 12, whiteSpace: 'pre-wrap', m: 0, mt: 0.5 }}>{args}</Typography>}
      {approval.expires_at && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          Denied on its own if nobody answers by {formatRunTime(approval.expires_at)}.
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
        <Button size="small" variant="contained" color="success" startIcon={<ApproveIcon />} onClick={() => answerApproval(approval.id, true)}>Approve</Button>
        <Button size="small" variant="outlined" color="error" startIcon={<DenyIcon />} onClick={() => answerApproval(approval.id, false)}>Deny</Button>
      </Box>
    </Paper>
  );
};

const TaskDetail: React.FC<{ task: AssistantTask }> = ({ task }) => {
  const { selectTask, setPaused, stopTask, deleteTask } = useTasksStore();
  const loadConversation = useConversationStore((s) => s.loadConversation);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const statusChip: Record<AssistantTask['status'], { label: string; color: 'success' | 'primary' | 'default' | 'warning' }> = {
    waiting_for_approval: { label: 'Waiting for approval', color: 'warning' },
    running: { label: 'Running', color: 'success' },
    scheduled: { label: 'Scheduled', color: 'primary' },
    paused: { label: 'Paused', color: 'default' },
    finished: { label: 'Finished', color: 'default' },
  };

  return (
    <Box data-testid="task-detail" sx={{ width: 380, flexShrink: 0, borderLeft: 1, borderColor: 'divider', bgcolor: 'background.default', overflowY: 'auto' }}>
      <Box sx={{ p: 2.75, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.75 }}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Chip size="small" label={statusChip[task.status].label} color={statusChip[task.status].color} variant="outlined" />
          <Box sx={{ flex: 1 }} />
          <IconButton aria-label="Close" size="small" onClick={() => selectTask(null)}><CloseIcon fontSize="small" /></IconButton>
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.25 }}>{task.title}</Typography>
        <PendingApproval task={task} />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, fontSize: 13.5, color: 'text.secondary' }}>
          <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'center' }}><RepeatIcon fontSize="small" />{task.schedule_label}</Box>
          {task.next_run_at && (
            <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'center' }}><NextRunIcon fontSize="small" />Next run {formatNextRun(task.next_run_at)}</Box>
          )}
          {task.planned_in_conversation_id !== null && (
            <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'center' }}>
              <ForumIcon fontSize="small" />
              <Button size="small" sx={{ p: 0, minWidth: 0, textTransform: 'none' }} onClick={() => loadConversation(task.planned_in_conversation_id!)}>
                The chat it was planned in
              </Button>
            </Box>
          )}
        </Box>
        <Box>
          <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Task instructions</Typography>
          <Paper variant="outlined" sx={{ mt: 0.5, p: 1.25, fontSize: 13, whiteSpace: 'pre-wrap', bgcolor: 'action.hover' }}>{task.instructions}</Paper>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {(task.status === 'running' || task.status === 'waiting_for_approval') && (
            <Button size="small" color="error" variant="outlined" startIcon={<StopIcon />} onClick={() => stopTask(task.id)}>Stop</Button>
          )}
          {task.status === 'scheduled' && (
            <Button size="small" variant="outlined" startIcon={<PauseIcon />} onClick={() => setPaused(task.id, true)}>Pause</Button>
          )}
          {task.status === 'paused' && (
            <Button size="small" variant="outlined" startIcon={<ResumeIcon />} onClick={() => setPaused(task.id, false)}>Resume</Button>
          )}
          <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)}>Edit</Button>
          <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => setConfirmDelete(true)}>Delete</Button>
        </Box>
      </Box>

      <Box sx={{ p: 1.5 }}>
        <Typography variant="overline" sx={{ color: 'text.secondary', px: 1 }}>Recent runs</Typography>
        {(task.runs ?? []).length === 0 && (
          <Typography variant="body2" sx={{ color: 'text.secondary', px: 1, py: 1 }}>No runs yet.</Typography>
        )}
        {(task.runs ?? []).map((run) => {
          const look = RUN_ICONS[run.status];
          return (
            <Box
              key={run.id}
              data-testid={`task-run-${run.id}`}
              component="button"
              disabled={run.conversation_id === null}
              onClick={() => run.conversation_id !== null && loadConversation(run.conversation_id)}
              sx={{
                all: 'unset', boxSizing: 'border-box', width: '100%', display: 'flex', gap: 1.5, alignItems: 'flex-start',
                p: 1.25, borderRadius: 1.25, cursor: run.conversation_id !== null ? 'pointer' : 'default',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ color: look.color, mt: '1px' }}>{look.icon}</Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{formatRunTime(run.started_at)}</Typography>
                <Typography variant="caption" sx={{ color: run.status === 'failed' ? 'error.main' : 'text.secondary' }}>
                  {run.status === 'failed' && run.error ? `Failed: ${run.error}` : look.label}
                </Typography>
              </Box>
              {run.conversation_id !== null && <ChevronRightIcon fontSize="small" sx={{ color: 'text.disabled' }} />}
            </Box>
          );
        })}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', px: 1.25, pt: 0.75 }}>
          Each run is a conversation. Open one to see what the assistant did.
        </Typography>
      </Box>

      {editing && <TaskEditDialog task={task} onClose={() => setEditing(false)} />}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>Delete “{task.title}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {task.status === 'running' ? 'Its run is stopped first. ' : ''}The conversations its runs left stay.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => { setConfirmDelete(false); void deleteTask(task.id); }}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export const TasksPage: React.FC = () => {
  const { tasks, filter, setFilter, selectedTaskId, selectedTask, loadTasks, listenForChanges, error, loading } = useTasksStore();

  useEffect(() => {
    listenForChanges();
    void loadTasks();
  }, [listenForChanges, loadTasks]);

  const groups = groupTasks(tasks, filter);
  const counts = (id: string) => (id === 'all' ? tasks.length : tasks.filter((t) => t.status === id).length);

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', px: 4, py: 3.5 }}>
        <Box sx={{ maxWidth: 760, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          <Box>
            <Typography variant="h3">Tasks</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.75 }}>
              Work the assistant does on its own, right away or on a schedule. Ask the assistant to start or schedule one.
              Reminders for you are in the calendar.
            </Typography>
          </Box>
          <Box role="tablist" aria-label="Filter" sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {TASK_FILTERS.map((f) => (
              <Chip
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                label={`${f.label} ${counts(f.id)}`}
                onClick={() => setFilter(f.id)}
                color={filter === f.id ? 'primary' : 'default'}
                variant={filter === f.id ? 'filled' : 'outlined'}
              />
            ))}
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          {!loading && tasks.length === 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>
              No tasks yet. Ask the assistant to do something in the background or on a schedule.
            </Typography>
          )}
          {groups.map((group) => (
            <Box key={group.status} data-testid={`task-group-${group.status}`} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="overline" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>{group.label}</Typography>
              <Paper variant="outlined" sx={{ overflow: 'hidden', borderRadius: 1.5 }}>
                {group.tasks.map((task, i) => (
                  <TaskRow key={task.id} task={task} selected={task.id === selectedTaskId} divider={i > 0} />
                ))}
              </Paper>
            </Box>
          ))}
        </Box>
      </Box>
      {selectedTask && <TaskDetail task={selectedTask} />}
    </Box>
  );
};
