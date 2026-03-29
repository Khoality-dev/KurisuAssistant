/**
 * Renderer-side handler for app config tools.
 *
 * Listens for `app-tools:execute` IPC from main process,
 * dispatches to apiClient / Zustand stores, returns result.
 */

import { apiClient } from '../api/client';
import { useVisionStore } from '../store/visionStore';
import { useExplorerStore } from '../store/explorerStore';
import { useLayoutStore } from '../store/layoutStore';
import { refreshClientMCPServers } from './mcpService';

interface AppToolCall {
  callId: number;
  name: string;
  args: Record<string, unknown>;
}

type ToolResult = { content: string; isError: boolean };

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data), isError: false };
}

function err(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

// --- Tool handlers ---

async function handleGetAgents(): Promise<ToolResult> {
  const agents = await apiClient.listAgents();
  return ok(agents.map(a => ({
    id: a.id,
    name: a.name,
    model_name: a.model_name,
    system_prompt: a.system_prompt?.substring(0, 200) + (a.system_prompt && a.system_prompt.length > 200 ? '...' : ''),
    think: a.think,
    memory_enabled: a.memory_enabled,
    persona_id: a.persona_id,
    persona: a.persona ? {
      id: a.persona.id,
      name: a.persona.name,
      preferred_name: a.persona.preferred_name,
      trigger_word: a.persona.trigger_word,
    } : null,
    available_tools: a.available_tools,
  })));
}

async function handleCreateAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  const modelName = args.model_name as string;
  if (!name) return err('name is required.');
  if (!modelName) return err('model_name is required.');

  const agent = await apiClient.createAgent({
    name,
    model_name: modelName,
    system_prompt: args.system_prompt as string | undefined,
    provider_type: args.provider_type as string | undefined,
    think: args.think as boolean | undefined,
    persona_id: args.persona_id as number | undefined,
  });
  return ok({ status: 'ok', agent: { id: agent.id, name: agent.name, model_name: agent.model_name } });
}

async function handleUpdateAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const agentId = args.agent_id as number;
  if (!agentId) return err('agent_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of ['name', 'system_prompt', 'model_name', 'available_tools', 'think', 'memory_enabled', 'persona_id']) {
    if (args[key] !== undefined) update[key] = args[key];
  }

  if (Object.keys(update).length === 0) return err('No fields to update.');

  const agent = await apiClient.updateAgent(agentId, update);
  return ok({ status: 'ok', agent: { id: agent.id, name: agent.name, model_name: agent.model_name } });
}

async function handleDeleteAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const agentId = args.agent_id as number;
  if (!agentId) return err('agent_id is required.');

  await apiClient.deleteAgent(agentId);
  return ok({ status: 'ok', deleted: agentId });
}

async function handleListMCPServers(): Promise<ToolResult> {
  const servers = await apiClient.listMCPServers();
  return ok(servers.map(s => ({
    id: s.id,
    name: s.name,
    transport_type: s.transport_type,
    url: s.url,
    command: s.command,
    args: s.args,
    enabled: s.enabled,
    location: s.location,
  })));
}

async function handleAddMCPServer(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  const transportType = args.transport_type as string;
  if (!name) return err('name is required.');
  if (!transportType) return err('transport_type is required.');

  const server = await apiClient.createMCPServer({
    name,
    transport_type: transportType as 'sse' | 'stdio',
    url: args.url as string | undefined,
    command: args.command as string | undefined,
    args: args.args as string[] | undefined,
    env: args.env as Record<string, string> | undefined,
    location: (args.location as 'server' | 'client') || 'server',
  });

  // Refresh client MCP servers if it's a client-side server
  if (server.location === 'client') {
    await refreshClientMCPServers();
  }

  return ok({ status: 'ok', server: { id: server.id, name: server.name } });
}

async function handleUpdateMCPServer(args: Record<string, unknown>): Promise<ToolResult> {
  const serverId = args.server_id as number;
  if (!serverId) return err('server_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of ['name', 'transport_type', 'url', 'command', 'args', 'env', 'enabled', 'location']) {
    if (args[key] !== undefined) update[key] = args[key];
  }

  if (Object.keys(update).length === 0) return err('No fields to update.');

  const server = await apiClient.updateMCPServer(serverId, update);
  await refreshClientMCPServers();
  return ok({ status: 'ok', server: { id: server.id, name: server.name } });
}

