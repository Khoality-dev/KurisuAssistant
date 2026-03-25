import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  Button,
  Typography,
  IconButton,
  Alert,
  CircularProgress,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Chip,
} from '@mui/material';
import {
  Close as CloseIcon,
  Add as AddIcon,
  Star as StarIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
  type EdgeTypes,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { apiClient } from '../api/client';
import type { Agent, CharacterConfigDTO } from '../api/types';
import type { AnimationNode, AnimationEdge, PoseTree, PoseConfig } from '../videocall/types';
import { migrateEdgeToTransitions, migratePoseTreeIds } from '../videocall/types';
import PoseGraphNode from './PoseGraphNode';
import type { PoseGraphNodeData } from './PoseGraphNode';
import { PoseNodeEditor } from './PoseNodeEditor';
import { EdgeEditor } from './EdgeEditor';

// ─── Custom edge (with self-loop support) ───

const LOOP_RADIUS = 30; // radius of self-loop circle

const OffsetEdge: React.FC<EdgeProps> = ({
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

// ─── Helpers ───

// ─── Per-condition edge styling ───

const CONDITION_COLORS: Record<string, string> = {
  random: '#2196F3',
  thinking: '#9C27B0',
  gesture: '#FF9800',
  face: '#4CAF50',
  mixed: '#FF9800',
  _default: '#888',
};

/** Format a single condition into a short label from its stored fields */
function formatCondition(cond: Record<string, unknown>): string {
  const { type, ...rest } = cond;
  const parts = Object.values(rest).map((v) => String(v));
  return parts.length ? `${type}: ${parts.join(', ')}` : String(type);
}

function getEdgeVisuals(animEdge?: AnimationEdge): {
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
function getBestHandles(
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

function poseTreeToReactFlow(
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

function reactFlowToPoseTree(
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

// ─── Main dialog ───

interface CharacterConfigDialogProps {
  open: boolean;
  agent: Agent;
  onClose: () => void;
  onSaved: () => void;
}

const nodeTypes: NodeTypes = {
  poseNode: PoseGraphNode,
};

const edgeTypes: EdgeTypes = {
  offsetEdge: OffsetEdge,
};

function nextNodeId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const CharacterConfigDialog: React.FC<CharacterConfigDialogProps> = ({
  open,
  agent,
  onClose,
  onSaved,
}) => {
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // React Flow state
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([] as RFNode[]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([] as RFEdge[]);
  const [defaultPoseIds, setDefaultPoseIds] = useState<string[]>([]);

  // Animation data maps (preserved across React Flow operations)
  const animationNodesRef = useRef(new Map<string, AnimationNode>());
  const animationEdgesRef = useRef(new Map<string, AnimationEdge>());
  // Auto-save: bump version on any mutation, debounced effect saves
  const [saveVersion, setSaveVersion] = useState(0);
  const initialLoadRef = useRef(true);  // Skip auto-save on initial load
  const savingRef = useRef(false);
  const triggerAutoSave = useCallback(() => {
    setSaveVersion((v) => v + 1);
  }, []);

  // Sub-dialog state
  const [poseEditorOpen, setPoseEditorOpen] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [edgeEditorOpen, setEdgeEditorOpen] = useState(false);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    nodeId: string;
  } | null>(null);

  // ─── Double-click handler (stable ref) ───
  const handleNodeDoubleClick = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
    setPoseEditorOpen(true);
  }, []);

  // ─── Load existing config (fetch fresh from API) ───
  useEffect(() => {
    if (!open) return;
    setError('');

    const loadConfig = (cc: CharacterConfigDTO | null) => {
      const nodesMap = new Map<string, AnimationNode>();
      const edgesMap = new Map<string, AnimationEdge>();

      if (cc?.pose_tree?.nodes?.length) {
        let poseTree = cc.pose_tree as PoseTree;

        for (const n of poseTree.nodes) {
          if (!n.position) n.position = { x: 0, y: 0 };
        }

        // Migrate edges to transitions[] format and merge into one edge per directed pair
        const pairEdgeMap = new Map<string, AnimationEdge>();
        for (const rawEdge of poseTree.edges) {
          const migrated = migrateEdgeToTransitions(rawEdge);
          const pairKey = `${migrated.from_node_id}->${migrated.to_node_id}`;
          const deterministicId = `${migrated.from_node_id}-${migrated.to_node_id}`;
          const existing = pairEdgeMap.get(pairKey);
          if (existing) {
            existing.transitions.push(...migrated.transitions);
          } else {
            migrated.id = deterministicId;
            pairEdgeMap.set(pairKey, migrated);
          }
        }
        poseTree.edges = [...pairEdgeMap.values()];

        // Migrate old pose-* node IDs to short hex IDs
        let migrated = false;
        const migration = migratePoseTreeIds(poseTree);
        if (Object.keys(migration.idMapping).length > 0) {
          poseTree = migration.poseTree;
          migrated = true;
          // Rename files on disk via backend
          apiClient.migrateCharacterIds(agent.id, migration.idMapping).catch((err) => {
            console.error('Failed to migrate character asset files:', err);
          });
        }

        // Migrate legacy single default_pose_id to array
        const dpIds: string[] = poseTree.default_pose_ids?.length
          ? poseTree.default_pose_ids
          : [(poseTree as any).default_pose_id || poseTree.nodes[0]?.id].filter(Boolean);
        setDefaultPoseIds(dpIds);

        for (const n of poseTree.nodes) nodesMap.set(n.id, n);
        for (const e of poseTree.edges) edgesMap.set(e.id, e);

        animationNodesRef.current = nodesMap;
        animationEdgesRef.current = edgesMap;

        const { nodes, edges } = poseTreeToReactFlow(poseTree, dpIds, handleNodeDoubleClick);
        setRfNodes(nodes);
        setRfEdges(edges);

        // Auto-save migrated config after initial load completes
        if (migrated) {
          setTimeout(() => triggerAutoSave(), 200);
        }
      } else {
        const defaultId = nextNodeId();
        const defaultNode: AnimationNode = {
          id: defaultId,
          name: 'Default',
          type: 'pose',
          position: { x: 100, y: 100 },
        };
        nodesMap.set(defaultNode.id, defaultNode);
        animationNodesRef.current = nodesMap;
        animationEdgesRef.current = edgesMap;
        setDefaultPoseIds([defaultId]);
        setRfNodes([{
          id: defaultId,
          type: 'poseNode',
          position: { x: 100, y: 100 },
          data: {
            label: 'Default',
            baseImageUrl: undefined,
            isDefault: true,
            onDoubleClick: handleNodeDoubleClick,
          } satisfies PoseGraphNodeData,
        }]);
        setRfEdges([]);
      }
      setTimeout(() => { initialLoadRef.current = false; }, 100);
    };

    // Fetch fresh agent data from API to avoid stale cache
    apiClient.getAgent(agent.id).then((freshAgent) => {
      loadConfig(freshAgent.persona?.character_config ?? null);
    }).catch(() => {
      // Fallback to prop data if fetch fails
      loadConfig(agent.persona?.character_config ?? null);
    });
  }, [open, agent.id]);

  // ─── Auto-save (debounced) ───
  useEffect(() => {
    if (!open || initialLoadRef.current) return;
    if (savingRef.current) return;

    const timer = setTimeout(async () => {
      savingRef.current = true;
      setSaveStatus('saving');
      setError('');
      try {
        const poseTree = reactFlowToPoseTree(
          rfNodes,
          rfEdges,
          defaultPoseIds,
          animationNodesRef.current,
          animationEdgesRef.current,
        );
        await apiClient.updateCharacterConfig(agent.id, { pose_tree: poseTree });
        setSaveStatus('saved');
        onSaved();
        // Notify ChatWidget to refresh character panel data
        window.dispatchEvent(new CustomEvent('character-config-saved', { detail: { agentId: agent.id } }));
      } catch (err: any) {
        setError(err.response?.data?.detail || err.message || 'Auto-save failed');
        setSaveStatus('idle');
      } finally {
        savingRef.current = false;
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [saveVersion]);

  // Clear "saved" chip after 2s
  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const timer = setTimeout(() => setSaveStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  // Wrap onNodesChange to trigger auto-save and recompute edge handles on drag end
  const handleNodesChange = useCallback((...args: Parameters<typeof onNodesChange>) => {
    onNodesChange(...args);
    const hasPositionChange = args[0]?.some(
      (c: any) => c.type === 'position' && c.dragging === false,
    );
    if (hasPositionChange) {
      // Recompute edge handles after node positions changed
      // Use setTimeout to ensure rfNodes state is updated first
      setTimeout(() => {
        setRfNodes((currentNodes) => {
          const posMap = new Map<string, { x: number; y: number }>();
          for (const n of currentNodes) posMap.set(n.id, n.position);
          setRfEdges((eds) =>
            eds.map((e) => {
              const srcPos = posMap.get(e.source) || { x: 0, y: 0 };
              const tgtPos = posMap.get(e.target) || { x: 0, y: 0 };
              const handles = getBestHandles(srcPos, tgtPos, e.source === e.target);
              return { ...e, sourceHandle: handles.sourceHandle, targetHandle: handles.targetHandle };
            }),
          );
          return currentNodes; // Don't modify nodes
        });
      }, 0);
      triggerAutoSave();
    }
  }, [onNodesChange, triggerAutoSave, setRfNodes, setRfEdges]);

  // ─── Edge connection ───
  const onConnect = useCallback((params: Connection) => {
    if (!params.source || !params.target) return;
    let source = params.source;
    let target = params.target;
    let edgeId = `${source}-${target}`;
    const isSelfLoop = source === target;

    // If this directed pair exists, try creating the reverse instead
    // (handles overlap at each position, so React Flow may flip the direction)
    const reverseId = `${target}-${source}`;
    if (animationEdgesRef.current.has(edgeId)) {
      if (!animationEdgesRef.current.has(reverseId) && !isSelfLoop) {
        // Swap to create the reverse edge
        [source, target] = [target, source];
        edgeId = reverseId;
      } else {
        // Both directions exist — open editor for the matched one
        setEditingEdgeId(edgeId);
        setEdgeEditorOpen(true);
        return;
      }
    }

    // Create animation edge with default transition
    const animEdge: AnimationEdge = {
      id: edgeId,
      from_node_id: source,
      to_node_id: target,
      transitions: [{ condition: { type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 } }],
    };
    animationEdgesRef.current.set(edgeId, animEdge);

    const visuals = getEdgeVisuals(animEdge);

    // Self-loop: override handles so the loop arcs above the node
    const handles = isSelfLoop
      ? { sourceHandle: 's-top', targetHandle: 't-top' }
      : { sourceHandle: params.sourceHandle, targetHandle: params.targetHandle };

    // Check if the reverse edge exists — if so, both need hasReverse for side-by-side rendering
    const hasReverse = !isSelfLoop && animationEdgesRef.current.has(reverseId);

    const newEdge: RFEdge = {
      id: edgeId,
      source,
      target,
      ...handles,
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
    setRfEdges((eds) => {
      // Also mark the existing reverse edge as hasReverse
      const updated = hasReverse
        ? eds.map((e) => e.id === reverseId ? { ...e, data: { ...e.data, hasReverse: true } } : e)
        : eds;
      return [...updated, newEdge];
    });
    triggerAutoSave();
  }, [setRfEdges, triggerAutoSave]);

  // ─── Edge click → open editor ───
  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: RFEdge) => {
    setEditingEdgeId(edge.id);
    setEdgeEditorOpen(true);
  }, []);

  // ─── Node context menu ───
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: RFNode) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX,
      mouseY: event.clientY,
      nodeId: node.id,
    });
  }, []);

  const closeContextMenu = () => setContextMenu(null);

  const handleToggleDefault = () => {
    if (!contextMenu) return;
    const nodeId = contextMenu.nodeId;
    setDefaultPoseIds((prev) => {
      const isDefault = prev.includes(nodeId);
      // Don't allow removing the last default
      if (isDefault && prev.length <= 1) return prev;
      const next = isDefault ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
      // Update isDefault in all nodes
      const defaultSet = new Set(next);
      setRfNodes((nds) =>
        nds.map((n) => ({
          ...n,
          data: { ...n.data, isDefault: defaultSet.has(n.id) },
        }))
      );
      triggerAutoSave();
      return next;
    });
    closeContextMenu();
  };

  const handleEditPose = () => {
    if (!contextMenu) return;
    setEditingNodeId(contextMenu.nodeId);
    setPoseEditorOpen(true);
    closeContextMenu();
  };

  const handleDeleteNode = () => {
    if (!contextMenu) return;
    const nodeId = contextMenu.nodeId;

    // Don't delete if it's the last node
    if (rfNodes.length <= 1) {
      setError('Cannot delete the last node');
      closeContextMenu();
      return;
    }

    // Remove from maps
    animationNodesRef.current.delete(nodeId);

    // Remove connected edges from map
    setRfEdges((eds) => {
      const remaining = eds.filter((e) => e.source !== nodeId && e.target !== nodeId);
      // Clean up edge map
      for (const e of eds) {
        if (e.source === nodeId || e.target === nodeId) {
          animationEdgesRef.current.delete(e.id);
        }
      }
      return remaining;
    });

    // Remove node
    setRfNodes((nds) => nds.filter((n) => n.id !== nodeId));

    // Remove from defaults if needed, ensure at least one default remains
    setDefaultPoseIds((prev) => {
      const next = prev.filter((id) => id !== nodeId);
      if (next.length === 0) {
        const remaining = rfNodes.filter((n) => n.id !== nodeId);
        if (remaining.length > 0) next.push(remaining[0].id);
      }
      const defaultSet = new Set(next);
      setRfNodes((nds) =>
        nds.map((n) => ({
          ...n,
          data: { ...n.data, isDefault: defaultSet.has(n.id) },
        }))
      );
      return next;
    });
    triggerAutoSave();
    closeContextMenu();
  };

  // ─── Add pose ───
  const handleAddPose = () => {
    const id = nextNodeId();
    const position = { x: 100 + rfNodes.length * 200, y: 100 };
    const node: AnimationNode = {
      id,
      name: `Pose ${rfNodes.length + 1}`,
      type: 'pose',
      position,
    };
    animationNodesRef.current.set(id, node);

    setRfNodes((nds) => [
      ...nds,
      {
        id,
        type: 'poseNode',
        position,
        data: {
          label: node.name,
          baseImageUrl: undefined,
          isDefault: false,
          onDoubleClick: handleNodeDoubleClick,
        } satisfies PoseGraphNodeData,
      },
    ]);
    triggerAutoSave();
  };

  // ─── Pose editor save ───
  const handlePoseEditorSave = (poseConfig: PoseConfig, name: string, animationSettings: import('../videocall/types').AnimationSettings) => {
    if (!editingNodeId) return;

    // Update animation node map
    const existing = animationNodesRef.current.get(editingNodeId);
    if (existing) {
      existing.pose_config = poseConfig;
      existing.name = name;
      existing.animation_settings = animationSettings;
    }

    // Update React Flow node data
    setRfNodes((nds) =>
      nds.map((n) =>
        n.id === editingNodeId
          ? {
              ...n,
              data: {
                ...n.data,
                label: name,
                baseImageUrl: poseConfig.base_image_url,
              },
            }
          : n
      )
    );

    setPoseEditorOpen(false);
    setEditingNodeId(null);
    triggerAutoSave();
  };

  // ─── Edge editor save ───
  const handleEdgeEditorSave = (updatedEdge: AnimationEdge) => {
    animationEdgesRef.current.set(updatedEdge.id, updatedEdge);

    // Refresh edge visuals (color, label, dash) to reflect new condition/video
    const visuals = getEdgeVisuals(updatedEdge);
    setRfEdges((eds) =>
      eds.map((e) =>
        e.id === updatedEdge.id
          ? {
              ...e,
              style: visuals.style,
              markerEnd: visuals.markerEnd,
              label: visuals.label,
              data: {
                ...e.data,
                labelStyle: { fill: visuals.style.stroke as string },
                labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
              },
            }
          : e
      )
    );

    setEdgeEditorOpen(false);
    setEditingEdgeId(null);
    triggerAutoSave();
  };

  const handleEdgeEditorDelete = () => {
    if (!editingEdgeId) return;
    animationEdgesRef.current.delete(editingEdgeId);
    setRfEdges((eds) => eds.filter((e) => e.id !== editingEdgeId));
    setEdgeEditorOpen(false);
    setEditingEdgeId(null);
    triggerAutoSave();
  };

  // ─── Close handler ───
  const handleClose = () => {
    initialLoadRef.current = true;
    onClose();
  };

  // ─── Get editing node/edge for sub-dialogs ───
  const editingNode = editingNodeId ? animationNodesRef.current.get(editingNodeId) : null;
  const editingEdge = editingEdgeId ? animationEdgesRef.current.get(editingEdgeId) : null;

  const editingEdgeFromName = useMemo(() => {
    if (!editingEdge) return '';
    return animationNodesRef.current.get(editingEdge.from_node_id)?.name || 'Unknown';
  }, [editingEdge]);

  const editingEdgeToName = useMemo(() => {
    if (!editingEdge) return '';
    return animationNodesRef.current.get(editingEdge.to_node_id)?.name || 'Unknown';
  }, [editingEdge]);

  return (
    <>
      <Dialog open={open} onClose={handleClose} fullScreen>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="h6">Character Graph — {agent.name}</Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddPose}
            >
              Add Pose
            </Button>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {saveStatus === 'saving' && (
              <Chip
                icon={<CircularProgress size={14} />}
                label="Saving..."
                size="small"
                variant="outlined"
              />
            )}
            {saveStatus === 'saved' && (
              <Chip
                icon={<CheckIcon sx={{ fontSize: 16 }} />}
                label="Saved"
                size="small"
                color="success"
                variant="outlined"
              />
            )}
            <IconButton onClick={handleClose} size="small">
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ p: 0, position: 'relative' }}>
          {error && (
            <Alert
              severity="error"
              sx={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 10 }}
              onClose={() => setError('')}
            >
              {error}
            </Alert>
          )}

          <Box sx={{ width: '100%', height: '100%' }}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={onEdgeClick}
              onNodeContextMenu={onNodeContextMenu}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              isValidConnection={(connection) => !!(connection.source && connection.target)}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              deleteKeyCode="Delete"
            >
              <Controls />
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            </ReactFlow>
          </Box>
        </DialogContent>
      </Dialog>

      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={closeContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={handleToggleDefault}>
          <ListItemIcon><StarIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Toggle Default</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleEditPose}>
          <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Edit Pose</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDeleteNode}>
          <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>
          <ListItemText>Delete Node</ListItemText>
        </MenuItem>
      </Menu>

      {/* Pose editor sub-dialog */}
      {editingNodeId && (
        <PoseNodeEditor
          open={poseEditorOpen}
          agentId={agent.id}
          poseId={editingNodeId}
          initialPoseConfig={editingNode?.pose_config || null}
          initialAnimationSettings={editingNode?.animation_settings}
          nodeName={editingNode?.name || 'Untitled'}
          onSave={handlePoseEditorSave}
          onClose={() => {
            setPoseEditorOpen(false);
            setEditingNodeId(null);
          }}
        />
      )}

      {/* Edge editor sub-dialog */}
      {editingEdge && (
        <EdgeEditor
          open={edgeEditorOpen}
          agentId={agent.id}
          edge={editingEdge}
          fromNodeName={editingEdgeFromName}
          toNodeName={editingEdgeToName}
          onSave={handleEdgeEditorSave}
          onDelete={handleEdgeEditorDelete}
          onClose={() => {
            setEdgeEditorOpen(false);
            setEditingEdgeId(null);
          }}
        />
      )}
    </>
  );
};
