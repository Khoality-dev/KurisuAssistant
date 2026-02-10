import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Box, Typography, Chip } from '@mui/material';
import { config } from '../config';

export interface PoseGraphNodeData {
  label: string;
  baseImageUrl?: string;
  isDefault: boolean;
  onDoubleClick: (nodeId: string) => void;
  [key: string]: unknown;
}

const PoseGraphNode: React.FC<NodeProps> = ({ id, data }) => {
  const { label, baseImageUrl, isDefault, onDoubleClick } = data as PoseGraphNodeData;

  const resolveUrl = (url: string) =>
    url.startsWith('http') ? url : `${config.apiBaseUrl}${url}`;

  return (
    <Box
      onDoubleClick={() => onDoubleClick(id)}
      sx={{
        width: 140,
        border: '2px solid',
        borderColor: isDefault ? 'primary.main' : 'grey.400',
        borderRadius: 2,
        bgcolor: 'background.paper',
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: isDefault ? 3 : 1,
        '&:hover': { borderColor: 'primary.light', boxShadow: 3 },
        // Show handles on hover
        '& .react-flow__handle': {
          opacity: 0,
          width: 10,
          height: 10,
          background: '#555',
          border: '2px solid #fff',
          transition: 'opacity 0.15s',
        },
        '&:hover .react-flow__handle': {
          opacity: 1,
        },
      }}
    >
      {/* Handles on all 4 sides for free-form edge connections (visible on hover) */}
      <Handle type="source" position={Position.Top} id="s-top" />
      <Handle type="source" position={Position.Right} id="s-right" />
      <Handle type="source" position={Position.Bottom} id="s-bottom" />
      <Handle type="source" position={Position.Left} id="s-left" />
      <Handle type="target" position={Position.Top} id="t-top" />
      <Handle type="target" position={Position.Right} id="t-right" />
      <Handle type="target" position={Position.Bottom} id="t-bottom" />
      <Handle type="target" position={Position.Left} id="t-left" />

      {/* Thumbnail */}
      <Box
        sx={{
          width: '100%',
          height: 100,
          bgcolor: 'grey.100',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {baseImageUrl ? (
          <Box
            component="img"
            src={resolveUrl(baseImageUrl)}
            sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Typography variant="caption" color="text.secondary">
            No image
          </Typography>
        )}
      </Box>

      {/* Label */}
      <Box sx={{ px: 1, py: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography
          variant="caption"
          sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {label}
        </Typography>
        {isDefault && (
          <Chip label="Default" size="small" color="primary" sx={{ height: 18, fontSize: 10 }} />
        )}
      </Box>
    </Box>
  );
};

export default memo(PoseGraphNode);
