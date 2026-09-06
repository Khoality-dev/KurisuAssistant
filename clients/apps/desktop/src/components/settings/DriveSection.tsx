/**
 * Settings → Kurisu Drive.
 *
 * Two things: how full the drive is, and how much of it the assistant may
 * touch. The second is the reason this section exists as its own page rather
 * than a row in Tools & MCP — "can the assistant write to my files" is a
 * question people want answered in one place, in a sentence, not inferred from
 * four per-tool switches.
 *
 * It is a **view over `users.tool_policies`**, not a second setting. The three
 * choices write the four drive tools' entries; anything that does not match one
 * of them reads back as Custom and is left to Tools & MCP. One source of truth,
 * one enforcement point on the server.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  LinearProgress,
  Paper,
  Radio,
  Typography,
} from '@mui/material';
import { apiClient } from '../../api/client';
import { config } from '../../config';
import { useToolPermissionsStore } from '../../store/toolPermissionsStore';
import { formatBytes } from '../explorer/DriveQuotaBar';
import type { DriveUsage } from '@kurisu/models';

const READ_TOOLS = ['drive_list', 'drive_read'] as const;
const WRITE_TOOLS = ['drive_write', 'drive_delete'] as const;

type DrivePolicy = 'read' | 'ask' | 'full' | 'unset' | 'custom';

interface PolicyChoice {
  id: Exclude<DrivePolicy, 'custom'>;
  label: string;
  description: string;
  isRecommended?: boolean;
}

const CHOICES: PolicyChoice[] = [
  {
    id: 'read',
    label: 'Read only',
    description:
      'The assistant can list and read drive files. Writes and deletes are refused outright — they never reach an approval bar.',
  },
  {
    id: 'ask',
    label: 'Ask before writing',
    description:
      'Reads run silently. Anything that changes the drive stops at the approval bar first, with the file and the size named.',
    // Marks the choice to make, not a state anything is already in: a fresh
    // account has no drive policies at all.
    isRecommended: true,
  },
  {
    id: 'full',
    label: 'Full access',
    description:
      'Writes and deletes go through without asking. Every call is still recorded in the tool rail.',
  },
];

/**
 * Which of the three the stored policies add up to, if any.
 *
 * `unset` is its own answer and not the same as `ask`. A fresh account has no
 * drive policies at all, which means *every* drive call stops at the approval
 * bar — reads included. "Ask before writing" is the state where reads are
 * explicitly allowed and only writes prompt, and nothing reaches it by default.
 */
function readPolicy(tools: Record<string, 'allow' | 'deny'>): DrivePolicy {
  const reads = READ_TOOLS.map((t) => tools[t]);
  const writes = WRITE_TOOLS.map((t) => tools[t]);
  const allReads = (value: string | undefined) => reads.every((r) => r === value);
  const allWrites = (value: string | undefined) => writes.every((w) => w === value);

  if (allReads(undefined) && allWrites(undefined)) return 'unset';
  if (allReads('allow') && allWrites('deny')) return 'read';
  if (allReads('allow') && allWrites(undefined)) return 'ask';
  if (allReads('allow') && allWrites('allow')) return 'full';
  return 'custom';
}

export const DriveSection: React.FC = () => {
  const { policy, loadPolicies, setToolPolicy, removeToolPolicy } = useToolPermissionsStore();
  const [usage, setUsage] = useState<DriveUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    apiClient
      .getDriveUsage()
      .then(setUsage)
      .catch(() => setUsageError('The drive could not be reached. Check the server address in Account.'));
  }, []);

  const current = readPolicy(policy.tools);

  const choose = async (next: Exclude<DrivePolicy, 'custom'>) => {
    setSaving(true);
    try {
      for (const tool of READ_TOOLS) {
        await setToolPolicy(tool, 'allow');
      }
      for (const tool of WRITE_TOOLS) {
        if (next === 'read') await setToolPolicy(tool, 'deny');
        else if (next === 'full') await setToolPolicy(tool, 'allow');
        // 'ask' is the *absence* of a policy: that is what makes the server
        // raise an approval request rather than decide by itself.
        else await removeToolPolicy(tool);
      }
    } finally {
      setSaving(false);
    }
  };

  const percent = usage && usage.quota_bytes > 0
    ? Math.min(100, (usage.used_bytes / usage.quota_bytes) * 100)
    : 0;

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" sx={{ mb: 0.5, fontWeight: 600 }}>
        Kurisu Drive
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Account storage on your server. Every signed-in client sees the same files;
        the assistant reaches them through drive tools.
      </Typography>

      {usageError && <Alert severity="warning" sx={{ mb: 2 }}>{usageError}</Alert>}

      {usage && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
              Storage
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {formatBytes(usage.used_bytes)} of {formatBytes(usage.quota_bytes)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={percent}
            color={percent > 90 ? 'warning' : 'primary'}
            sx={{ height: 6, borderRadius: 3, mb: 1 }}
          />
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.disabled' }}>
            {config.apiBaseUrl} · {usage.file_count} file{usage.file_count === 1 ? '' : 's'} ·
            {' '}up to {formatBytes(usage.max_file_bytes)} per file
          </Typography>
        </Paper>
      )}

      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        Assistant access
      </Typography>

      {current === 'unset' && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Nothing is settled yet, so every drive call — reads included — stops at the
          approval bar. Pick one of these to change that.
        </Alert>
      )}

      {current === 'custom' && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          The drive tools are set individually in Tools &amp; MCP. Choosing one of these
          replaces those settings.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {CHOICES.map((choice) => {
          const selected = current === choice.id;
          return (
            <Paper
              key={choice.id}
              variant="outlined"
              onClick={() => !saving && choose(choice.id)}
              sx={{
                p: 1.5,
                display: 'flex',
                gap: 1,
                alignItems: 'flex-start',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                borderColor: selected ? 'info.main' : 'divider',
                bgcolor: selected ? 'action.selected' : 'transparent',
                '&:hover': { borderColor: 'info.main' },
              }}
            >
              <Radio checked={selected} size="small" sx={{ p: 0.25, mt: 0.25 }} />
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {choice.label}
                  </Typography>
                  {choice.isRecommended && (
                    <Typography
                      variant="caption"
                      sx={{
                        px: 0.75,
                        borderRadius: 0.75,
                        bgcolor: 'action.hover',
                        color: 'text.secondary',
                        textTransform: 'uppercase',
                        fontSize: '0.6rem',
                        letterSpacing: '0.06em',
                      }}
                    >
                      recommended
                    </Typography>
                  )}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {choice.description}
                </Typography>
              </Box>
            </Paper>
          );
        })}
      </Box>
    </Box>
  );
};
