/**
 * Renderer-side handler for app config tools.
 *
 * Listens for `app-tools:execute` IPC from main process,
 * dispatches to apiClient / Zustand stores, returns result.
 *
 * Every name advertised in `electron/appTools.ts` needs a case in `dispatch`, and
 * every case needs a schema there. A schema with no case is worse than a missing
 * tool: the model is told it exists, spends tokens on it in every request, and is
 * answered "Unknown app tool" when it finally calls it.
 */

import { apiClient } from '../api/client';
import { useVisionStore } from '../store/visionStore';
import { useMicStore } from '../store/micStore';
import { useExplorerStore } from '../store/explorerStore';
import { useLayoutStore } from '../store/layoutStore';
import { refreshClientMCPServers } from './mcpService';

interface AppToolCall {
  callId: number;
  name: string;
  args: Record<string, unknown>;
}

type ToolResult = { content: string; isError: boolean };

function ok(msg: string): ToolResult {
  return { content: msg, isError: false };
}

function err(message: string): ToolResult {
  return { content: `Error: ${message}`, isError: true };
}

// --- Tool handlers ---

// --- Assistant (capability: one per user) ---

async function handleGetAssistant(): Promise<ToolResult> {
  const a = await apiClient.getAssistant();
  const lines = [
    `- Model: ${a.model_name || 'not set'} (${a.provider_type})`,
    `- Tools: ${a.available_tools === null ? 'every tool' : a.available_tools.join(', ') || 'none'}`,
    `- Extended thinking: ${a.think ? 'on' : 'off'}`,
    `- Deferred tools: ${a.use_deferred_tools ? 'on' : 'off'}`,
    `- Memory: ${a.memory_enabled ? 'on' : 'off'}`,
    `- Wake word: ${a.trigger_word || 'none'}`,
    `- Default persona: ${a.default_persona_id ?? 'none'}`,
  ];
  return ok(lines.join('\n'));
}

/**
 * Capability only. Presentation — name, prompt, voice, avatar — belongs to a
 * persona, so it goes through handleUpdatePersona instead. The pre-split tool
 * took both in one allowlist and could not say which resource it was writing.
 */
async function handleUpdateAssistant(args: Record<string, unknown>): Promise<ToolResult> {
  const update: Record<string, unknown> = {};
  for (const key of [
    'model_name', 'provider_type', 'available_tools', 'think',
    'use_deferred_tools', 'memory', 'memory_enabled', 'trigger_word',
    'default_persona_id',
  ]) {
    if (args[key] !== undefined) update[key] = args[key];
  }
  if (Object.keys(update).length === 0) return err('No fields to update.');

  const a = await apiClient.updateAssistant(update);
  return ok(`Assistant updated — model ${a.model_name || 'not set'} (${a.provider_type}).`);
}

// --- Personas (presentation: many per user) ---

async function handleGetPersonas(): Promise<ToolResult> {
  const personas = await apiClient.listPersonas();
  if (personas.length === 0) return ok('No personas configured.');
  const lines = personas.map(p => {
    const desc = p.description ? ` — ${p.description}` : '';
    return `- **${p.name}** (#${p.id})${p.enabled ? '' : ' (disabled)'}${desc}`;
  });
  return ok(lines.join('\n'));
}

async function handleCreatePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  if (!name) return err('name is required.');

  const persona = await apiClient.createPersona({
    name,
    description: args.description as string | undefined,
    system_prompt: args.system_prompt as string | undefined,
    preferred_name: args.preferred_name as string | undefined,
    voice_reference: args.voice_reference as string | undefined,
    enabled: args.enabled as boolean | undefined,
  });
  return ok(`Persona created: **${persona.name}** (#${persona.id})`);
}

async function handleUpdatePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const personaId = args.persona_id as number;
  if (!personaId) return err('persona_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of [
    'name', 'description', 'system_prompt', 'preferred_name',
    'voice_reference', 'enabled',
  ]) {
    if (args[key] !== undefined) update[key] = args[key];
  }
  if (Object.keys(update).length === 0) return err('No fields to update.');

  const persona = await apiClient.updatePersona(personaId, update);
  return ok(`Persona updated: **${persona.name}** (#${persona.id})`);
}

