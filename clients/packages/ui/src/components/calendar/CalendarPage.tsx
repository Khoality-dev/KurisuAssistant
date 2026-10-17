import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  CakeOutlined as AllDayIcon,
  Check as CheckIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  Close as CloseIcon,
  DeleteOutline as DeleteIcon,
  EventOutlined as EventIcon,
  NotificationsNoneOutlined as ReminderIcon,
  Repeat as RepeatIcon,
} from '@mui/icons-material';
import {
  calendarWindow,
  describeRepeat,
  describeWhen,
  entriesForDay,
  entryDay,
  entryKey,
  formatShortDate,
  formatWindowTitle,
  layoutTimed,
  localDateKey,
  startOfDay,
  type CalendarEntry,
} from '@kurisu/models';
import { useCalendarStore } from '@kurisu/state';
import { CalendarEntryDialog } from './CalendarEntryDialog';

const HOUR_PX = 48;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Where the grid opens scrolled to: the morning, not midnight. */
const FIRST_VISIBLE_HOUR = 7;

function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const entryColors = (entry: CalendarEntry, dark: boolean) => {
  if (entry.kind === 'reminder') {
    return dark
      ? { bg: '#3A2A06', fg: '#FCD34D', border: '#78350F' }
      : { bg: '#FFFBEB', fg: '#92400E', border: '#FCD34D' };
  }
  return dark
    ? { bg: '#13294B', fg: '#BFDBFE', border: '#1E3A8A' }
    : { bg: '#DBEAFE', fg: '#1E3A8A', border: '#BFDBFE' };
};

/**
 * The calendar (#282): the user's events and reminders by day or by week.
 *
 * Timed entries sit in an hour grid in the device's own time; all-day ones in
 * a row above it; a reminder is a pill at its minute. Selecting one opens the
 * side panel — Done, Edit, Delete — above "Coming up". Nothing here says who
 * put an entry on the calendar, and nothing here starts the assistant.
 *
 * A repeating reminder (#355) is on each of its days, every time an item of its
 * own with the series' id: one time is selected, and Done is for that time.
 */
