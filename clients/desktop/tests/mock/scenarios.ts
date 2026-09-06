/**
 * Named starting states for the standalone mock backend (`cli.ts`).
 *
 * Each scenario is the same state one of the Playwright specs scripts by hand,
 * so what a person sees when driving a client against `npm run mock:backend`
 * is what the suite asserts on. Keep them in step: when a spec's script
 * changes shape, change the scenario that mirrors it.
 */

import type { MockBackend, MockBackendOptions, StreamScript } from './server';

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

export const SCENARIOS: Record<string, Scenario> = {
  default: {
    description: 'Two personas (Kurisu answers), a model chosen, a short streamed reply.',
    options: { personas: [KURISU, AMADEUS], stream: SHORT_REPLY },
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
