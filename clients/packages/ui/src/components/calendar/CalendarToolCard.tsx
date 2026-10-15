import React, { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import {
  CalendarMonthOutlined as CalendarIcon,
  EventOutlined as EventIcon,
  NotificationsNoneOutlined as ReminderIcon,
} from '@mui/icons-material';
import {
  describeWhen,
  entryDay,
  formatShortDate,
  parseCalendarToolResult,
} from '@kurisu/models';
import { useCalendarStore } from '@kurisu/state';

interface Props {
  toolName: string | null | undefined;
  content: string | null | undefined;
}

const kindLabel = (kind: string) => (kind === 'reminder' ? 'Reminder' : 'Event');

/**
 * How a calendar tool call looks in the chat (#282): what was put on the
 * calendar and when, with "Open in Calendar" and — for something just added —
 * "Undo". Renders nothing for a result it cannot read, so the tool row falls
 * back to the plain one.
 */
export const CalendarToolCard: React.FC<Props> = ({ toolName, content }) => {
  const result = parseCalendarToolResult(toolName, content);
  const openEntry = useCalendarStore((s) => s.openEntry);
  const remove = useCalendarStore((s) => s.remove);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!result) return null;

  const kind = result.entry?.kind ?? result.deleted?.kind ?? 'event';
  const isReminder = kind === 'reminder';
  const heading = undone || result.action === 'deleted'
    ? 'Removed from your calendar'
    : result.action === 'created'
      ? `${kindLabel(kind)} added to your calendar`
      : `${kindLabel(kind)} moved on your calendar`;
  const title = result.entry?.title ?? result.deleted?.title ?? '';
  const day = result.entry ? entryDay(result.entry) : null;
  const when = result.entry && day ? `${formatShortDate(day)} · ${describeWhen(result.entry)}` : null;

  const undo = async () => {
    if (!result.entry) return;
    setBusy(true);
    const ok = await remove(result.entry.id);
    setBusy(false);
    if (ok) setUndone(true);
  };

  return (
    <Box
      data-calendar-card={result.action}
      sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden', bgcolor: 'background.paper' }}
    >
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1,
          bgcolor: (t) => (isReminder
            ? (t.palette.mode === 'dark' ? '#3A2A06' : '#FFFBEB')
            : (t.palette.mode === 'dark' ? '#0D1B2A' : '#EFF6FF')),
          color: (t) => (isReminder
            ? (t.palette.mode === 'dark' ? '#FCD34D' : '#92400E')
            : (t.palette.mode === 'dark' ? '#93C5FD' : '#1D4ED8')),
        }}
      >
        {isReminder ? <ReminderIcon sx={{ fontSize: 18 }} /> : <EventIcon sx={{ fontSize: 18 }} />}
        <Typography variant="caption" sx={{ fontWeight: 600 }}>{heading}</Typography>
      </Box>
      <Box sx={{ px: 1.5, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 160 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, textDecoration: undone ? 'line-through' : 'none' }}>
            {title}
          </Typography>
          {when && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{when}</Typography>}
        </Box>
        {result.entry && !undone && (
          <>
            <Button
              size="small"
              variant="outlined"
              startIcon={<CalendarIcon />}
              onClick={() => openEntry(result.entry!.id)}
            >
              Open in Calendar
            </Button>
            {result.action === 'created' && (
              <Button size="small" onClick={undo} disabled={busy}>Undo</Button>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};
