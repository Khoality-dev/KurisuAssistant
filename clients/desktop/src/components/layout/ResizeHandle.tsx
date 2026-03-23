import React, { useRef } from 'react';
import { Box } from '@mui/material';

interface ResizeHandleProps {
  /** Target element to resize — pass a ref to the DOM element */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Which CSS dimension to resize */
  property?: 'width' | 'height';
  /** Min/max bounds */
  min?: number;
  max?: number;
  /** Called once on drag end with the final size */
  onResizeEnd?: (size: number) => void;
  /** Direction for cursor */
  direction?: 'horizontal' | 'vertical';
  /** -1 to invert (drag right = shrink, for right-side panels) */
  invert?: boolean;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  targetRef,
  property = 'width',
  min = 100,
  max = 800,
  onResizeEnd,
  direction = 'horizontal',
  invert = false,
}) => {
  const startPos = useRef(0);
  const startSize = useRef(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = targetRef.current;
    if (!el) return;

    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = property === 'width' ? el.offsetWidth : el.offsetHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = (current - startPos.current) * (invert ? -1 : 1);
      const newSize = Math.max(min, Math.min(max, startSize.current + delta));
      el.style[property] = `${newSize}px`;
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Sync final size to state
      const current = direction === 'horizontal' ? upEvent.clientX : upEvent.clientY;
      const delta = (current - startPos.current) * (invert ? -1 : 1);
      const finalSize = Math.max(min, Math.min(max, startSize.current + delta));
      onResizeEnd?.(finalSize);
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