async function handleDeletePersona(args: Record<string, unknown>): Promise<ToolResult> {
  const personaId = args.persona_id as number;
  if (!personaId) return err('persona_id is required.');

  await apiClient.deletePersona(personaId);
  return ok(`Persona #${personaId} deleted.`);
}

// --- Sub-agents (task-only workers) ---

async function handleGetSubAgents(): Promise<ToolResult> {
  const subAgents = await apiClient.listSubAgents();
  if (subAgents.length === 0) return ok('No sub-agents configured.');
  const lines = subAgents.map(s => {
    const desc = s.description ? ` — ${s.description}` : '';
    return `- **${s.name}** (#${s.id}) — ${s.model_name || "the assistant's model"}${s.enabled ? '' : ' (disabled)'}${desc}`;
  });
  return ok(lines.join('\n'));
}

async function handleCreateSubAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  if (!name) return err('name is required.');

  const subAgent = await apiClient.createSubAgent({
    name,
    description: args.description as string | undefined,
    system_prompt: args.system_prompt as string | undefined,
    model_name: args.model_name as string | undefined,
    provider_type: args.provider_type as string | undefined,
    available_tools: args.available_tools as string[] | undefined,
    think: args.think as boolean | undefined,
  });
  return ok(`Sub-agent created: **${subAgent.name}** (#${subAgent.id})`);
}

async function handleUpdateSubAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const subAgentId = args.sub_agent_id as number;
  if (!subAgentId) return err('sub_agent_id is required.');

  const update: Record<string, unknown> = {};
  for (const key of [
    'name', 'description', 'system_prompt', 'model_name', 'provider_type',
    'available_tools', 'think', 'use_deferred_tools', 'enabled',
  ]) {
    if (args[key] !== undefined) update[key] = args[key];
  }
  if (Object.keys(update).length === 0) return err('No fields to update.');

  const subAgent = await apiClient.updateSubAgent(subAgentId, update);
  return ok(`Sub-agent updated: **${subAgent.name}** (#${subAgent.id})`);
}

async function handleDeleteSubAgent(args: Record<string, unknown>): Promise<ToolResult> {
  const subAgentId = args.sub_agent_id as number;
  if (!subAgentId) return err('sub_agent_id is required.');

  await apiClient.deleteSubAgent(subAgentId);
  return ok(`Sub-agent #${subAgentId} deleted.`);
}

async function handleListMCPServers(): Promise<ToolResult> {
  const servers = await apiClient.listMCPServers();
  if (servers.length === 0) return ok('No MCP servers configured.');
  const lines = servers.map(s => `- **${s.name}** (#${s.id}) — ${s.transport_type}, ${s.location}${s.enabled ? '' : ' (disabled)'}`);
  return ok(lines.join('\n'));
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

  return ok(`MCP server created: **${server.name}** (#${server.id})`);
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
  return ok(`MCP server updated: **${server.name}** (#${server.id})`);
}

async function handleDeleteMCPServer(args: Record<string, unknown>): Promise<ToolResult> {
  const serverId = args.server_id as number;
  if (!serverId) return err('server_id is required.');

  await apiClient.deleteMCPServer(serverId);
  await refreshClientMCPServers();
  return ok(`MCP server #${serverId} deleted.`);
}

// --- Skills ---

async function handleListSkills(): Promise<ToolResult> {
  const skills = await apiClient.listSkills();
  if (skills.length === 0) return ok('No skills configured.');
  const lines = skills.map(s => `- **${s.name}** (#${s.id}): ${s.instructions?.substring(0, 100) || '(no instructions)'}${s.instructions && s.instructions.length > 100 ? '...' : ''}`);
  return ok(lines.join('\n'));
}

