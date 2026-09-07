import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@kurisu/api';
import type { Tool } from '@kurisu/models';
import { buildToolGroups } from './ToolGroupChecklist';
import { requireAppTools, requireHostTools, resolveBridge } from '@kurisu/platform';
import { useCapabilities } from '@kurisu/hooks';

// Internal tools that shouldn't appear in the exclusion list
const INTERNAL_TOOLS = ['play_music', 'music_control', 'get_music_queue'];

/**
 * Every tool an assistant or a sub-agent can be allowed to call: the backend's
 * MCP + built-in tools, plus the client-side host/app tools this Electron
 * process exposes. Both the assistant form and the sub-agent form pick from the
 * same list, so it is assembled once here.
 */
export function useAvailableTools(onError?: (message: string) => void) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [mcpServerMap, setMcpServerMap] = useState<Record<string, string[]>>({});

  const loadTools = useCallback(async () => {
    try {
      const data = await apiClient.listTools();
      const allTools: Tool[] = [...data.mcp_tools, ...data.builtin_tools];
      // Build MCP server → tool name mapping for grouping
      const serverMap: Record<string, string[]> = {};
      if (data.mcp_servers) {
        for (const [serverName, serverTools] of Object.entries(data.mcp_servers)) {
          serverMap[serverName] = serverTools.map((t) => t.function.name);
        }
      }
      setMcpServerMap(serverMap);
      // Add client-side tools (host, app, browser) from Electron IPC
      if (resolveBridge().hostTools) {
        try { allTools.push(...(await requireHostTools().listTools() as Tool[])); } catch { /* optional */ }
      }
      if (resolveBridge().appTools) {
        try { allTools.push(...(await requireAppTools().listTools() as Tool[])); } catch { /* optional */ }
      }
      // Deduplicate by name and filter internal tools
      const seen = new Set<string>();
      setTools(allTools.filter((t) => {
        const name = t.function.name;
        if (seen.has(name) || INTERNAL_TOOLS.includes(name)) return false;
        seen.add(name);
        return true;
      }));
    } catch (err: any) {
      console.error('Failed to load tools:', err);
      onError?.(err?.message || 'Failed to load tools');
    }
  }, [onError]);

  useEffect(() => { void loadTools(); }, [loadTools]);

  const toolGroups = useMemo(() => buildToolGroups(tools, mcpServerMap), [tools, mcpServerMap]);

  // Whether this list is the whole set the assistant could be allowed.
  //
  // Host and app tools belong to whichever client is connected, so a client
  // without them cannot see — and must not silently drop — the ones another
  // client lends (#181).
  const { hostTools, hostApps } = useCapabilities();
  const complete = hostTools && hostApps;

  return { tools, toolGroups, complete, reloadTools: loadTools };
}
