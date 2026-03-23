import React, { useEffect, useRef } from 'react';
import { Box } from '@mui/material';

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  direction?: 'horizontal' | 'vertical';
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, onResizeEnd, direction = 'horizontal' }) => {
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  const startPos = useRef(0);

  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);
  useEffect(() => { onResizeEndRef.current = onResizeEnd; }, [onResizeEnd]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      onResizeRef.current(delta);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResizeEndRef.current?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <Box
      onMouseDown={handleMouseDown}
      sx={{
        ...(direction === 'horizontal'
          ? { width: 4, cursor: 'col-resize', flexShrink: 0 }
          : { height: 4, cursor: 'row-resize', flexShrink: 0 }),
        bgcolor: 'transparent',
        transition: 'background-color 150ms ease',
        '&:hover': {
          bgcolor: 'info.main',
          opacity: 0.4,
        },
        position: 'relative',
        '&::before': {
          content: '""',
          position: 'absolute',
          ...(direction === 'horizontal'
            ? { top: 0, bottom: 0, left: -4, right: -4 }
            : { left: 0, right: 0, top: -4, bottom: -4 }),
        },
      }}
    />
  );
};