export const CalendarPage: React.FC = () => {
  const {
    view, anchor, entries, upcoming, selectedId, selectedAt, error,
    setView, step, today, select, load, create, move, setDone, remove, clearError,
  } = useCalendarStore();
  /** One item — a repeating reminder's other times are not it. */
  const isSelected = (e: CalendarEntry) => e.id === selectedId && (selectedAt === null || e.starts_at === selectedAt);
  const selectItem = (e: CalendarEntry) => select(e.id, e.repeat ? e.starts_at : null);
  const [dialog, setDialog] = useState<{ open: boolean; entry: CalendarEntry | null }>({ open: false, entry: null });
  const gridRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
  }, [view]);

  const shown = useMemo(() => calendarWindow(view, anchor), [view, anchor]);
  const selected = useMemo(
    () => {
      const matches = (e: CalendarEntry) => e.id === selectedId && (selectedAt === null || e.starts_at === selectedAt);
      return entries.find(matches) ?? upcoming.find(matches) ?? null;
    },
    [entries, upcoming, selectedId, selectedAt],
  );
  const todayKey = localDateKey(now);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;

  const closeDialog = () => {
    setDialog({ open: false, entry: null });
    clearError();
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden', flexWrap: 'wrap' }}>
      <Box component="section" aria-label="Calendar" sx={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h3">Calendar</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>{formatWindowTitle(view, anchor)}</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <IconButton size="small" aria-label="Previous" onClick={() => step(-1)}><PrevIcon /></IconButton>
            <Button size="small" variant="outlined" onClick={today}>Today</Button>
            <IconButton size="small" aria-label="Next" onClick={() => step(1)}><NextIcon /></IconButton>
          </Box>
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup exclusive size="small" value={view} onChange={(_, v) => v && setView(v)} aria-label="View">
            <ToggleButton value="day">Day</ToggleButton>
            <ToggleButton value="week">Week</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog({ open: true, entry: null })}>
            New
          </Button>
        </Box>

        {error && !dialog.open && (
          <Alert severity="error" onClose={clearError} sx={{ mx: 2, mt: 1 }}>{error}</Alert>
        )}

        {/* Day headers and the all-day row */}
        <Box sx={{ display: 'grid', gridTemplateColumns: `56px repeat(${shown.days.length}, minmax(0, 1fr))`, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
          <Box />
          {shown.days.map((day) => {
            const isToday = localDateKey(day) === todayKey;
            return (
              <Box key={`h-${localDateKey(day)}`} sx={{ py: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', borderLeft: 1, borderColor: 'divider' }}>
                <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', color: isToday ? 'primary.main' : 'text.secondary' }}>
                  {WEEKDAY[day.getDay()]}
                </Typography>
                <Box sx={{
                  width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 600, bgcolor: isToday ? 'primary.main' : 'transparent', color: isToday ? 'primary.contrastText' : 'text.primary',
                }}>
                  {day.getDate()}
                </Box>
              </Box>
            );
          })}
          <Typography variant="caption" sx={{ color: 'text.disabled', textAlign: 'right', pr: 1, pt: 0.5 }}>all day</Typography>
          {shown.days.map((day) => (
            <Box key={`a-${localDateKey(day)}`} data-all-day={localDateKey(day)} sx={{ borderLeft: 1, borderColor: 'divider', p: 0.5, minHeight: 28, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {entriesForDay(entries, day).allDay.map((e) => (
                <Box
                  key={entryKey(e)}
                  component="button"
                  data-entry-id={e.id}
                  onClick={() => selectItem(e)}
                  sx={{
                    all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, height: 22, borderRadius: 1,
                    fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden',
                    bgcolor: (t) => (t.palette.mode === 'dark' ? '#2E1065' : '#F3E8FF'),
                    color: (t) => (t.palette.mode === 'dark' ? '#E9D5FF' : '#6B21A8'),
                    outline: isSelected(e) ? '2px solid' : 'none', outlineColor: 'primary.main',
                  }}
                >
                  <AllDayIcon sx={{ fontSize: 14 }} />{e.title}
                </Box>
              ))}
            </Box>
          ))}
        </Box>

        {/* The hour grid */}
        <Box ref={gridRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: `56px repeat(${shown.days.length}, minmax(0, 1fr))`, minWidth: view === 'week' ? 640 : 0 }}>
            <Box sx={{ position: 'relative', height: 24 * HOUR_PX }}>
              {Array.from({ length: 24 }, (_, h) => (
                <Typography key={h} variant="caption" sx={{ position: 'absolute', right: 8, top: h * HOUR_PX - 7, fontFamily: 'monospace', color: 'text.disabled' }}>
                  {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
                </Typography>
              ))}
            </Box>
            {shown.days.map((day) => {
              const key = localDateKey(day);
              return (
                <Box
                  key={key}
                  data-day={key}
                  sx={{
                    position: 'relative', height: 24 * HOUR_PX, borderLeft: 1, borderColor: 'divider',
                    backgroundImage: (t) => `repeating-linear-gradient(to bottom, ${t.palette.divider} 0, ${t.palette.divider} 1px, transparent 1px, transparent ${HOUR_PX}px)`,
                  }}
                >
                  {layoutTimed(entries, day).map(({ entry: e, startMinute, endMinute, lane, lanes }) => (
                    <TimedEntry
                      key={entryKey(e)}
                      entry={e}
                      top={(startMinute / 60) * HOUR_PX}
                      height={Math.max(((endMinute - startMinute) / 60) * HOUR_PX, 26)}
                      lane={lane}
                      lanes={lanes}
                      selected={isSelected(e)}
                      onSelect={() => selectItem(e)}
                    />
                  ))}
                  {key === todayKey && (
                    <Box aria-hidden sx={{ position: 'absolute', left: 0, right: 0, top: nowTop, height: 2, bgcolor: 'error.main', zIndex: 2 }}>
                      <Box sx={{ position: 'absolute', left: -5, top: -4, width: 10, height: 10, borderRadius: '50%', bgcolor: 'error.main' }} />
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Side panel: the selected entry, then what is coming up */}
      <Box component="aside" sx={{ flex: '1 1 300px', maxWidth: 360, borderLeft: 1, borderColor: 'divider', bgcolor: 'background.default', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected && (
          <Box aria-label="Selected entry" role="region" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                {selected.kind === 'reminder' ? <ReminderIcon sx={{ fontSize: 16 }} /> : <EventIcon sx={{ fontSize: 16 }} />}
                {selected.kind === 'reminder' ? 'Reminder' : 'Event'}
                {selected.done && ' · done'}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <IconButton size="small" aria-label="Close" onClick={() => select(null)}><CloseIcon fontSize="small" /></IconButton>
            </Box>
            <Typography variant="h5" sx={{ fontWeight: 600, textDecoration: selected.done ? 'line-through' : 'none' }}>{selected.title}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {entryDay(selected) ? `${formatShortDate(entryDay(selected)!)} · ` : ''}{describeWhen(selected)}
            </Typography>
            {selected.repeat && (
              <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <RepeatIcon sx={{ fontSize: 16 }} />{describeRepeat(selected)}
              </Typography>
            )}
            {selected.kind === 'reminder' && (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {selected.repeat
                  ? 'Notifies your devices at each of its times, even with the app closed.'
                  : 'Notifies your devices when it is due, even with the app closed.'}
              </Typography>
            )}
            {selected.notes && <Typography variant="body2">{selected.notes}</Typography>}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {selected.kind === 'reminder' && (
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<CheckIcon />}
                  onClick={() => setDone(selected.id, !selected.done, selected.repeat ? selected.starts_at : null)}
                >
                  {selected.done ? 'Not done' : 'Done'}
                </Button>
              )}
              <Button size="small" variant="outlined" onClick={() => setDialog({ open: true, entry: selected })}>Edit</Button>
              <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => remove(selected.id)}>Delete</Button>
            </Box>
          </Box>
        )}
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
          <Typography variant="overline" sx={{ px: 1, color: 'text.secondary' }}>Coming up</Typography>
          {upcoming.length === 0 && (
            <Typography variant="body2" sx={{ px: 1, py: 1, color: 'text.secondary' }}>Nothing on the calendar yet.</Typography>
          )}
          {upcoming.map((e) => {
            const day = entryDay(e);
            return (
              <Box
                key={entryKey(e)}
                component="button"
                onClick={() => {
                  selectItem(e);
                  if (day && (day < shown.start || day >= shown.end)) useCalendarStore.getState().setAnchor(day);
                }}
                sx={{
                  all: 'unset', cursor: 'pointer', display: 'flex', gap: 1.5, width: '100%', boxSizing: 'border-box',
                  px: 1, py: 1, borderRadius: 2, bgcolor: isSelected(e) ? 'action.selected' : 'transparent',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Box sx={{ width: 44, flexShrink: 0, textAlign: 'center' }}>
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', textTransform: 'uppercase' }}>
                    {day ? (localDateKey(day) === todayKey ? 'Today' : WEEKDAY[day.getDay()]) : ''}
                  </Typography>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{day?.getDate()}</Typography>
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {e.kind === 'reminder' ? <ReminderIcon sx={{ fontSize: 15 }} /> : e.all_day ? <AllDayIcon sx={{ fontSize: 15 }} /> : <EventIcon sx={{ fontSize: 15 }} />}
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</span>
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {describeWhen(e)}{e.repeat ? ` · ${describeRepeat(e)}` : ''}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <CalendarEntryDialog
        open={dialog.open}
        entry={dialog.entry}
        defaultDay={view === 'day' ? startOfDay(anchor) : startOfDay(now)}
        error={dialog.open ? error : null}
        onClose={closeDialog}
        onCreate={async (body) => {
          const made = await create(body);
          if (made) closeDialog();
        }}
        onMove={async (id, changes) => {
          const moved = await move(id, changes);
          if (moved) closeDialog();
        }}
      />
    </Box>
  );
};

const TimedEntry: React.FC<{
  entry: CalendarEntry;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  selected: boolean;
  onSelect: () => void;
}> = ({ entry, top, height, lane, lanes, selected, onSelect }) => {
  const isReminder = entry.kind === 'reminder';
  const width = `calc(${100 / lanes}% - 6px)`;
  const left = `calc(${(100 / lanes) * lane}% + 3px)`;
  return (
    <Box
      component="button"
      data-entry-id={entry.id}
      data-selected={selected}
      onClick={onSelect}
      title={`${entry.title} · ${describeWhen(entry)}${entry.repeat ? ` · ${describeRepeat(entry)}` : ''}`}
      sx={(t) => {
        const c = entryColors(entry, t.palette.mode === 'dark');
        return {
          all: 'unset',
          boxSizing: 'border-box',
          cursor: 'pointer',
          position: 'absolute',
          top,
          left,
          width,
          height: isReminder ? 26 : height - 2,
          borderRadius: isReminder ? '13px' : '8px',
          bgcolor: c.bg,
          color: c.fg,
          border: isReminder ? `1px solid ${c.border}` : 'none',
          px: 1,
          py: isReminder ? 0 : 0.5,
          display: 'flex',
          flexDirection: isReminder ? 'row' : 'column',
          alignItems: isReminder ? 'center' : 'flex-start',
          gap: 0.5,
          overflow: 'hidden',
          fontSize: 12,
          zIndex: 1,
          opacity: entry.done ? 0.55 : 1,
          textDecoration: entry.done ? 'line-through' : 'none',
          outline: selected ? `2px solid ${t.palette.primary.main}` : 'none',
        };
      }}
    >
      {isReminder && (entry.repeat ? <RepeatIcon sx={{ fontSize: 14 }} /> : <ReminderIcon sx={{ fontSize: 14 }} />)}
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.title}</span>
      {!isReminder && <span style={{ opacity: 0.85 }}>{describeWhen(entry)}</span>}
    </Box>
  );
};
