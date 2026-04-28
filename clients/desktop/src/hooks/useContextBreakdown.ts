import { useEffect, useMemo, useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { useAuthStore } from '../store/authStore';
import { useConversationStore } from '../store/conversationStore';
import { apiClient } from '../api/client';
import type { Tool, Skill } from '../api/types';

export interface ContextBreakdown {
  system_prompt_tokens: number;
  memory_tokens: number;
  compacted_context_tokens: number;
  skills_tokens: number;
  tools_guidance_tokens: number;
  other_agents_tokens: number;
  message_history_tokens: number;
  message_count: number;
  tool_schemas_tokens: number;
  tool_count: number;
  total_tokens: number;
  context_limit: number;
  loaded_tools: string[];
  loaded_skills: string[];
}

const wc = (s: string | null | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);
const toTokens = (s: string | null | undefined) => Math.round(wc(s) * 1.3);

const TOOLS_GUIDANCE_TEXT =
  '## Tool Usage\n' +
  'You have access to tools through a discovery system. Use these functions:\n' +
  '1. list_tools(page?) — Browse available tools (name + description, paginated)\n' +
  '2. search_tools(query) — Search tools by keyword in name or description\n' +
  '3. get_tool_schema(name) — Get a tool\'s full parameter schema before calling it\n' +
  '4. call_tool(name, arguments) — Execute a tool\n\n' +
  'Workflow: list_tools or search_tools → get_tool_schema → call_tool.\n' +
  'You may skip discovery if you already know the tool name from context or a previous turn.';

function subAgentToolName(agentName: string): string {
  return agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    + '_agent';
}

export function useContextBreakdown(opts: { agentId: number | null; enabled: boolean }): ContextBreakdown | null {
  const { agentId, enabled } = opts;

  const agents = useAgentStore((s) => s.agents);
  const user = useAuthStore((s) => s.user);
  const messages = useConversationStore((s) => s.messages);
  const compactedContext = useConversationStore((s) => s.compactedContext);
  const compactedUpToId = useConversationStore((s) => s.compactedUpToId);

  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  useEffect(() => {
    if (!enabled) return;
    apiClient.listTools()
      .then((r) => setTools([...(r.builtin_tools || []), ...(r.mcp_tools || [])]))
      .catch(() => setTools([]));
    apiClient.listSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) return null;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return null;

    // System prompt — mirrors agents/main.py base_prompt assembly
    const sysParts: string[] = [`You are ${agent.name}.`];
    if (agent.system_prompt) sysParts.push(agent.system_prompt);
    if (user?.system_prompt) sysParts.push(user.system_prompt);
    const preferredName = agent.preferred_name || user?.preferred_name;
    if (preferredName) sysParts.push(`The user prefers to be called: ${preferredName}`);
    sysParts.push(`Current time: ${new Date().toISOString()}`);
    const systemPromptText = sysParts.join('\n\n');

    // Memory
    const memoryText = agent.memory_enabled && agent.memory ? `Your memory:\n${agent.memory}` : '';

    // Compacted context (rolling summary)
    const compactedText = compactedContext ? `Conversation context:\n${compactedContext}` : '';

    // Skills — same wording as backend
    const skillNames = skills.map((s) => s.name);
    const skillsText = skillNames.length > 0
      ? '## Skills\n'
      + `You have the following skills: ${skillNames.join(', ')}.\n`
      + 'Skills contain detailed instructions on HOW to perform specific tasks. '
      + 'You MUST call get_skill_instructions to load the relevant skill\'s instructions BEFORE '
      + 'attempting any task that matches a skill name. Do NOT guess or improvise — '
      + 'always read the skill first and follow its instructions exactly.'
      : '';

    // Deferred-tools guidance
    const toolsGuidanceText = agent.use_deferred_tools ? TOOLS_GUIDANCE_TEXT : '';

    // Sub-agents (main agents only)
    let subAgentsText = '';
    if (agent.agent_type === 'main') {
      const subs = agents.filter((a) => a.agent_type === 'sub' && a.enabled);
      if (subs.length > 0) {
        const lines = subs.map((sa) => {
          const tn = subAgentToolName(sa.name);
          const desc = (sa.description || (sa.system_prompt || '').slice(0, 150) || 'specialized worker').trim();
          return `- \`${tn}\` — ${sa.name}: ${desc}`;
        });
        subAgentsText =
          '## Available Sub-Agents\n'
          + 'You can delegate specialized tasks by calling these sub-agent tools:\n'
          + lines.join('\n')
          + '\n\nDelegate when a sub-agent is clearly suited to the task; '
          + 'otherwise handle it yourself.';
      }
    }

    // Message history above compaction watermark
    const visibleMessages = messages.filter((m) => (m.id ?? Infinity) > compactedUpToId);
    let messageHistoryTokens = 0;
    for (const m of visibleMessages) {
      messageHistoryTokens += toTokens(m.content) + toTokens(m.thinking);
    }

    // Tool schemas — JSON-stringified, optionally filtered to agent.available_tools
    let allowedTools = tools;
    if (Array.isArray(agent.available_tools)) {
      const allowed = new Set(agent.available_tools);
      allowedTools = tools.filter((t) => allowed.has(t.function.name));
    }
    const toolSchemasJson = JSON.stringify(allowedTools);
    const toolSchemasTokens = toTokens(toolSchemasJson);
    const loadedToolNames = allowedTools.map((t) => t.function.name);

    const systemPromptTokens = toTokens(systemPromptText);
    const memoryTokens = toTokens(memoryText);
    const compactedContextTokens = toTokens(compactedText);
    const skillsTokens = toTokens(skillsText);
    const toolsGuidanceTokens = toTokens(toolsGuidanceText);
    const otherAgentsTokens = toTokens(subAgentsText);

    const totalTokens = systemPromptTokens + memoryTokens + compactedContextTokens
      + skillsTokens + toolsGuidanceTokens + otherAgentsTokens
      + messageHistoryTokens + toolSchemasTokens;

    return {
      system_prompt_tokens: systemPromptTokens,
      memory_tokens: memoryTokens,
      compacted_context_tokens: compactedContextTokens,
      skills_tokens: skillsTokens,
      tools_guidance_tokens: toolsGuidanceTokens,
      other_agents_tokens: otherAgentsTokens,
      message_history_tokens: messageHistoryTokens,
      message_count: visibleMessages.length,
      tool_schemas_tokens: toolSchemasTokens,
      tool_count: loadedToolNames.length,
      total_tokens: totalTokens,
      context_limit: user?.context_size || 8192,
      loaded_tools: loadedToolNames,
      loaded_skills: skillNames,
    };
  }, [enabled, agents, agentId, user, messages, compactedContext, compactedUpToId, tools, skills]);
}
