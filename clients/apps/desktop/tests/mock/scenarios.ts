/**
 * Named starting states for the standalone mock backend (`cli.ts`).
 *
 * Each scenario is the same state one of the Playwright specs scripts by hand,
 * so what a person sees when driving a client against `npm run mock:backend`
 * is what the suite asserts on. Keep them in step: when a spec's script
 * changes shape, change the scenario that mirrors it.
 */

import type { MockBackend, MockBackendOptions, MockConversationSeed, StreamScript } from './server';

export interface Scenario {
  /** One line for `--list`. */
  description: string;
  /** Constructor options — personas, assistant, sub-agents, the stream script. */
  options: MockBackendOptions;
  /** Post-construction tweaks that only the setters can express. */
  apply?: (mock: MockBackend) => void;
}

/** The persona every scenario starts with; `settings.spec.ts` asserts the name. */
const KURISU = { id: 1, name: 'Kurisu', description: 'The default persona.' };
const AMADEUS = { id: 2, name: 'Amadeus', description: 'A second persona, for handoffs.' };

const SHORT_REPLY: StreamScript = {
  chunks: [
    { content: 'Hello ', role: 'assistant', delayMs: 40 },
    { content: 'from ', role: 'assistant', delayMs: 40 },
    { content: 'mock backend.', role: 'assistant', delayMs: 40 },
  ],
};

/**
 * The cast every picture in `clients/android/docs/screens.md` is taken from
 * (#195). One scenario furnishes all twelve screens, so a capture session is
 * one command and the next person gets the same app.
 *
 * Invented, like every other fixture here: these end up in a public repo, so no
 * persona, prompt, transcript or skill below comes from a real install. The
 * built-in tool descriptions are the exception and are copied verbatim from
 * `backend/kurisuassistant/tools/`, because that screen documents the backend's
 * own words.
 */
const DOCS_PERSONAS = [
  {
    id: 1,
    name: 'Kurisu',
    description: 'Dry, precise, allergic to hand-waving.',
    system_prompt: 'You are Kurisu. Be precise and a little sharp. Never pad an answer to sound thorough.',
    preferred_name: 'Okabe',
  },
  {
    id: 2,
    name: 'Coach',
    description: 'Warm, direct, keeps you moving.',
    system_prompt: 'You are Coach. Encourage briefly, then give the next concrete step. No lectures.',
    preferred_name: 'champ',
  },
  {
    id: 3,
    name: 'Archivist',
    description: 'Answers from what was actually said.',
    system_prompt: 'You are the Archivist. Quote the record. If it is not in the history, say so plainly.',
  },
];

const DOCS_ASSISTANT = {
  model_name: 'qwen3:8b',
  provider_type: 'ollama',
  // null is "every tool", which is what the Assistant screen prints.
  available_tools: null,
  think: true,
  use_deferred_tools: false,
  memory:
    'Prefers short answers, with the reasoning shown only when it changes the conclusion.\n'
    + 'Works in a monorepo: backend (FastAPI), desktop (Electron), android (Compose).',
  memory_enabled: true,
  trigger_word: 'kurisu',
  default_persona_id: 1,
};

const DOCS_SUB_AGENTS = [
  {
    id: 10,
    name: 'code-reader',
    description: 'Reads a file and reports what it actually does.',
    model_name: 'qwen3:4b',
    provider_type: 'ollama',
    available_tools: ['history_read', 'recall_regex'],
    think: true,
  },
  {
    id: 11,
    name: 'summariser',
    description: 'Collapses a long transcript into the decisions taken.',
    model_name: 'qwen3:1.7b',
    provider_type: 'ollama',
    available_tools: ['history_list'],
  },
];

const DOCS_MCP_SERVERS = [
  {
    id: 1,
    name: 'filesystem',
    transport_type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/workspace'],
    location: 'client' as const,
  },
  {
    id: 2,
    name: 'search',
    transport_type: 'sse' as const,
    url: 'http://127.0.0.1:8931/sse',
    location: 'server' as const,
  },
];

