import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  formatClock,
  fromDateKey,
  localDateKey,
  type CalendarEntry,
  type CalendarEntryCreate,
  type CalendarEntryKind,
  type CalendarEntryUpdate,
} from '@kurisu/models';

interface Props {
  open: boolean;
  /** The entry being moved, or null for a new one. */
  entry: CalendarEntry | null;
  /** The day a new entry starts on. */
  defaultDay: Date;
  error: string | null;
  onClose: () => void;
  onCreate: (body: CalendarEntryCreate) => void;
  onMove: (id: number, changes: CalendarEntryUpdate) => void;
}

/** A local date (`YYYY-MM-DD`) and clock (`HH:MM`) as the instant the API takes. */
function toInstant(date: string, time: string): string {
  const [h, m] = time.split(':').map(Number);
  const day = fromDateKey(date);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).toISOString();
}

function nextHour(): string {
  const h = (new Date().getHours() + 1) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

/**
 * New event or reminder, and Move. One form: a kind (fixed once an entry
 * exists — a reminder does not become an event), a title, a date, and a time
 * or "All day". Times are local; the server gets UTC.
 */
export const CalendarEntryDialog: React.FC<Props> = ({ open, entry, defaultDay, error, onClose, onCreate, onMove }) => {
  const [kind, setKind] = useState<CalendarEntryKind>('event');
  const [title, setTitle] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState(localDateKey(defaultDay));
  const [endDate, setEndDate] = useState(localDateKey(defaultDay));
  const [start, setStart] = useState(nextHour());
  const [end, setEnd] = useState('');

  useEffect(() => {
    if (!open) return;
    if (entry) {
      setKind(entry.kind);
      setTitle(entry.title);
      setAllDay(entry.all_day);
      if (entry.all_day) {
        setDate(entry.start_date ?? localDateKey(defaultDay));
        setEndDate(entry.end_date ?? entry.start_date ?? localDateKey(defaultDay));
      } else if (entry.starts_at) {
        const s = new Date(entry.starts_at);
        setDate(localDateKey(s));
        setStart(formatClock(s));
        setEnd(entry.ends_at ? formatClock(new Date(entry.ends_at)) : '');
      }
    } else {
      setKind('event');
      setTitle('');
      setAllDay(false);
      setDate(localDateKey(defaultDay));
      setEndDate(localDateKey(defaultDay));
      setStart(nextHour());
      setEnd('');
    }
  }, [open, entry, defaultDay]);

  const isReminder = kind === 'reminder';
  const timed = isReminder || !allDay;

  const save = () => {
    if (entry) {
      const changes: CalendarEntryUpdate = { title };
      if (entry.all_day) {
        changes.start_date = date;
        changes.end_date = endDate;
      } else {
        changes.starts_at = toInstant(date, start);
        if (!isReminder && end) changes.ends_at = toInstant(date, end);
      }
      onMove(entry.id, changes);
      return;
    }
    const body: CalendarEntryCreate = { kind, title };
    if (timed) {
      body.starts_at = toInstant(date, start);
      if (!isReminder && end) body.ends_at = toInstant(date, end);
    } else {
      body.all_day = true;
      body.start_date = date;
      body.end_date = endDate;
    }
    onCreate(body);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{entry ? `Move ${entry.kind}` : 'New entry'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        {!entry && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={kind}
            onChange={(_, value) => value && setKind(value)}
            aria-label="Kind"
          >
            <ToggleButton value="event">Event</ToggleButton>
            <ToggleButton value="reminder">Reminder</ToggleButton>
          </ToggleButtonGroup>
        )}
        <TextField
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          inputProps={{ maxLength: 200 }}
        />
        {!isReminder && !entry && (
          <FormControlLabel
            control={<Checkbox checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />}
            label="All day"
          />
        )}
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <TextField
            label={timed ? 'Date' : 'From'}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ flex: 1 }}
          />
          {!timed && (
            <TextField
              label="To"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
          )}
        </Box>
        {timed && (
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField
              label={isReminder ? 'Time' : 'Starts'}
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
            {!isReminder && (
              <TextField
                label="Ends"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                InputLabelProps={{ shrink: true }}
                helperText={end ? undefined : 'An hour by default'}
                sx={{ flex: 1 }}
              />
            )}
          </Box>
        )}
        {error && <Box role="alert" sx={{ color: 'error.main', fontSize: 14 }}>{error}</Box>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!title.trim()}>
          {entry ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
