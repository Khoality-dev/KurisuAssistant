import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Paper, Typography, Chip } from '@mui/material';
import { Build as ToolIcon } from '@mui/icons-material';

export interface ApprovalOption {
  label: string;
  value: string;
  color?: 'success' | 'error' | 'warning' | 'info' | 'default';
}

export interface ApprovalRequest {
  toolName: string;
  description: string;
  detail?: string;
  riskLevel?: string;
  agentName?: string;
  options: ApprovalOption[];
}

interface ToolApprovalBarProps {
  request: ApprovalRequest;
  onRespond: (value: string) => void;
}

export const ToolApprovalBar: React.FC<ToolApprovalBarProps> = ({ request, onRespond }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionCount = request.options.length;

  const handleSelect = useCallback(() => {
    onRespond(request.options[selectedIndex].value);
  }, [selectedIndex, onRespond, request.options]);

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
          // Escape selects the last option (Deny)
          onRespond(request.options[request.options.length - 1].value);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSelect, onRespond, optionCount, request.options]);

  // Reset selection when request changes
  useEffect(() => {
    setSelectedIndex(0);
    containerRef.current?.focus();
  }, [request]);

  const riskColor = request.riskLevel === 'high' ? 'error' : request.riskLevel === 'medium' ? 'warning' : 'info';

  return (
    <Paper
      ref={containerRef}
      tabIndex={-1}
      elevation={3}
      sx={{
        p: 2,
        borderTop: '2px solid',
        borderColor: riskColor + '.main',
        outline: 'none',
      }}
    >
      {/* Tool info */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <ToolIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {request.toolName}
        </Typography>
        {request.riskLevel && (
          <Chip label={request.riskLevel} size="small" color={riskColor as any} variant="outlined" />
        )}
        {request.agentName && (
          <Typography variant="caption" sx={{ color: 'text.secondary', ml: 'auto' }}>
            by {request.agentName}
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
        {request.options.map((opt, i) => (
          <Chip
            key={opt.value}
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
