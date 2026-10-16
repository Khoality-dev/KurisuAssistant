import { useEffect, useMemo, useState } from 'react';
import { usePersonaStore } from '@kurisu/state';
import { useAuthStore } from '@kurisu/state';
import { useConversationStore } from '@kurisu/state';
import { apiClient } from '@kurisu/api';
import type { Assistant, Tool, Skill } from '@kurisu/models';

export interface ContextBreakdown {
  system_prompt_tokens: number;
  memory_tokens: number;
  compacted_context_tokens: number;
  skills_tokens: number;
  tools_guidance_tokens: number;
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

/**
 * Estimate what the next turn's context will hold, mirroring the backend's
 * prompt assembly in `agents/main.py`. The two halves come from two places:
 * the persona in use supplies the identity block (name, system prompt,
 * preferred name) — or, with none, the assistant speaks as itself — and the
 * ASSISTANT supplies capability (memory, deferred-tool guidance, the tool
 * allow-list). `personaId` is the persona in use for the whole account
 * (#354): no conversation has one of its own.
 */
export function useContextBreakdown(opts: { personaId: number | null; enabled: boolean }): ContextBreakdown | null {
  const { personaId, enabled } = opts;

  const personas = usePersonaStore((s) => s.personas);
  const user = useAuthStore((s) => s.user);
  const messages = useConversationStore((s) => s.messages);
  const compactedContext = useConversationStore((s) => s.compactedContext);
  const compactedUpToId = useConversationStore((s) => s.compactedUpToId);

  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [assistant, setAssistant] = useState<Assistant | null>(null);

  useEffect(() => {
    if (!enabled) return;
    apiClient.listTools()
      .then((r) => setTools([...(r.server_tools || []), ...(r.mcp_tools || [])]))
      .catch(() => setTools([]));
    apiClient.listSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
    apiClient.getAssistant()
      .then(setAssistant)
      .catch(() => setAssistant(null));
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) return null;
    if (!assistant) return null;
    const persona = personaId === null ? null : personas.find((p) => p.id === personaId) ?? null;

    // System prompt — mirrors agents/main.py base_prompt assembly. Identity is
    // the persona in use, or the assistant itself (#302); the user's own prompt
    // and preferred name still apply.
    const sysParts: string[] = [persona ? `You are ${persona.name}.` : "You are the user's personal assistant."];
    if (persona?.system_prompt) sysParts.push(persona.system_prompt);
    if (user?.system_prompt) sysParts.push(user.system_prompt);
    const preferredName = persona?.preferred_name || user?.preferred_name;
    if (preferredName) sysParts.push(`The user prefers to be called: ${preferredName}`);
    sysParts.push(`Current time: ${new Date().toISOString()}`);
    const systemPromptText = sysParts.join('\n\n');

    // Memory — assistant-level: personas do not own memory
    const memoryText = assistant.memory_enabled && assistant.memory ? `Your memory:\n${assistant.memory}` : '';

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

    // Deferred-tools guidance — assistant-level
    const toolsGuidanceText = assistant.use_deferred_tools ? TOOLS_GUIDANCE_TEXT : '';

    // Message history above compaction watermark
    const visibleMessages = messages.filter((m) => (m.id ?? Infinity) > compactedUpToId);
    let messageHistoryTokens = 0;
    for (const m of visibleMessages) {
      messageHistoryTokens += toTokens(m.content) + toTokens(m.thinking);
    }

    // Tool schemas — JSON-stringified. Every tool is offered (#360); `read_only`
    // is the server's to read and not part of what a model is sent.
    const offered = tools.map(({ read_only: _readOnly, ...schema }) => schema);
    const toolSchemasJson = JSON.stringify(offered);
    const toolSchemasTokens = toTokens(toolSchemasJson);
    const loadedToolNames = tools.map((t) => t.function.name);

    const systemPromptTokens = toTokens(systemPromptText);
    const memoryTokens = toTokens(memoryText);
    const compactedContextTokens = toTokens(compactedText);
    const skillsTokens = toTokens(skillsText);
    const toolsGuidanceTokens = toTokens(toolsGuidanceText);

    const totalTokens = systemPromptTokens + memoryTokens + compactedContextTokens
      + skillsTokens + toolsGuidanceTokens
      + messageHistoryTokens + toolSchemasTokens;

    return {
      system_prompt_tokens: systemPromptTokens,
      memory_tokens: memoryTokens,
      compacted_context_tokens: compactedContextTokens,
      skills_tokens: skillsTokens,
      tools_guidance_tokens: toolsGuidanceTokens,
      message_history_tokens: messageHistoryTokens,
      message_count: visibleMessages.length,
      tool_schemas_tokens: toolSchemasTokens,
      tool_count: loadedToolNames.length,
      total_tokens: totalTokens,
      context_limit: user?.context_size || 8192,
      loaded_tools: loadedToolNames,
      loaded_skills: skillNames,
    };
  }, [enabled, personas, personaId, assistant, user, messages, compactedContext, compactedUpToId, tools, skills]);
}
