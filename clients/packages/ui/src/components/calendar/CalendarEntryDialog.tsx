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
  CALENDAR_WEEKDAYS,
  formatClock,
  fromDateKey,
  localDateKey,
  type CalendarEntry,
  type CalendarEntryCreate,
  type CalendarEntryKind,
  type CalendarEntryUpdate,
  type CalendarRepeat,
  type CalendarWeekday,
} from '@kurisu/models';

/** The Repeats choice; `once` is no repeat. */
type RepeatChoice = 'once' | CalendarRepeat;
const REPEAT_CHOICES: { value: RepeatChoice; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
];
const DAY_LABELS: Record<CalendarWeekday, [string, string]> = {
  mon: ['M', 'Monday'], tue: ['T', 'Tuesday'], wed: ['W', 'Wednesday'], thu: ['T', 'Thursday'],
  fri: ['F', 'Friday'], sat: ['S', 'Saturday'], sun: ['S', 'Sunday'],
};

interface Props {
  open: boolean;
  /** The entry being edited, or null for a new one. */
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
 * New event or reminder, and Edit. One form: a kind (fixed once an entry
 * exists — a reminder does not become an event), a title, a date, and a time
 * or "All day". Times are local; the server gets UTC.
 *
 * A reminder also has Repeats (#355): once, every day, every weekday, or
 * weekly on chosen days. Editing a repeating reminder edits the series — its
 * date and time are its first time — and sends only what changed, so stopping
 * the repeat does not also move it.
 */
export const CalendarEntryDialog: React.FC<Props> = ({ open, entry, defaultDay, error, onClose, onCreate, onMove }) => {
  const [kind, setKind] = useState<CalendarEntryKind>('event');
  const [title, setTitle] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState(localDateKey(defaultDay));
  const [endDate, setEndDate] = useState(localDateKey(defaultDay));
  const [start, setStart] = useState(nextHour());
  const [end, setEnd] = useState('');
  const [repeat, setRepeat] = useState<RepeatChoice>('once');
  const [days, setDays] = useState<CalendarWeekday[]>([]);

  /** A repeating reminder is edited as its series, from its first time. */
  const firstTime = entry ? (entry.repeat_from ?? entry.starts_at) : null;

  useEffect(() => {
    if (!open) return;
    setRepeat(entry?.repeat ?? 'once');
    setDays(entry?.repeat_days ?? []);
    if (entry) {
      setKind(entry.kind);
      setTitle(entry.title);
      setAllDay(entry.all_day);
      if (entry.all_day) {
        setDate(entry.start_date ?? localDateKey(defaultDay));
        setEndDate(entry.end_date ?? entry.start_date ?? localDateKey(defaultDay));
      } else if (firstTime) {
        const s = new Date(firstTime);
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
  }, [open, entry, defaultDay, firstTime]);

  const isReminder = kind === 'reminder';
  const timed = isReminder || !allDay;
  const repeatRule: CalendarRepeat | null = isReminder && repeat !== 'once' ? repeat : null;
  const repeatDays = CALENDAR_WEEKDAYS.filter((d) => days.includes(d));
  const needsDays = repeatRule === 'weekly' && repeatDays.length === 0;

  const save = () => {
    if (entry) {
      const changes: CalendarEntryUpdate = { title };
      if (entry.all_day) {
        changes.start_date = date;
        changes.end_date = endDate;
      } else {
        const instant = toInstant(date, start);
        const moved = !firstTime || Date.parse(instant) !== Date.parse(firstTime);
        if (!entry.repeat || moved) changes.starts_at = instant;
        if (!isReminder && end) changes.ends_at = toInstant(date, end);
      }
      const daysChanged = repeatDays.join(',') !== (entry.repeat_days ?? []).join(',');
      if (isReminder && (repeatRule !== (entry.repeat ?? null) || (repeatRule === 'weekly' && daysChanged))) {
        changes.repeat = repeatRule;
        if (repeatRule === 'weekly') changes.repeat_days = repeatDays;
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
    if (repeatRule) {
      body.repeat = repeatRule;
      if (repeatRule === 'weekly') body.repeat_days = repeatDays;
    }
    onCreate(body);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{entry ? `Edit ${entry.kind}` : 'New entry'}</DialogTitle>
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
        {isReminder && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={repeat}
              onChange={(_, value) => value && setRepeat(value)}
              aria-label="Repeats"
            >
              {REPEAT_CHOICES.map((c) => <ToggleButton key={c.value} value={c.value}>{c.label}</ToggleButton>)}
            </ToggleButtonGroup>
            {repeat === 'weekly' && (
              <ToggleButtonGroup
                size="small"
                value={days}
                onChange={(_, value: CalendarWeekday[]) => setDays(value)}
                aria-label="Days"
              >
                {CALENDAR_WEEKDAYS.map((d) => (
                  <ToggleButton key={d} value={d} aria-label={DAY_LABELS[d][1]} sx={{ minWidth: 36 }}>
                    {DAY_LABELS[d][0]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            )}
            {entry?.repeat && (
              <Box sx={{ color: 'text.secondary', fontSize: 13 }}>
                The date is when it starts repeating; changing the time changes every time.
              </Box>
            )}
          </Box>
        )}
        {error && <Box role="alert" sx={{ color: 'error.main', fontSize: 14 }}>{error}</Box>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!title.trim() || needsDays}>
          {entry ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