async function handleDeleteMCPServer(args: Record<string, unknown>): Promise<ToolResult> {
  const serverId = args.server_id as number;
  if (!serverId) return err('server_id is required.');

  await apiClient.deleteMCPServer(serverId);
  await refreshClientMCPServers();
  return ok({ status: 'ok', deleted: serverId });
}

// --- Skills ---

async function handleListSkills(): Promise<ToolResult> {
  const skills = await apiClient.listSkills();
  return ok(skills.map(s => ({ id: s.id, name: s.name, instructions: s.instructions?.substring(0, 200) + (s.instructions && s.instructions.length > 200 ? '...' : '') })));
}

async function handleCreateSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  if (!name) return err('name is required.');

  const skill = await apiClient.createSkill({
    name,
    instructions: args.instructions as string | undefined,
  });
  return ok({ status: 'ok', skill: { id: skill.id, name: skill.name } });
}

async function handleUpdateSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = args.skill_id as number;
  if (!skillId) return err('skill_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of ['name', 'instructions']) {
    if (args[key] !== undefined) update[key] = args[key];
  }
  if (Object.keys(update).length === 0) return err('No fields to update.');

  const skill = await apiClient.updateSkill(skillId, update);
  return ok({ status: 'ok', skill: { id: skill.id, name: skill.name } });
}

async function handleDeleteSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = args.skill_id as number;
  if (!skillId) return err('skill_id is required.');

  await apiClient.deleteSkill(skillId);
  return ok({ status: 'ok', deleted: skillId });
}

// --- Personas ---

async function handleGetPersonas(): Promise<ToolResult> {
  const personas = await apiClient.listPersonas();
  return ok(personas.map(p => ({
    id: p.id,
    name: p.name,
    system_prompt: p.system_prompt?.substring(0, 200) + (p.system_prompt && p.system_prompt.length > 200 ? '...' : ''),
    preferred_name: p.preferred_name,
    trigger_word: p.trigger_word,
    voice_reference: p.voice_reference,
    has_avatar: !!p.avatar_uuid,
    has_character: !!p.character_config,
  })));
}

async function handleCreatePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  if (!name) return err('name is required.');

  const persona = await apiClient.createPersona({
    name,
    system_prompt: args.system_prompt as string | undefined,
    preferred_name: args.preferred_name as string | undefined,
    trigger_word: args.trigger_word as string | undefined,
  });
  return ok({ status: 'ok', persona: { id: persona.id, name: persona.name } });
}

async function handleUpdatePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const personaId = args.persona_id as number;
  if (!personaId) return err('persona_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of ['name', 'system_prompt', 'preferred_name', 'trigger_word']) {
    if (args[key] !== undefined) update[key] = args[key];
  }
  if (Object.keys(update).length === 0) return err('No fields to update.');

  const persona = await apiClient.updatePersona(personaId, update);
  return ok({ status: 'ok', persona: { id: persona.id, name: persona.name } });
}

async function handleDeletePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const personaId = args.persona_id as number;
  if (!personaId) return err('persona_id is required.');

  await apiClient.deletePersona(personaId);
  return ok({ status: 'ok', deleted: personaId });
}

// --- Tools ---

async function handleListTools(): Promise<ToolResult> {
  const tools = await apiClient.listTools();
  return ok({
    builtin_tools: tools.builtin_tools.map(t => ({ name: t.function.name, built_in: t.built_in })),
    mcp_tools: tools.mcp_tools.map(t => ({ name: t.function.name })),
    mcp_servers: tools.mcp_servers
      ? Object.fromEntries(Object.entries(tools.mcp_servers).map(([server, serverTools]) => [server, serverTools.map(t => t.function.name)]))
      : undefined,
  });
}

// --- Vision ---

async function handleVisionStart(args: Record<string, unknown>): Promise<ToolResult> {
  const store = useVisionStore.getState();

  if (args.enable_face !== undefined) store.setEnableFace(args.enable_face as boolean);
  if (args.enable_pose !== undefined) store.setEnablePose(args.enable_pose as boolean);
  if (args.enable_hands !== undefined) store.setEnableHands(args.enable_hands as boolean);

  await store.startVision();
  return ok({ status: 'ok', message: 'Vision pipeline started.' });
}

async function handleVisionStop(): Promise<ToolResult> {
  useVisionStore.getState().stopVision();
  return ok({ status: 'ok', message: 'Vision pipeline stopped.' });
}

// --- UI control ---