async function handleCreateSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string;
  if (!name) return err('name is required.');

  const skill = await apiClient.createSkill({
    name,
    instructions: args.instructions as string | undefined,
  });
  return ok(`Skill created: **${skill.name}** (#${skill.id})`);
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
  return ok(`Skill updated: **${skill.name}** (#${skill.id})`);
}

async function handleDeleteSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = args.skill_id as number;
  if (!skillId) return err('skill_id is required.');

  await apiClient.deleteSkill(skillId);
  return ok(`Skill #${skillId} deleted.`);
}

// --- Tools ---

async function handleListTools(): Promise<ToolResult> {
  const tools = await apiClient.listTools();
  const lines: string[] = [];
  if (tools.builtin_tools.length > 0) {
    lines.push('**Built-in tools:**');
    tools.builtin_tools.forEach(t => lines.push(`- ${t.function.name}`));
  }
  if (tools.mcp_tools.length > 0) {
    lines.push('\n**MCP tools:**');
    tools.mcp_tools.forEach(t => lines.push(`- ${t.function.name}`));
  }
  return ok(lines.join('\n') || 'No tools available.');
}

// --- Vision ---

async function handleVisionStart(args: Record<string, unknown>): Promise<ToolResult> {
  const store = useVisionStore.getState();

  if (args.enable_face !== undefined) store.setEnableFace(args.enable_face as boolean);
  if (args.enable_pose !== undefined) store.setEnablePose(args.enable_pose as boolean);
  if (args.enable_hands !== undefined) store.setEnableHands(args.enable_hands as boolean);

  await store.startVision();
  return ok('Vision pipeline started.');
}

async function handleVisionStop(): Promise<ToolResult> {
  useVisionStore.getState().stopVision();
  return ok('Vision pipeline stopped.');
}

// --- Voice interaction ---

async function handleEndInteraction(): Promise<ToolResult> {
  const mic = useMicStore.getState();
  if (!mic.interactionActive) return ok('No active voice interaction.');
  mic.deactivateInteraction();
  return ok('Voice interaction ended.');
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

  return ok(`Opened file: ${filePath}`);
}

async function handleOpenFolder(args: Record<string, unknown>): Promise<ToolResult> {
  const folderPath = args.path as string;
  if (!folderPath) return err('path is required.');

  useExplorerStore.setState({ workspaceRoot: folderPath });
  useLayoutStore.getState().setActivePage('workspace');

  return ok(`Opened folder: ${folderPath}`);
}

async function handleGetOpenFiles(): Promise<ToolResult> {
  const { openFiles, activeFileIndex } = useExplorerStore.getState();
  if (openFiles.length === 0) return ok('No files open.');
  const lines = openFiles.map((f, i) => {
    const active = i === activeFileIndex ? ' **(active)**' : '';
    const dirty = f.content !== f.originalContent ? ' (modified)' : '';
    return `- ${f.name}${active}${dirty} — ${f.path}`;
  });
  return ok(lines.join('\n'));
}

async function handleNavigate(args: Record<string, unknown>): Promise<ToolResult> {
  const page = args.page as string;
  if (!page || !['workspace', 'conversations', 'settings'].includes(page)) {
    return err('page must be one of: workspace, conversations, settings');
  }
  useLayoutStore.getState().setActivePage(page as 'workspace' | 'conversations' | 'settings');
  return ok(`Navigated to ${page}.`);
}

// --- Dispatch ---

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'app_get_assistant': return handleGetAssistant();
    case 'app_update_assistant': return handleUpdateAssistant(args);
    case 'app_get_personas': return handleGetPersonas();
    case 'app_create_persona': return handleCreatePersona(args);
    case 'app_update_persona': return handleUpdatePersona(args);
    case 'app_delete_persona': return handleDeletePersona(args);
    case 'app_get_sub_agents': return handleGetSubAgents();
    case 'app_create_sub_agent': return handleCreateSubAgent(args);
    case 'app_update_sub_agent': return handleUpdateSubAgent(args);
    case 'app_delete_sub_agent': return handleDeleteSubAgent(args);
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
    case 'app_end_interaction': return handleEndInteraction();
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
