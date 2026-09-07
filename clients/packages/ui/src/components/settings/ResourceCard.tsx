import React from 'react';
import {
  Box,
  Card,
  CardActions,
  CardContent,
  IconButton,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  FileDownload as ExportIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';

const MotionCard = motion(Card);

interface ResourceCardProps {
  /** Optional leading visual — a persona's avatar, a sub-agent's icon. */
  avatar?: React.ReactNode;
  title: string;
  description?: string;
  /** Two-line clamped body: the system prompt or task instructions. */
  body: string;
  /** Caption chips joined with a middot — model name, voice, and so on. */
  meta?: Array<string | null | undefined>;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onExport: () => void;
  onDelete: () => void;
  onClick: () => void;
}

/**
 * One card in the personas / sub-agents grids. The two resources are edited in
 * different dialogs but list identically, so the card lives here rather than
 * being written twice and drifting.
 */
export const ResourceCard: React.FC<ResourceCardProps> = ({
  avatar,
  title,
  description,
  body,
  meta,
  enabled,
  onToggleEnabled,
  onExport,
  onDelete,
  onClick,
}) => {
  const metaLine = (meta ?? []).filter(Boolean).join(' · ');

  return (
    <MotionCard
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      sx={{
        position: 'relative',
        border: '1px solid',
        borderColor: 'divider',
        opacity: enabled ? 1 : 0.5,
        cursor: 'pointer',
        '&:hover': {
          boxShadow: 3,
          transform: 'translateY(-2px)',
        },
        transition: 'box-shadow 0.2s, transform 0.2s, opacity 0.2s',
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
          {avatar}
          {/* Name wraps to its own line when the card is too narrow for
              avatar + name. wordBreak keeps a long name from hiding behind
              overflow:hidden when the grid collapses in a narrow panel. */}
          <Typography variant="h6" sx={{ minWidth: 0, flex: '1 1 auto', wordBreak: 'break-word' }}>
            {title}
          </Typography>
        </Box>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {description}
          </Typography>
        )}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            minHeight: 40,
          }}
        >
          {body}
        </Typography>
        {metaLine && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 1.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {metaLine}
          </Typography>
        )}
      </CardContent>
      <CardActions sx={{ justifyContent: 'space-between', px: 2, pb: 2 }}>
        <Switch
          size="small"
          checked={enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            onToggleEnabled(e.target.checked);
          }}
        />
        <Box>
          <Tooltip title="Export">
            <IconButton
              onClick={(e) => {
                e.stopPropagation();
                onExport();
              }}
            >
              <ExportIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              color="error"
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
    </MotionCard>
  );
};