/** Verbatim from `backend/kurisuassistant/tools/` — that screen quotes the backend. */
const DOCS_TOOLS = {
  builtin: [
    {
      name: 'history_list',
      description:
        'List past conversations with titles, compacted summaries, message counts, and timestamps. '
        + 'Returns most recent first. Use to find which conversation to read in detail.',
      builtin: true,
    },
    {
      name: 'history_read',
      description:
        'Read messages from a specific past conversation. Use history_list first to find the '
        + 'conversation_id, then read it in detail.',
      builtin: true,
    },
    {
      name: 'recall_regex',
      description:
        'Search everything the user said or wrote before — past conversations and the files in '
        + 'their drive — with a case-insensitive regular expression. Returns matching passages '
        + 'newest first, quoted verbatim, each with its source.',
      builtin: true,
    },
    {
      name: 'recall_semantic',
      description:
        'Search past conversations and the files in the user\'s drive by meaning: describe what '
        + 'you are looking for and get the passages closest to it, even when the original used '
        + 'different words.',
      builtin: true,
    },
    {
      name: 'get_skill_instructions',
      description:
        'Get the full instructions for a skill by name. Call this before performing a task when a '
        + 'relevant skill is listed in the system prompt.',
      builtin: true,
    },
  ],
  mcp: [
    { name: 'fs_read_file', description: 'Read a file from the workspace.' },
    { name: 'fs_list_dir', description: 'List a workspace directory.' },
  ],
};

const DOCS_SKILLS = [
  {
    id: 1,
    name: 'Concise replies',
    instructions:
      'Answer in at most five sentences unless asked to expand. Lead with the conclusion, then the reason.',
  },
  {
    id: 2,
    name: 'Cite the file',
    instructions: 'When you describe code behaviour, name the file and line you read it from.',
  },
];

const DOCS_MODELS = [
  { name: 'qwen3:8b', provider: 'ollama' },
  { name: 'qwen3:4b', provider: 'ollama' },
  { name: 'qwen3:1.7b', provider: 'ollama' },
];

/**
 * The ages are chosen to exercise every branch of a relative-time label —
 * minutes, hours, days, and old enough to fall back to a date. The first one
 * carries the transcript the "A conversation" picture is taken from, tool rail
 * included, so opening the top row is the whole of that capture step.
 */
const DOCS_CONVERSATIONS: MockConversationSeed[] = [
  {
    title: 'Splitting persona from assistant',
    persona: 'Kurisu',
    agoMinutes: 14,
    messages: [
      {
        role: 'user',
        content: 'If a persona has no model of its own, what actually changes when I switch one?',
      },
      {
        role: 'assistant',
        content:
          'The voice changes and nothing else does. A persona owns the name, the system prompt, '
          + 'the preferred name and the voice. The model, the tool set and the memory belong to '
          + 'the assistant, so they are identical whichever persona is answering.',
      },
      { role: 'user', content: 'Show me where that is enforced.' },
      {
        role: 'tool',
        name: 'recall_regex',
        args: { pattern: 'personas table columns' },
        status: 'success',
        content:
          'personas table: id, user_id, name, description, system_prompt, voice_reference, '
          + 'avatar_uuid, character_config, preferred_name, enabled. No model_name, no '
          + 'available_tools, no memory.',
      },
      {
        role: 'assistant',
        content:
          'In the schema itself. The personas table has no model_name, no available_tools and no '
          + 'memory column at all \u2014 so a persona cannot carry capability even by accident. The '
          + 'migration drops those columns rather than leaving them nullable.',
      },
    ],
  },
  {
    title: 'Getting back into a morning routine',
    persona: 'Coach',
    agoMinutes: 5 * 60,
    messages: [
      { role: 'user', content: 'I keep sleeping through the alarm.' },
      {
        role: 'assistant',
        content: 'Start smaller than feels worth doing. Tomorrow: up, water, ten minutes outside. Nothing else.',
      },
    ],
  },
  {
    title: 'What did we decide about the wake word?',
    persona: 'Archivist',
    agoMinutes: 4 * 24 * 60,
    messages: [
      { role: 'user', content: 'Does each persona get its own?' },
      {
        role: 'assistant',
        content:
          'No. The wake word belongs to the assistant and selects nobody \u2014 whoever the '
          + 'conversation is bound to answers it.',
      },
    ],
  },
  {
    title: 'Reading the migration chain',
    persona: 'Kurisu',
    agoMinutes: 9 * 24 * 60,
    messages: [
      { role: 'user', content: 'Does the persona split drop the old table?' },
      {
        role: 'assistant',
        content: 'It renames the table rather than recreating it, which is why the ids survive the upgrade.',
      },
    ],
  },
];

