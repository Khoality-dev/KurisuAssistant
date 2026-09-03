import React from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

// ─── Custom edge (with self-loop support) ───

export const LOOP_RADIUS = 30; // radius of self-loop circle

export const OffsetEdge: React.FC<EdgeProps> = ({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  label,
  data,
}) => {
  const isSelfLoop = source === target;

  let path: string;
  let midX: number;
  let midY: number;

  if (isSelfLoop) {
    const r = LOOP_RADIUS;
    const cx = (sourceX + targetX) / 2;
    const baseY = Math.min(sourceY, targetY);
    const halfW = Math.max(Math.abs(targetX - sourceX) / 2, r);
    const sx = cx - halfW;
    const tx = cx + halfW;
    const topY = baseY - r * 2.5;
    path = `M ${sx} ${baseY} C ${sx - r * 0.5} ${topY}, ${tx + r * 0.5} ${topY}, ${tx} ${baseY}`;
    midX = cx;
    midY = topY + r * 0.5;
  } else if (data?.hasReverse) {
    // Bidirectional edge — offset perpendicular so both edges are visible side-by-side
    // Compute perpendicular from a canonical direction (smaller ID → larger ID) so both
    // edges use the same perpendicular vector. Then A→B gets + offset, B→A gets − offset.
    const OFFSET = 6;
    const isCanonical = source < target;
    const sign = isCanonical ? 1 : -1;
    const cdx = isCanonical ? (targetX - sourceX) : (sourceX - targetX);
    const cdy = isCanonical ? (targetY - sourceY) : (sourceY - targetY);
    const len = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
    const perpX = (-cdy / len) * OFFSET * sign;
    const perpY = (cdx / len) * OFFSET * sign;
    const sx = sourceX + perpX;
    const sy = sourceY + perpY;
    const tx = targetX + perpX;
    const ty = targetY + perpY;
    path = `M ${sx} ${sy} L ${tx} ${ty}`;
    midX = (sx + tx) / 2;
    midY = (sy + ty) / 2;
  } else {
    path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    midX = (sourceX + targetX) / 2;
    midY = (sourceY + targetY) / 2;
  }

  const labelStyle = data?.labelStyle as React.CSSProperties | undefined;
  const labelBgStyle = data?.labelBgStyle as React.CSSProperties | undefined;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd as string} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
              pointerEvents: 'all',
              fontSize: 11,
              padding: '2px 4px',
              borderRadius: 3,
              background: labelBgStyle?.fill || '#fff',
              opacity: labelBgStyle?.fillOpacity ?? 0.85,
              color: labelStyle?.fill || labelStyle?.color || '#555',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
          >
            {label as string}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};