async function handleOpenFile(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.path as string;
  if (!filePath) return err('path is required.');

  const name = filePath.split(/[\\/]/).pop() || filePath;
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';

  useExplorerStore.getState().openFile({
    name,
    fullPath: filePath,
    type: 'file',
    size: 0,
    modified: null,
    extension: ext,
  });

  // Switch to workspace page so the file is visible
  useLayoutStore.getState().setActivePage('workspace');

  return ok({ status: 'ok', opened: filePath });
}

async function handleOpenFolder(args: Record<string, unknown>): Promise<ToolResult> {
  const folderPath = args.path as string;
  if (!folderPath) return err('path is required.');

  useExplorerStore.setState({ workspaceRoot: folderPath });
  useLayoutStore.getState().setActivePage('workspace');

  return ok({ status: 'ok', folder: folderPath });
}

async function handleGetOpenFiles(): Promise<ToolResult> {
  const { openFiles, activeFileIndex } = useExplorerStore.getState();
  return ok({
    files: openFiles.map((f, i) => ({
      path: f.path,
      name: f.name,
      active: i === activeFileIndex,
      dirty: f.content !== f.originalContent,
    })),
    count: openFiles.length,
  });
}

async function handleNavigate(args: Record<string, unknown>): Promise<ToolResult> {
  const page = args.page as string;
  if (!page || !['workspace', 'conversations', 'settings'].includes(page)) {
    return err('page must be one of: workspace, conversations, settings');
  }
  useLayoutStore.getState().setActivePage(page as 'workspace' | 'conversations' | 'settings');
  return ok({ status: 'ok', page });
}

// --- Dispatch ---

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'app_get_agents': return handleGetAgents();
    case 'app_create_agent': return handleCreateAgent(args);
    case 'app_update_agent': return handleUpdateAgent(args);
    case 'app_delete_agent': return handleDeleteAgent(args);
    case 'app_get_personas': return handleGetPersonas();
    case 'app_create_persona': return handleCreatePersona(args);
    case 'app_update_persona': return handleUpdatePersona(args);
    case 'app_delete_persona': return handleDeletePersona(args);
    case 'app_list_mcp_servers': return handleListMCPServers();
    case 'app_add_mcp_server': return handleAddMCPServer(args);
    case 'app_update_mcp_server': return handleUpdateMCPServer(args);
    case 'app_delete_mcp_server': return handleDeleteMCPServer(args);
    case 'app_list_skills': return handleListSkills();
    case 'app_create_skill': return handleCreateSkill(args);
    case 'app_update_skill': return handleUpdateSkill(args);
    case 'app_delete_skill': return handleDeleteSkill(args);
    case 'app_list_tools': return handleListTools();
    case 'app_vision_start': return handleVisionStart(args);
    case 'app_vision_stop': return handleVisionStop();
    case 'app_open_file': return handleOpenFile(args);
    case 'app_open_folder': return handleOpenFolder(args);
    case 'app_get_open_files': return handleGetOpenFiles();
    case 'app_navigate': return handleNavigate(args);
    default: return err(`Unknown app tool: ${name}`);
  }
}

// --- Init: listen for IPC from main process ---

let initialized = false;

export function initAppToolsHandler(): void {
  if (initialized || !window.electron?.appTools) return;
  initialized = true;

  window.electron.appTools.onExecute(async (data: AppToolCall) => {
    let result: ToolResult;
    try {
      result = await dispatch(data.name, data.args);
    } catch (e: any) {
      result = err(e.message || String(e));
    }
    window.electron.appTools.sendResult(data.callId, result);
  });

  // Listen for diff view display from host_write/host_edit
  let pageBeforeDiff: string | null = null;
  console.log('[AppTools] Registering onDiffReview listener');
  window.electron.hostTools?.onDiffReview?.((data) => {
    console.log('[AppTools] onDiffReview received:', data.filePath);
    const layout = useLayoutStore.getState();
    if (layout.activePage !== 'workspace') {
      pageBeforeDiff = layout.activePage;
    }
    useExplorerStore.setState({ diffReview: data });
    layout.setActivePage('workspace');
  });

  // Listen for diff view clear — restore previous page
  window.electron.hostTools?.onDiffClear?.(() => {
    useExplorerStore.setState({ diffReview: null });
    if (pageBeforeDiff) {
      useLayoutStore.getState().setActivePage(pageBeforeDiff as any);
      pageBeforeDiff = null;
    }
  });
}