export const SCENARIOS: Record<string, Scenario> = {
  default: {
    description: 'Two personas (Kurisu answers), a model chosen, a short streamed reply.',
    options: { personas: [KURISU, AMADEUS], stream: SHORT_REPLY },
  },
  docs: {
    description: 'The cast the documentation screenshots are taken from — every screen furnished.',
    options: {
      personas: DOCS_PERSONAS,
      assistant: DOCS_ASSISTANT,
      subAgents: DOCS_SUB_AGENTS,
      mcpServers: DOCS_MCP_SERVERS,
      tools: DOCS_TOOLS,
      skills: DOCS_SKILLS,
      models: DOCS_MODELS,
      conversations: DOCS_CONVERSATIONS,
      stream: SHORT_REPLY,
    },
  },
  'tool-call': {
    // streaming.spec.ts: "assistant text and tool output both render when a tool call interrupts"
    description: 'Assistant text interrupted by a tool result, then the answer.',
    options: {
      personas: [KURISU, AMADEUS],
      tools: { builtin: [{ name: 'lookup', description: 'Look a value up.', builtin: true }] },
      stream: {
        chunks: [
          { content: 'Let me check. ', role: 'assistant', delayMs: 150 },
          {
            content: '{"result":"42"}', role: 'tool', delayMs: 150,
            name: 'lookup', toolKind: 'tool', durationMs: 87,
            toolArgs: { key: 'answer' }, toolStatus: 'success',
          },
          { content: 'The result is 42.', role: 'assistant', delayMs: 150 },
        ],
      },
    },
  },
  'sub-agent': {
    description: 'A step delegated to a sub-agent mid-answer (the sub-agent tag and duration).',
    options: {
      personas: [KURISU, AMADEUS],
      subAgents: [{ id: 1, name: 'Researcher', description: 'Reads things.', model_name: 'worker-model' }],
      stream: {
        chunks: [
          { content: 'Delegating. ', role: 'assistant', delayMs: 150 },
          {
            content: 'Researcher: nothing new since yesterday.', role: 'tool', delayMs: 400,
            name: 'Researcher', toolKind: 'sub_agent', durationMs: 1830,
            toolArgs: { task: 'check the news' }, toolStatus: 'success',
          },
          { content: 'Nothing new, then.', role: 'assistant', delayMs: 150 },
        ],
      },
    },
  },
  handoff: {
    // streaming.spec.ts: "a persona handoff mid-stream splits the assistant text"
    description: 'Kurisu starts the answer and Amadeus finishes it — two bubbles, two speakers.',
    options: {
      personas: [KURISU, AMADEUS],
      stream: {
        chunks: [
          { content: 'Kurisu speaking.', role: 'assistant', delayMs: 150 },
          { content: 'Amadeus speaking.', role: 'assistant', delayMs: 150, personaId: AMADEUS.id },
        ],
      },
    },
  },
  thinking: {
    // streaming.spec.ts: "thinking chunks render collapsible"
    description: 'A thinking chunk before the answer (the collapsible "Thinking" block).',
    options: {
      personas: [KURISU, AMADEUS],
      stream: {
        chunks: [
          { content: '', thinking: 'Let me consider this carefully. ', role: 'assistant', delayMs: 10 },
          { content: 'Final answer is X.', role: 'assistant', delayMs: 10 },
        ],
      },
    },
  },
  slow: {
    // streaming.spec.ts: "cancel during stream preserves partial content"
    description: 'One chunk every 400 ms for a while — long enough to press Stop.',
    options: {
      personas: [KURISU, AMADEUS],
      stream: {
        chunks: Array.from({ length: 20 }, (_, i) => ({
          content: `word${i + 1} `, role: 'assistant' as const, delayMs: 400,
        })),
      },
    },
  },
  'no-model': {
    // firstRun.spec.ts: a brand-new account whose model has never been chosen.
    description: 'A fresh account with no model chosen: the first message is refused with NO_MODEL_SELECTED.',
    options: { personas: [KURISU, AMADEUS], stream: SHORT_REPLY },
    apply: (mock) => mock.setAssistantModel(null),
  },
};

export const DEFAULT_SCENARIO = 'default';

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}
