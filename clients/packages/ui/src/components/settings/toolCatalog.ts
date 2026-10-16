import type { Tool } from '@kurisu/models';

/**
 * What Settings › Tools lists (#360): every tool the assistant has, by where it
 * runs. Nothing here switches a tool on or off — every tool is always offered,
 * and the permission mode beside the chat input decides which calls wait. Each
 * tool is tagged by whether it only looks, which is what Read only runs; a tool
 * that does not say counts as changing something.
 */
export type ToolEffect = 'reads' | 'changes';

export interface CatalogTool {
  name: string;
  description: string;
  effect: ToolEffect;
  tool: Tool;
}

export interface CatalogGroup {
  id: string;
  name: string;
  tools: CatalogTool[];
}

export interface ToolCatalog {
  /** The server's own tools, by feature: available from every device. */
  kurisu: CatalogGroup[];
  /** What this desktop lends while it is connected: host, app, local MCP servers. */
  desktop: CatalogGroup[];
  /** The user's server-side MCP servers' tools, by server name. */
  mcp: Record<string, CatalogTool[]>;
}

export interface ToolCatalogInput {
  serverTools: Tool[];
  mcpServers: Record<string, Tool[]>;
  /** This desktop's host and app tools. */
  clientTools: Tool[];
  /** This desktop's local MCP servers' tools, by server name. */
  clientToolsByServer: Record<string, Tool[]>;
}

const KURISU_GROUPS: { id: string; name: string; matches: (name: string) => boolean }[] = [
  { id: 'calendar', name: 'Calendar', matches: (n) => n.startsWith('calendar_') },
  { id: 'tasks', name: 'Tasks', matches: (n) => n.startsWith('task_') },
  { id: 'drive', name: 'Kurisu Drive', matches: (n) => n.startsWith('drive_') },
  { id: 'memory', name: 'History and recall', matches: (n) => n.startsWith('history_') || n.startsWith('recall_') },
];

const toCatalogTool = (tool: Tool): CatalogTool => ({
  name: tool.function.name,
  description: tool.function.description || '',
  effect: tool.read_only === true ? 'reads' : 'changes',
  tool,
});

export function buildToolCatalog(input: ToolCatalogInput): ToolCatalog {
  const kurisu: CatalogGroup[] = KURISU_GROUPS.map((g) => ({ id: g.id, name: g.name, tools: [] as CatalogTool[] }));
  const other: CatalogGroup = { id: 'other', name: 'Other', tools: [] };
  for (const tool of input.serverTools) {
    const at = KURISU_GROUPS.findIndex((g) => g.matches(tool.function.name));
    (at === -1 ? other : kurisu[at]).tools.push(toCatalogTool(tool));
  }

  const host: CatalogGroup = { id: 'host', name: 'Files and commands', tools: [] };
  const app: CatalogGroup = { id: 'app', name: 'App control', tools: [] };
  for (const tool of input.clientTools) {
    (tool.function.name.startsWith('host_') ? host : app).tools.push(toCatalogTool(tool));
  }
  const localServers: CatalogGroup[] = Object.entries(input.clientToolsByServer).map(([name, tools]) => ({
    id: `local:${name}`,
    name,
    tools: tools.map(toCatalogTool),
  }));

  const mcp: Record<string, CatalogTool[]> = {};
  for (const [name, tools] of Object.entries(input.mcpServers)) mcp[name] = tools.map(toCatalogTool);

  const nonEmpty = (groups: CatalogGroup[]) => groups.filter((g) => g.tools.length > 0);
  return {
    kurisu: nonEmpty([...kurisu, other]),
    desktop: [...nonEmpty([host, app]), ...localServers.filter((g) => g.tools.length > 0)],
    mcp,
  };
}

/** Whether a tool matches the search box: by name or description, case-insensitively. */
export function matchesQuery(tool: CatalogTool, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q);
}
