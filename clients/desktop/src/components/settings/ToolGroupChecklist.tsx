import React, { useState, useMemo } from 'react';
import {
  Box,
  Typography,
  Chip,
  Checkbox,
  Collapse,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import type { Tool } from '../../api/types';

// Tool group definitions — maps tool name prefixes/exact names to group labels
export const TOOL_GROUP_MAP: Record<string, string> = {
  history_list: 'History',
  history_read: 'History',
  history_search: 'History',
  notes_list: 'Notes',
  notes_read: 'Notes',
  notes_write: 'Notes',
  notes_edit: 'Notes',
  notes_delete: 'Notes',
  notes_search: 'Notes',
  get_skill_instructions: 'Skills',
  host_read: 'Host',
  host_write: 'Host',
  host_edit: 'Host',
  host_search: 'Host',
  host_list: 'Host',
  host_bash: 'Host',
  app_get_agents: 'App',
  app_create_agent: 'App',
  app_update_agent: 'App',
  app_delete_agent: 'App',
  app_list_mcp_servers: 'App',
  app_add_mcp_server: 'App',
  app_update_mcp_server: 'App',
  app_delete_mcp_server: 'App',
  app_list_skills: 'App',
  app_create_skill: 'App',
  app_update_skill: 'App',
  app_delete_skill: 'App',
  app_list_tools: 'App',
  app_vision_start: 'App',
  app_vision_stop: 'App',
  app_launch_browser: 'App',
  app_open_file: 'App',
  app_open_folder: 'App',
  app_get_open_files: 'App',
  app_navigate: 'App',
};

export interface ToolGroup {
  name: string;
  tools: Tool[];
  isMcp?: boolean;
}

export function getToolGroup(toolName: string, mcpServerMap: Record<string, string[]>): string {
  if (TOOL_GROUP_MAP[toolName]) return TOOL_GROUP_MAP[toolName];
  // Check MCP server grouping
  for (const [serverName, toolNames] of Object.entries(mcpServerMap)) {
    if (toolNames.includes(toolName)) return serverName;
  }
  return 'Other';
}

export function buildToolGroups(tools: Tool[], mcpServerMap: Record<string, string[]>): ToolGroup[] {
  const mcpServerNames = new Set(Object.keys(mcpServerMap));
  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    const groupName = getToolGroup(tool.function.name, mcpServerMap);
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(tool);
  }
  // Sort: known groups first in stable order, then MCP servers, then Other
  const knownOrder = ['History', 'Notes', 'Skills', 'Host', 'App'];
  const sorted: ToolGroup[] = [];
  for (const name of knownOrder) {
    const tools = groups.get(name);
    if (tools) {
      sorted.push({ name, tools });
      groups.delete(name);
    }
  }
  // Remaining groups (MCP servers, Other) sorted alphabetically
  const remaining = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, tools] of remaining) {
    sorted.push({ name, tools, isMcp: mcpServerNames.has(name) });
  }
  return sorted;
}

// Grouped tool checklist component
export const ToolGroupChecklist: React.FC<{
  groups: ToolGroup[];
  excludedTools: string[];
  onChange: (excludedTools: string[]) => void;
}> = ({ groups, excludedTools, onChange }) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const excludedSet = useMemo(() => new Set(excludedTools), [excludedTools]);

  const toggleExpand = (groupName: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const toggleTool = (toolName: string) => {
    if (excludedSet.has(toolName)) {
      onChange(excludedTools.filter(t => t !== toolName));
    } else {
      onChange([...excludedTools, toolName]);
    }
  };

  const toggleGroup = (group: ToolGroup) => {
    const toolNames = group.tools.map(t => t.function.name);
    const allEnabled = toolNames.every(n => !excludedSet.has(n));
    if (allEnabled) {
      // Disable all in group
      onChange([...excludedTools, ...toolNames.filter(n => !excludedSet.has(n))]);
    } else {
      // Enable all in group
      onChange(excludedTools.filter(t => !toolNames.includes(t)));
    }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      {groups.map((group) => {
        const toolNames = group.tools.map(t => t.function.name);
        const enabledCount = toolNames.filter(n => !excludedSet.has(n)).length;
        const allEnabled = enabledCount === toolNames.length;
        const noneEnabled = enabledCount === 0;
        const isExpanded = expandedGroups.has(group.name);

        return (
          <Box key={group.name}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                px: 1.5,
                py: 0.5,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
                borderBottom: '1px solid',
                borderColor: 'divider',
              }}
              onClick={() => toggleExpand(group.name)}
            >
              <Checkbox
                size="small"
                checked={allEnabled}
                indeterminate={!allEnabled && !noneEnabled}
                onClick={(e) => { e.stopPropagation(); toggleGroup(group); }}
                sx={{ mr: 0.5 }}
              />
              <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
                {group.name}
              </Typography>
              {group.isMcp && (
                <Chip label="MCP" size="small" color="info" variant="outlined" sx={{ mr: 0.5, height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.65rem' } }} />
              )}
              <Chip label={`${enabledCount}/${toolNames.length}`} size="small" variant="outlined" sx={{ mr: 1, height: 20, '& .MuiChip-label': { px: 1, fontSize: '0.7rem' } }} />
              {isExpanded ? <ExpandLessIcon fontSize="small" color="action" /> : <ExpandMoreIcon fontSize="small" color="action" />}
            </Box>
            <Collapse in={isExpanded}>
              {group.tools.map((tool) => {
                const name = tool.function.name;
                const enabled = !excludedSet.has(name);
                return (
                  <Box
                    key={name}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      pl: 4,
                      pr: 1.5,
                      py: 0.25,
                      '&:hover': { bgcolor: 'action.hover' },
                      cursor: 'pointer',
                      borderBottom: '1px solid',
                      borderColor: 'divider',
                    }}
                    onClick={() => toggleTool(name)}
                  >
                    <Checkbox size="small" checked={enabled} sx={{ mt: -0.25, mr: 0.5 }} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>{name}</Typography>
                      {tool.function.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.3 }}>
                          {tool.function.description.length > 100 ? tool.function.description.slice(0, 100) + '...' : tool.function.description}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              })}
            </Collapse>
          </Box>
        );
      })}
    </Box>
  );
};
