import { MarkerType, type Node as RFNode, type Edge as RFEdge } from '@xyflow/react';
import type { AnimationNode, AnimationEdge, PoseTree } from '../../videocall/types';
import type { PoseGraphNodeData } from '../PoseGraphNode';

// ─── Per-condition edge styling ───

export const CONDITION_COLORS: Record<string, string> = {
  random: '#2196F3',
  thinking: '#9C27B0',
  gesture: '#FF9800',
  face: '#4CAF50',
  mixed: '#FF9800',
  _default: '#888',
};

/** Format a single condition into a short label from its stored fields */
export function formatCondition(cond: Record<string, unknown>): string {
  const { type, ...rest } = cond;
  const parts = Object.values(rest).map((v) => String(v));
  return parts.length ? `${type}: ${parts.join(', ')}` : String(type);
}

export function getEdgeVisuals(animEdge?: AnimationEdge): {
  style: Record<string, unknown>;
  markerEnd: { type: MarkerType; width: number; height: number; color: string };
  label: string;
} {
  const transitions = animEdge?.transitions || [];
  const hasVideo = transitions.some((t) => t.video_urls?.length);

  let label = '';
  let color = CONDITION_COLORS._default;

  if (transitions.length === 0) {
    label = 'No condition';
  } else if (transitions.length === 1) {
    const conds = transitions[0].conditions;
    if (conds.length === 1) {
      color = CONDITION_COLORS[conds[0].type] || CONDITION_COLORS._default;
      label = formatCondition(conds[0] as unknown as Record<string, unknown>);
    } else {
      color = CONDITION_COLORS.mixed;
      label = conds.map((c) => formatCondition(c as unknown as Record<string, unknown>)).join(' + ');
    }
  } else {
    const allTypes = new Set(transitions.flatMap((t) => t.conditions.map((c) => c.type)));
    if (allTypes.size === 1) {
      const singleType = transitions[0].conditions[0].type;
      color = CONDITION_COLORS[singleType] || CONDITION_COLORS._default;
      label = `${transitions.length} ${singleType}`;
    } else {
      color = CONDITION_COLORS.mixed;
      label = `${transitions.length} transitions`;
    }
  }

  return {
    style: {
      stroke: color,
      strokeWidth: 2,
      strokeDasharray: hasVideo ? undefined : '6 3',
    },
    markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color },
    label,
  };
}

/** Pick the best source/target handle IDs based on relative node positions. */
export function getBestHandles(
  srcPos: { x: number; y: number },
  tgtPos: { x: number; y: number },
  isSelfLoop = false,
): { sourceHandle: string; targetHandle: string } {
  // Self-loop: both handles at top so the loop arcs above the node
  if (isSelfLoop) return { sourceHandle: 's-top', targetHandle: 't-top' };

  const dx = tgtPos.x - srcPos.x;
  const dy = tgtPos.y - srcPos.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal dominant
    return dx >= 0
      ? { sourceHandle: 's-right', targetHandle: 't-left' }
      : { sourceHandle: 's-left', targetHandle: 't-right' };
  } else {
    // Vertical dominant
    return dy >= 0
      ? { sourceHandle: 's-bottom', targetHandle: 't-top' }
      : { sourceHandle: 's-top', targetHandle: 't-bottom' };
  }
}

// ─── Conversion helpers ───

export function poseTreeToReactFlow(
  poseTree: PoseTree,
  defaultPoseIds: string[],
  onDoubleClick: (nodeId: string) => void,
): { nodes: RFNode[]; edges: RFEdge[] } {
  const defaultSet = new Set(defaultPoseIds);
  const nodes: RFNode[] = poseTree.nodes.map((n) => ({
    id: n.id,
    type: 'poseNode',
    position: n.position || { x: 0, y: 0 },
    data: {
      label: n.name,
      baseImageUrl: n.pose_config?.base_image_url,
      isDefault: defaultSet.has(n.id),
      onDoubleClick,
    } satisfies PoseGraphNodeData,
  }));

  // Build position lookup for handle selection
  const posMap = new Map<string, { x: number; y: number }>();
  for (const n of poseTree.nodes) {
    posMap.set(n.id, n.position || { x: 0, y: 0 });
  }

  // Build set of directed pairs to detect bidirectional edges
  const directedPairs = new Set<string>();
  for (const e of poseTree.edges) {
    directedPairs.add(`${e.from_node_id}->${e.to_node_id}`);
  }

  const edges: RFEdge[] = poseTree.edges.map((e) => {
    const isSelfLoop = e.from_node_id === e.to_node_id;
    const hasReverse = !isSelfLoop && directedPairs.has(`${e.to_node_id}->${e.from_node_id}`);
    const srcPos = posMap.get(e.from_node_id) || { x: 0, y: 0 };
    const tgtPos = posMap.get(e.to_node_id) || { x: 0, y: 0 };
    const handles = getBestHandles(srcPos, tgtPos, isSelfLoop);
    const visuals = getEdgeVisuals(e);

    return {
      id: e.id,
      source: e.from_node_id,
      target: e.to_node_id,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      type: 'offsetEdge',
      style: visuals.style,
      markerEnd: visuals.markerEnd,
      label: visuals.label,
      data: {
        hasReverse,
        labelStyle: { fill: visuals.style.stroke as string },
        labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
      },
    };
  });

  return { nodes, edges };
}

export function reactFlowToPoseTree(
  rfNodes: RFNode[],
  rfEdges: RFEdge[],
  defaultPoseIds: string[],
  animationNodesMap: Map<string, AnimationNode>,
  animationEdgesMap: Map<string, AnimationEdge>,
): PoseTree {
  const nodes: AnimationNode[] = rfNodes.map((rfNode) => {
    const existing = animationNodesMap.get(rfNode.id);
    return {
      id: rfNode.id,
      name: (rfNode.data as PoseGraphNodeData).label,
      type: 'pose' as const,
      pose_config: existing?.pose_config,
      animation_settings: existing?.animation_settings,
      position: rfNode.position,
    };
  });

  const edges: AnimationEdge[] = rfEdges.map((rfEdge) => {
    const existing = animationEdgesMap.get(rfEdge.id);
    return {
      id: rfEdge.id,
      from_node_id: rfEdge.source,
      to_node_id: rfEdge.target,
      transitions: existing?.transitions || [],
    };
  });

  return {
    default_pose_ids: defaultPoseIds,
    nodes,
    edges,
  };
}

export function nextNodeId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
