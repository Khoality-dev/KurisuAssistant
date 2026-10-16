import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Paper, Typography, Chip } from '@mui/material';
import { Build as ToolIcon, CheckCircle, Block } from '@mui/icons-material';

export interface ApprovalOption {
  label: string;
  value: string;
  color?: 'success' | 'error' | 'warning' | 'info' | 'default';
  icon?: React.ReactNode;
}

export interface ApprovalRequest {
  toolName: string;
  description: string;
  detail?: string;
  executionLocation?: 'backend' | 'frontend';
  // Whoever asked for the call: the persona in use, or a sub-agent the assistant spawned.
  requesterName?: string;
  options?: ApprovalOption[];
}

// The server's question is about one call: approve it or deny it (#360). How
// much runs without asking is the permission mode beside the chat input, so
// there is no "always allow this tool" here. A request may bring its own
// options — the desktop's host-tool gate does, to grant a folder.
const DEFAULT_OPTIONS: ApprovalOption[] = [
  { label: 'Approve', value: 'approve', color: 'success', icon: <CheckCircle fontSize="small" /> },
  { label: 'Deny', value: 'deny', color: 'error', icon: <Block fontSize="small" /> },
];

interface ToolApprovalBarProps {
  request: ApprovalRequest;
  onRespond: (value: string) => void;
}

export const ToolApprovalBar: React.FC<ToolApprovalBarProps> = ({ request, onRespond }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const options = request.options?.length ? request.options : DEFAULT_OPTIONS;
  const optionCount = options.length;

  const handleSelect = useCallback(() => {
    onRespond(options[selectedIndex].value);
  }, [options, selectedIndex, onRespond]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedIndex(prev => (prev - 1 + optionCount) % optionCount);
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % optionCount);
          break;
        case 'Enter':
          e.preventDefault();
          handleSelect();
          break;
        case 'Escape':
          e.preventDefault();
          // Escape denies once
          onRespond('deny');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSelect, onRespond, optionCount]);

  // Reset selection when request changes
  useEffect(() => {
    setSelectedIndex(0);
    containerRef.current?.focus();
  }, [request]);

  const isExternal = request.executionLocation === 'frontend';

  return (
    <Paper
      ref={containerRef}
      role="region"
      aria-label="Tool approval"
      tabIndex={-1}
      elevation={3}
      sx={{
        p: 2,
        borderTop: '2px solid',
        borderColor: 'warning.main',
        outline: 'none',
      }}
    >
      {/* Tool info */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <ToolIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {request.toolName}
        </Typography>
        <Chip
          label={isExternal ? 'Client' : 'Server'}
          size="small"
          color={isExternal ? 'info' : 'default'}
          variant="outlined"
        />
        {request.requesterName && (
          <Typography variant="caption" sx={{ color: 'text.secondary', ml: 'auto' }}>
            by {request.requesterName}
          </Typography>
        )}
      </Box>

      {/* Description */}
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: request.detail ? 0.5 : 1.5 }}>
        {request.description}
      </Typography>

      {/* Detail (args) */}
      {request.detail && (
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            color: 'text.secondary',
            opacity: 0.7,
            mb: 1.5,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            maxHeight: 60,
            overflow: 'auto',
          }}
        >
          {request.detail}
        </Typography>
      )}

      {/* Options */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {options.map((opt, i) => (
          <Chip
            key={opt.value}
            icon={opt.icon as React.ReactElement}
            label={opt.label}
            color={opt.color || 'default'}
            variant={i === selectedIndex ? 'filled' : 'outlined'}
            onClick={() => {
              setSelectedIndex(i);
              onRespond(opt.value);
            }}
            sx={{
              fontWeight: i === selectedIndex ? 700 : 400,
              justifyContent: 'flex-start',
              cursor: 'pointer',
            }}
          />
        ))}
        <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5 }}>
          ↑↓ select · Enter confirm · Esc deny
        </Typography>
      </Box>
    </Paper>
  );
};
