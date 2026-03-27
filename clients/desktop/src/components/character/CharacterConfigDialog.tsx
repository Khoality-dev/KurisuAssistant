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
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { apiClient } from '../../api/client';
import type { Agent, CharacterConfigDTO } from '../../api/types';
import type { AnimationNode, AnimationEdge, PoseTree, PoseConfig } from '../../videocall/types';
import { migrateEdgeToTransitions, migratePoseTreeIds } from '../../videocall/types';
import PoseGraphNode from '../PoseGraphNode';
import type { PoseGraphNodeData } from '../PoseGraphNode';
import { PoseNodeEditor } from './PoseNodeEditor';
import { EdgeEditor } from '../EdgeEditor';
import { OffsetEdge } from './OffsetEdge';
import { getEdgeVisuals, getBestHandles, poseTreeToReactFlow, reactFlowToPoseTree, nextNodeId } from './graphHelpers';

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
      transitions: [{ conditions: [{ type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 }] }],
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
  const handlePoseEditorSave = (poseConfig: PoseConfig, name: string, animationSettings: import('../../videocall/types').AnimationSettings) => {
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
