/**
 * Mock backend for Playwright E2E tests.
 *
 * Implements the minimum HTTP + WebSocket surface the renderer hits on startup
 * and during a chat round-trip. All responses are deterministic so tests can
 * assert on concrete values.
 *
 * Shapes here mirror wire protocol 4: ONE assistant per user owns capability
 * (model, provider, tools, think, deferred tools, memory, wake word) and MANY
 * personas own presentation (name, prompt, voice, avatar, character config).
 * Sub-agents are task-only workers with no identity. If a field here disagrees
 * with `backend/kurisuassistant/`, the backend wins — fix the mock.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import {
  WIRE_PROTOCOL,
  WS_AUTH_SUBPROTOCOL,
  WS_WIRE_SUBPROTOCOL_PREFIX,
  WS_WIRE_PROTOCOL_MISMATCH,
} from '@kurisu/models';

/** Presentation only: no model, no tools, no memory, no wake word. */
export interface MockPersona {
  id: number;
  name: string;
  description?: string;
  system_prompt?: string;
  preferred_name?: string | null;
  voice_reference?: string | null;
  avatar_uuid?: string | null;
  character_config?: Record<string, unknown> | null;
  enabled?: boolean;
}

/** Capability only, and exactly one of them. No name, no avatar, no voice. */
export interface MockAssistant {
  id?: number;
  model_name?: string | null;
  provider_type?: string;
  available_tools?: string[] | null; // null = every tool
  think?: boolean;
  use_deferred_tools?: boolean;
  memory?: string | null;
  memory_enabled?: boolean;
  /** Voice wake word. It wakes the assistant and selects no persona. */
  trigger_word?: string | null;
  /** Persona a new conversation silently binds to. */
  default_persona_id?: number | null;
}

/** A task-only worker: its own model and tools, no identity of any kind. */
export interface MockSubAgent {
  id: number;
  name: string;
  description?: string;
  system_prompt?: string;
  model_name?: string | null;
  provider_type?: string;
  available_tools?: string[] | null;
  think?: boolean;
  use_deferred_tools?: boolean;
  enabled?: boolean;
}

/**
 * One scripted `stream_chunk`.
 *
 * An assistant chunk speaks as a persona: leave `personaId`/`personaName` unset
 * and it speaks as the conversation's bound persona. Setting them mid-script is
 * how a handoff is scripted — the client splits bubbles on the speaker label, so
 * varying only `role` never exercises that path.
 *
 * A tool chunk is not the persona talking: `persona_id`/`persona_name` go out as
 * null and `name` carries the tool's own label, exactly as the backend sends it.
 */
export interface StreamChunk {
  content: string;
  thinking?: string;
  role?: 'assistant' | 'tool' | string;
  delayMs?: number;
  /** Assistant chunks: speak as this persona instead of the bound one. */
  personaId?: number;
  personaName?: string;
  /** Tool chunks: the tool's own label. */
  name?: string;
  toolArgs?: Record<string, unknown> | null;
  toolStatus?: 'success' | 'error' | 'denied' | string;
  /**
   * Tool chunks only. The server emits a tool chunk after the call returns, so
   * a client can neither time the call nor tell a delegation from an ordinary
   * tool call — these two fields are its only source for both.
   */
  toolKind?: 'tool' | 'sub_agent';
  durationMs?: number;
}

export interface StreamScript {
  chunks: StreamChunk[];
}

/**
 * What `/version` and the 426 body report as `backend_version`. Exported so a
 * spec asserting on the update screen does not hard-code it — the number moves
 * with the backend, and the screen's copy is what those tests are about.
 */
export const MOCK_BACKEND_VERSION = '0.5.0';

// Defaults mimic a real LLM emitting tokens every ~40ms (Ollama-ish).
const DEFAULT_STREAM: StreamScript = {
  chunks: [
    { content: 'Hello ', role: 'assistant', delayMs: 40 },
    { content: 'from ', role: 'assistant', delayMs: 40 },
    { content: 'mock backend.', role: 'assistant', delayMs: 40 },
  ],
};

export interface MockTool {
  name: string;
  description: string;
  builtin?: boolean;
}

/**
 * One entry in the mock's Kurisu Drive, given as a path.
 *
 * Paths rather than parent ids, because a spec wants to say "there is a
 * /Reports/Q3.md" without inventing a tree first; the mock builds the folders.
 */
export interface MockDriveEntry {
  path: string;
  content?: string;
  isDir?: boolean;
}

/**
 * A conversation to start the mock with, so a client has a list to show before
 * anyone has chatted into it (#194).
 *
 * `agoMinutes` is when the LAST message landed — the only age a list orders and
 * labels by. Earlier messages are spaced a minute apart behind it.
 */
export interface MockConversationSeed {
  title: string;
  /** Who answers it, by persona name. Omitted leaves the conversation unbound. */
  persona?: string;
  agoMinutes: number;
  /** Oldest first. An assistant message is attributed to `persona`. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface MockBackendOptions {
  personas?: MockPersona[];
  conversations?: MockConversationSeed[];
  drive?: MockDriveEntry[];
  driveQuotaBytes?: number;
  assistant?: MockAssistant;
  subAgents?: MockSubAgent[];
  stream?: StreamScript;
  tools?: { mcp?: MockTool[]; builtin?: MockTool[] };
  mcpServers?: Array<Partial<{
    id: number; name: string; transport_type: 'sse' | 'stdio'; url: string | null;
    command: string | null; args: string[] | null; env: Record<string, string> | null;
    enabled: boolean; location: 'server' | 'client';
  }>>;
}

interface StoredMessage {
  id: number;
  role: string;
  content: string;
  thinking: string | null;
  /** Set on assistant messages only; a tool message has no speaker. */
  persona_id: number | null;
  name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_status: string | null;
  created_at: string;
}

interface StoredConversation {
  id: number;
  title: string;
  /** null until the first message binds a persona. */
  persona_id: number | null;
  created_at: string;
  updated_at: string;
  compacted_context: string;
  /** Messages at or below this id are covered by `compacted_context` (#99). */
  compacted_up_to_id: number;
  messages: StoredMessage[];
}

type ResolvedPersona = Required<Pick<MockPersona, 'id' | 'name'>> & MockPersona;

export class MockBackend {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private _port: number = 0;
  private personas: ResolvedPersona[];
  private assistant: Required<MockAssistant>;
  private subAgents: MockSubAgent[];
  private stream: StreamScript;
  private nextConversationId = 1;
  private nextMessageId = 1;
  private nextMcpServerId = 1;
  private conversations: Map<number, StoredConversation> = new Map();
  private mcpServers: Array<{
    id: number; name: string; transport_type: 'sse' | 'stdio'; url: string | null;
    command: string | null; args: string[] | null; env: Record<string, string> | null;
    enabled: boolean; location: 'server' | 'client'; created_at: string;
  }> = [];
  private tools: { mcp: MockTool[]; builtin: MockTool[] };
  /**
   * Last turn this backend ran, reported back on `connected` the way the real
   * server does — its session outlives a single socket, so a client that drops
   * and reconnects learns which conversation ran and who was speaking.
   */
  private lastTurn: { conversationId: number | null; personaId: number | null } = {
    conversationId: null,
    personaId: null,
  };
  /**
   * The wire protocol this backend speaks. Defaults to the client's own so the
   * suite boots; a spec sets another to drive the update-required gate — over
   * `/version`, a 426 on every other request, and 4426 on the socket (#150).
   */
  private wireProtocol: number = WIRE_PROTOCOL;
  /** Endpoints answering 502 as if the service behind them were down (#151). */
  private unreachable: Set<'/tts/models' | '/models'> = new Set();
  /** The mock's drive: flat rows with parent links, as the real table is. */
  private driveNodes: Array<{
    id: number; parent_id: number | null; name: string; is_dir: boolean;
    size: number; mime: string | null; checksum: string | null;
    created_at: string; updated_at: string; content: Buffer;
  }> = [];
  private nextDriveId = 1;
  private driveQuotaBytes = 15 * 1024 * 1024 * 1024;
  /** The most recent upload, so a spec can assert what was sent. */
  public lastDriveUpload: { name: string; parent_id: number | null; bytes: number } | null = null;

  public lastChatRequest: any = null;
  public lastMcpServerCreate: any = null;
  /** Body of the most recent `PATCH /conversations/{id}`, with the id it hit. */
  public lastConversationPatch: { id: number; body: any } | null = null;

  constructor(opts: MockBackendOptions = {}) {
    // The default persona is named "Kurisu": settings.spec.ts asserts that name
    // is on screen, so renaming it here breaks that test.
    this.personas = (opts.personas ?? [{ id: 1, name: 'Kurisu' }]).map((p) => ({
      description: '',
      system_prompt: '',
      preferred_name: null,
      voice_reference: null,
      avatar_uuid: null,
      character_config: null,
      enabled: true,
      ...p,
    }));

    const assistant = opts.assistant ?? {};
    this.assistant = {
      id: assistant.id ?? 1,
      // `?? ` would swallow an explicit null, and null is the state under test:
      // a fresh account whose model has never been chosen. Only an omitted field
      // gets the default.
      model_name: assistant.model_name === undefined ? 'test-model' : assistant.model_name,
      provider_type: assistant.provider_type ?? 'mock',
      available_tools: assistant.available_tools ?? null,
      think: assistant.think ?? false,
      use_deferred_tools: assistant.use_deferred_tools ?? false,
      memory: assistant.memory ?? null,
      memory_enabled: assistant.memory_enabled ?? true,
      // Non-optional on the client's `Assistant` type. The old mock omitted it,
      // which is what forced a component to cast the response `as any`.
      trigger_word: assistant.trigger_word ?? 'kurisu',
      default_persona_id:
        assistant.default_persona_id ?? (this.personas.length > 0 ? this.personas[0].id : null),
    };

    this.subAgents = (opts.subAgents ?? []).map((s) => ({
      description: '',
      system_prompt: '',
      model_name: null,
      provider_type: 'mock',
      available_tools: null,
      think: false,
      use_deferred_tools: false,
      enabled: true,
      ...s,
    }));

    this.stream = opts.stream ?? DEFAULT_STREAM;
    this.tools = {
      mcp: opts.tools?.mcp ?? [],
      builtin: opts.tools?.builtin ?? [],
    };
    for (const s of opts.mcpServers ?? []) {
      this.mcpServers.push({
        id: s.id ?? this.nextMcpServerId++,
        name: s.name ?? 'server',
        transport_type: s.transport_type ?? 'sse',
        url: s.url ?? null,
        command: s.command ?? null,
        args: s.args ?? null,
        env: s.env ?? null,
        enabled: s.enabled ?? true,
        location: s.location ?? 'server',
        created_at: new Date().toISOString(),
      });
      this.nextMcpServerId = Math.max(this.nextMcpServerId, (s.id ?? 0) + 1);
    }

    if (opts.driveQuotaBytes !== undefined) this.driveQuotaBytes = opts.driveQuotaBytes;
    for (const entry of opts.drive ?? []) this.seedDriveEntry(entry);
    for (const seed of opts.conversations ?? []) this.seedConversation(seed);

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      if (!url.startsWith('/ws/chat')) {
        socket.destroy();
        return;
      }

      // The client authenticates the handshake with the auth subprotocol (or an
      // Authorization header) and declares its wire protocol as a third entry.
      // The selected subprotocol must be echoed back, or the browser drops the
      // connection and every later assertion times out.
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .toString()
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (offered[0] === WS_AUTH_SUBPROTOCOL) {
        req.headers['sec-websocket-protocol'] = WS_AUTH_SUBPROTOCOL;
      }

      const declared = offered.find((p) => p.startsWith(WS_WIRE_SUBPROTOCOL_PREFIX));
      const clientProtocol = declared
        ? Number.parseInt(declared.slice(WS_WIRE_SUBPROTOCOL_PREFIX.length), 10)
        : null;

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        // Checked before authenticating, like the backend: a client on the wrong
        // protocol is closed with 4426 and must not be served.
        if (clientProtocol !== null && !Number.isNaN(clientProtocol) && clientProtocol !== this.wireProtocol) {
          ws.close(WS_WIRE_PROTOCOL_MISMATCH, `wire_protocol_mismatch (server ${this.wireProtocol})`);
          return;
        }
        this.handleWs(ws);
      });
    });
  }

  /**
   * Listen on `port` (0 = any free port). Loopback only by default; the CLI in
   * `cli.ts` passes `0.0.0.0` so an Android emulator can reach it at 10.0.2.2.
   */
  async start(port = 0, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((resolve) => this.httpServer.listen(port, host, resolve));
    this._port = (this.httpServer.address() as AddressInfo).port;
    return this._port;
  }

  /**
   * Shut down without waiting on sockets nobody is going to close.
   *
   * `close()` on an http server resolves only once every connection has ended,
   * and a client that was killed rather than asked to leave — an Electron
   * stuck on a blocked navigation, say — never ends its socket. This is the
   * last fixture to tear down, so that stall surfaced as "Worker teardown
   * timeout of 60000ms exceeded" after every test had already passed. Sockets
   * are therefore terminated rather than asked, and the wait is bounded.
   */
  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.httpServer.closeAllConnections?.();

    const bounded = (close: (done: () => void) => void) =>
      Promise.race([
        new Promise<void>((resolve) => close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);

    await bounded((done) => this.wss.close(() => done()));
    await bounded((done) => this.httpServer.close(() => done()));
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  setStream(stream: StreamScript) {
    this.stream = stream;
  }

  /** Speak another wire protocol from now on; see `wireProtocol`. */
  setWireProtocol(n: number) {
    this.wireProtocol = n;
  }

  /** Make `/tts/models` or `/models` answer 502, as the backend does when the service behind it is down. */
  setUnreachable(path: '/tts/models' | '/models', down = true) {
    if (down) this.unreachable.add(path);
    else this.unreachable.delete(path);
  }

  setTools(tools: { mcp?: MockTool[]; builtin?: MockTool[] }) {
    this.tools = { mcp: tools.mcp ?? this.tools.mcp, builtin: tools.builtin ?? this.tools.builtin };
  }

  /**
   * Choose the assistant's model, or `null` for the state a brand-new account is
   * in. With no model the next `chat_request` is refused with
   * `NO_MODEL_SELECTED` instead of streaming, as the real server does.
   */
  setAssistantModel(model: string | null) {
    this.assistant.model_name = model;
  }

  getPersonas(): ResolvedPersona[] {
    return [...this.personas];
  }

  getAssistant(): Required<MockAssistant> {
    return { ...this.assistant };
  }

  /**
   * Add a persona and return it. A second persona is what a handoff test needs:
   * the client splits assistant bubbles on `persona_id`, so a script that never
   * changes it can never produce a second bubble.
   */
  addPersona(persona: Omit<MockPersona, 'id'> & { id?: number }): ResolvedPersona {
    const resolved: ResolvedPersona = {
      id: persona.id ?? Math.max(0, ...this.personas.map((p) => p.id)) + 1,
      description: '',
      system_prompt: '',
      preferred_name: null,
      voice_reference: null,
      avatar_uuid: null,
      character_config: null,
      enabled: true,
      ...persona,
    } as ResolvedPersona;
    this.personas.push(resolved);
    return resolved;
  }

  addSubAgent(subAgent: Omit<MockSubAgent, 'id'> & { id?: number }): MockSubAgent {
    const resolved: MockSubAgent = {
      id: subAgent.id ?? Math.max(0, ...this.subAgents.map((s) => s.id)) + 1,
      description: '',
      system_prompt: '',
      model_name: null,
      provider_type: 'mock',
      available_tools: null,
      think: false,
      use_deferred_tools: false,
      enabled: true,
      ...subAgent,
    };
    this.subAgents.push(resolved);
    return resolved;
  }

  /** Read a stored conversation, to assert on its persona binding or messages. */
  getConversation(id: number) {
    const conv = this.conversations.get(id);
    return conv ? { ...conv, messages: [...conv.messages] } : undefined;
  }

  getConversations() {
    return Array.from(this.conversations.values()).map((c) => ({ ...c, messages: [...c.messages] }));
  }

  addMcpServer(server: Partial<{
    name: string; transport_type: 'sse' | 'stdio'; url: string | null;
    command: string | null; args: string[] | null; env: Record<string, string> | null;
    enabled: boolean; location: 'server' | 'client';
  }>) {
    const s = {
      id: this.nextMcpServerId++,
      name: server.name ?? 'server',
      transport_type: server.transport_type ?? 'sse' as 'sse' | 'stdio',
      url: server.url ?? null,
      command: server.command ?? null,
      args: server.args ?? null,
      env: server.env ?? null,
      enabled: server.enabled ?? true,
      location: server.location ?? 'server' as 'server' | 'client',
      created_at: new Date().toISOString(),
    };
    this.mcpServers.push(s);
    return s;
  }

  getMcpServers() {
    return [...this.mcpServers];
  }

  /**
   * Force-close every active WebSocket client connection. Simulates a backend
   * that drops the socket (flaky network, server restart, etc.) while the HTTP
   * surface continues to answer — so client reconnect logic can be exercised.
   */
  dropAllWebSockets() {
    for (const client of this.wss.clients) {
      try { client.terminate(); } catch { /* noop */ }
    }
  }

  // --- Persona helpers ---

  private findPersona(id: number | null | undefined): ResolvedPersona | undefined {
    if (id === null || id === undefined) return undefined;
    return this.personas.find((p) => p.id === id);
  }

  /** Only enabled personas are eligible to speak, as in `pick_persona`. */
  private findEnabledPersona(id: number | null | undefined): ResolvedPersona | undefined {
    const persona = this.findPersona(id);
    return persona && persona.enabled !== false ? persona : undefined;
  }

  /**
   * Which persona answers this turn. Mirrors `backend/.../agents/selection.py`:
   * an explicit per-turn override, then the conversation's existing binding,
   * then the assistant's default, then the first enabled persona by id. Never
   * random, and never derived from the message.
   *
   * At every step only *enabled* personas are eligible — an id naming a disabled
   * or deleted one is dropped and selection falls through, rather than failing.
   * That is the WebSocket path; `PATCH /conversations/{id}` is stricter and
   * rejects a disabled persona with 400 instead of silently substituting one.
   */
  private resolvePersona(
    override: number | null | undefined,
    conv: StoredConversation | undefined,
  ): ResolvedPersona | undefined {
    const byId = [...this.personas]
      .filter((p) => p.enabled !== false)
      .sort((a, b) => a.id - b.id);
    return (
      this.findEnabledPersona(override) ??
      this.findEnabledPersona(conv?.persona_id) ??
      this.findEnabledPersona(this.assistant.default_persona_id) ??
      byId[0]
    );
  }

  private personaResponse(p: ResolvedPersona) {
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      system_prompt: p.system_prompt ?? '',
      preferred_name: p.preferred_name ?? null,
      voice_reference: p.voice_reference ?? null,
      avatar_uuid: p.avatar_uuid ?? null,
      character_config: p.character_config ?? null,
      enabled: p.enabled ?? true,
    };
  }

  private subAgentResponse(s: MockSubAgent) {
    return {
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      system_prompt: s.system_prompt ?? '',
      model_name: s.model_name ?? null,
      provider_type: s.provider_type ?? 'mock',
      available_tools: s.available_tools ?? null,
      think: s.think ?? false,
      use_deferred_tools: s.use_deferred_tools ?? false,
      enabled: s.enabled ?? true,
    };
  }

  // --- Conversation helpers ---

  private conversationSummary(c: StoredConversation) {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c.id,
      title: c.title,
      persona_id: c.persona_id,
      created_at: c.created_at,
      updated_at: c.updated_at,
      message_count: c.messages.length,
      last_message: last
        ? {
            content: last.content.length > 100 ? last.content.slice(0, 100) : last.content,
            role: last.role,
            created_at: last.created_at,
          }
        : null,
    };
  }

  private touch(conv: StoredConversation) {
    conv.updated_at = new Date().toISOString();
  }

  private createConversation(
    personaId: number | null,
    title = 'Mock Conversation',
    id?: number,
  ): StoredConversation {
    const now = new Date().toISOString();
    if (id !== undefined) this.nextConversationId = Math.max(this.nextConversationId, id + 1);
    const conv: StoredConversation = {
      id: id ?? this.nextConversationId++,
      title,
      persona_id: personaId,
      created_at: now,
      updated_at: now,
      compacted_context: '',
      compacted_up_to_id: 0,
      messages: [],
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  /**
   * Put a finished conversation in the store, shaped exactly the way the chat
   * path shapes one — same message fields, same `persona_id` on the assistant
   * turns only — so nothing reading `GET /conversations` can tell a seeded
   * conversation from one that was chatted into.
   */
  private seedConversation(seed: MockConversationSeed) {
    const persona = seed.persona
      ? this.personas.find((p) => p.name === seed.persona)
      : undefined;
    if (seed.persona !== undefined && !persona) {
      throw new Error(`seeded conversation "${seed.title}": no persona named "${seed.persona}"`);
    }
    const conv = this.createConversation(persona?.id ?? null, seed.title);
    const step = 60_000;
    const last = Date.now() - seed.agoMinutes * step;
    const first = last - Math.max(0, seed.messages.length - 1) * step;
    seed.messages.forEach((m, i) => {
      conv.messages.push({
        id: this.nextMessageId++,
        role: m.role,
        content: m.content,
        thinking: null,
        persona_id: m.role === 'assistant' ? persona?.id ?? null : null,
        name: null,
        tool_args: null,
        tool_status: null,
        created_at: new Date(first + i * step).toISOString(),
      });
    });
    // Overwrite what createConversation stamped: the point of a seed is that it
    // is older than the process that served it.
    conv.created_at = new Date(first).toISOString();
    conv.updated_at = new Date(last).toISOString();
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const [pathOnly, rawQuery] = url.split('?');
    const query = new URLSearchParams(rawQuery ?? '');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Version handshake — must return the wire_protocol the client expects,
    // otherwise the startup gate in App.tsx blocks the UI with UpdateRequiredScreen
    // and every later locator times out. Taken from the client constant rather
    // than hardcoded, so a protocol bump cannot silently break the whole suite.
    if (pathOnly === '/version' && method === 'GET') {
      return this.json(res, { backend_version: MOCK_BACKEND_VERSION, wire_protocol: this.wireProtocol });
    }

    // The backend's middleware: any request stamped with another protocol is
    // refused with 426 and the body shape the client reads its numbers from.
    // `/health` and `/version` are exempt so a mismatched client can recover.
    const clientWire = req.headers['x-wire-protocol'];
    if (clientWire !== undefined && pathOnly !== '/health') {
      const declared = Number.parseInt(String(clientWire), 10);
      if (Number.isNaN(declared) || declared !== this.wireProtocol) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 426;
        return res.end(JSON.stringify({
          detail: 'wire_protocol_mismatch',
          client_wire_protocol: Number.isNaN(declared) ? -1 : declared,
          server_wire_protocol: this.wireProtocol,
          backend_version: MOCK_BACKEND_VERSION,
        }));
      }
    }

    // Auth endpoints
    if (pathOnly === '/login' && method === 'POST') {
      return this.json(res, {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
      });
    }
    if (pathOnly === '/register' && method === 'POST') {
      return this.json(res, {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
      });
    }
    if (pathOnly === '/auth/refresh' && method === 'POST') {
      return this.json(res, { access_token: 'test-access-token-refreshed', token_type: 'Bearer' });
    }

    // User profile
    if (pathOnly === '/users/me' && method === 'GET') {
      return this.json(res, {
        username: 'tester',
        email: 'tester@example.com',
        preferred_name: 'Tester',
        context_size: 8192,
        // Provider keys are write-only; the profile reports only whether one is set.
        has_gemini_key: false,
        has_nvidia_key: false,
        has_poe_key: false,
      });
    }
    if (pathOnly === '/users/me' && method === 'PATCH') {
      return this.json(res, { ok: true });
    }
    if (pathOnly === '/users/me/tool-policies') {
      return this.json(res, { tools: {} });
    }

    // Assistant — one per user, created at registration: no id, no POST, no DELETE.
    if (pathOnly === '/assistant' && method === 'GET') {
      return this.json(res, this.assistant);
    }
    if (pathOnly === '/assistant' && method === 'PATCH') {
      const body = await this.readJson(req);
      this.assistant = { ...this.assistant, ...body };
      return this.json(res, this.assistant);
    }

    // Personas — presentation, many per user.
    if (pathOnly === '/personas' && method === 'GET') {
      return this.json(res, this.personas.map((p) => this.personaResponse(p)));
    }
    if (pathOnly === '/personas' && method === 'POST') {
      const body = await this.readJson(req);
      const persona: ResolvedPersona = {
        id: Math.max(0, ...this.personas.map((p) => p.id)) + 1,
        name: body.name ?? 'Persona',
        description: body.description ?? '',
        system_prompt: body.system_prompt ?? '',
        preferred_name: body.preferred_name ?? null,
        voice_reference: body.voice_reference ?? null,
        avatar_uuid: body.avatar_uuid ?? null,
        character_config: body.character_config ?? null,
        enabled: body.enabled ?? true,
      };
      this.personas.push(persona);
      // The user's first persona also becomes their default.
      if (this.assistant.default_persona_id === null) {
        this.assistant.default_persona_id = persona.id;
      }
      return this.json(res, this.personaResponse(persona));
    }
    const personaEnabledMatch = pathOnly.match(/^\/personas\/(\d+)\/enabled$/);
    if (personaEnabledMatch && method === 'PATCH') {
      const persona = this.findPersona(parseInt(personaEnabledMatch[1], 10));
      if (!persona) return this.error(res, 404, 'Persona not found');
      const body = await this.readJson(req);
      persona.enabled = !!body.enabled;
      return this.json(res, this.personaResponse(persona));
    }
    const personaMatch = pathOnly.match(/^\/personas\/(\d+)$/);
    if (personaMatch) {
      const id = parseInt(personaMatch[1], 10);
      const persona = this.findPersona(id);
      // Without this route useCharacterPanel fell through to the catch-all and
      // got `{}` back, so a persona's character config never reached the panel.
      if (method === 'GET') {
        if (!persona) return this.error(res, 404, 'Persona not found');
        return this.json(res, this.personaResponse(persona));
      }
      if (method === 'PATCH') {
        if (!persona) return this.error(res, 404, 'Persona not found');
        Object.assign(persona, await this.readJson(req));
        return this.json(res, this.personaResponse(persona));
      }
      if (method === 'DELETE') {
        if (!persona) return this.error(res, 404, 'Persona not found');
        // The backend refuses to remove the last one: a user with no persona
        // cannot start a conversation.
        if (this.personas.length === 1) {
          return this.error(
            res, 400,
            'This is your only persona. Create another one before deleting it.',
          );
        }
        this.personas = this.personas.filter((p) => p.id !== id);
        // Deleting the *default* is allowed. The backend hands the default to
        // the oldest remaining persona rather than leaving it dangling, so a
        // client that re-reads /assistant afterwards must see a live id here too.
        if (this.assistant.default_persona_id === id) {
          this.assistant.default_persona_id = this.personas[0]?.id ?? null;
        }
        return this.json(res, { message: 'Persona deleted successfully' });
      }
    }

    // Sub-agents — task-only workers, no identity, no memory.
    if (pathOnly === '/sub-agents' && method === 'GET') {
      return this.json(res, this.subAgents.map((s) => this.subAgentResponse(s)));
    }
    if (pathOnly === '/sub-agents' && method === 'POST') {
      const body = await this.readJson(req);
      const subAgent: MockSubAgent = {
        id: Math.max(0, ...this.subAgents.map((s) => s.id)) + 1,
        name: body.name ?? 'Sub-agent',
        description: body.description ?? '',
        system_prompt: body.system_prompt ?? '',
        model_name: body.model_name ?? null,
        provider_type: body.provider_type ?? 'mock',
        available_tools: body.available_tools ?? null,
        think: body.think ?? false,
        use_deferred_tools: body.use_deferred_tools ?? false,
        enabled: body.enabled ?? true,
      };
      this.subAgents.push(subAgent);
      return this.json(res, this.subAgentResponse(subAgent));
    }
    const subAgentEnabledMatch = pathOnly.match(/^\/sub-agents\/(\d+)\/enabled$/);
    if (subAgentEnabledMatch && method === 'PATCH') {
      const sub = this.subAgents.find((s) => s.id === parseInt(subAgentEnabledMatch[1], 10));
      if (!sub) return this.error(res, 404, 'Sub-agent not found');
      const body = await this.readJson(req);
      sub.enabled = !!body.enabled;
      return this.json(res, this.subAgentResponse(sub));
    }
    const subAgentMatch = pathOnly.match(/^\/sub-agents\/(\d+)$/);
    if (subAgentMatch) {
      const id = parseInt(subAgentMatch[1], 10);
      const sub = this.subAgents.find((s) => s.id === id);
      if (method === 'GET') {
        if (!sub) return this.error(res, 404, 'Sub-agent not found');
        return this.json(res, this.subAgentResponse(sub));
      }
      if (method === 'PATCH') {
        if (!sub) return this.error(res, 404, 'Sub-agent not found');
        Object.assign(sub, await this.readJson(req));
        return this.json(res, this.subAgentResponse(sub));
      }
      if (method === 'DELETE') {
        if (!sub) return this.error(res, 404, 'Sub-agent not found');
        // Nothing references a sub-agent, so there is nothing to repair.
        this.subAgents = this.subAgents.filter((s) => s.id !== id);
        return this.json(res, { message: 'Sub-agent deleted successfully' });
      }
    }

    // Conversations
    if (pathOnly === '/conversations' && method === 'GET') {
      // Newest first, as the backend orders it. Two conversations touched in the
      // same millisecond tie on the ISO string, so id breaks the tie — otherwise
      // a stable sort would hand back the *older* one as "latest".
      const all = Array.from(this.conversations.values())
        .sort((a, b) => (a.updated_at === b.updated_at
          ? b.id - a.id
          : (a.updated_at < b.updated_at ? 1 : -1)));

      // `?persona_id=` is the store's fallback when the localStorage mapping is
      // gone. The backend answers with the latest conversation bound to that
      // persona and nothing else — no message_count, no last_message — so only
      // the id is dependable, and the mock has to be equally stingy or the
      // fallback path is tested against data the real server never sends.
      const personaFilter = query.get('persona_id');
      if (personaFilter !== null) {
        const personaId = parseInt(personaFilter, 10);
        const match = all.find((c) => c.persona_id === personaId);
        if (!match) return this.json(res, []);
        return this.json(res, [{
          id: match.id,
          title: match.title,
          persona_id: match.persona_id,
          created_at: match.created_at,
          updated_at: match.updated_at,
        }]);
      }

      return this.json(res, all.map((c) => this.conversationSummary(c)));
    }
    const convMatch = pathOnly.match(/^\/conversations\/(\d+)$/);
    if (convMatch && method === 'GET') {
      const id = parseInt(convMatch[1], 10);
      const conv = this.conversations.get(id);
      if (!conv) return this.error(res, 404, 'Conversation not found');
      return this.json(res, {
        id,
        title: conv.title,
        // Whoever this conversation is bound to. The store holds this and the
        // chat header renders from it; returning nothing leaves it undefined.
        persona_id: conv.persona_id,
        created_at: conv.created_at,
        messages: conv.messages.map((m) => this.messageResponse(m)),
        total_messages: conv.messages.length,
        offset: 0,
        limit: 20,
        has_more: false,
        compacted_up_to_id: conv.compacted_up_to_id,
        compacted_context: conv.compacted_context,
        system_prompt_token_count: 0,
      });
    }
    if (convMatch && method === 'PATCH') {
      const id = parseInt(convMatch[1], 10);
      const conv = this.conversations.get(id);
      const body = await this.readJson(req);
      this.lastConversationPatch = { id, body };
      if (!conv) return this.error(res, 404, 'Conversation not found');
      if (Object.keys(body).length === 0) return this.error(res, 400, 'Nothing to update');
      if ('title' in body && !(body.title ?? '').trim()) {
        return this.error(res, 400, 'Title cannot be empty');
      }
      if ('persona_id' in body && body.persona_id !== null) {
        const persona = this.findPersona(body.persona_id);
        if (!persona) return this.error(res, 404, 'Persona not found');
        if (persona.enabled === false) {
          return this.error(res, 400, 'That persona is disabled. Enable it before using it here.');
        }
      }
      if ('title' in body) conv.title = body.title;
      // An explicit null unbinds, so the next message falls back to the
      // assistant's default persona.
      if ('persona_id' in body) conv.persona_id = body.persona_id;
      this.touch(conv);
      return this.json(res, { id: conv.id, title: conv.title, persona_id: conv.persona_id });
    }
    if (convMatch && method === 'DELETE') {
      const id = parseInt(convMatch[1], 10);
      this.conversations.delete(id);
      res.statusCode = 204;
      return res.end();
    }

    // Models and misc empty lists
    if (pathOnly === '/models') {
      if (this.unreachable.has('/models')) {
        return this.error(res, 502, 'The model host (Ollama) is unreachable. (reference: mock)');
      }
      return this.json(res, { models: [{ name: 'test-model', provider: 'mock' }], unavailable: [] });
    }
    if (pathOnly === '/tools') {
      const toToolFn = (t: MockTool) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: { type: 'object', properties: {} } },
        built_in: !!t.builtin,
      });
      return this.json(res, {
        mcp_tools: this.tools.mcp.map(toToolFn),
        builtin_tools: this.tools.builtin.map(toToolFn),
      });
    }
    if (pathOnly === '/mcp-servers' && method === 'GET') {
      return this.json(res, this.mcpServers);
    }
    if (pathOnly === '/mcp-servers' && method === 'POST') {
      const body = await this.readJson(req);
      this.lastMcpServerCreate = body;
      const server = {
        id: this.nextMcpServerId++,
        name: body.name ?? 'server',
        transport_type: body.transport_type ?? 'sse',
        url: body.url ?? null,
        command: body.command ?? null,
        args: body.args ?? null,
        env: body.env ?? null,
        enabled: true,
        location: body.location ?? 'server',
        created_at: new Date().toISOString(),
      };
      this.mcpServers.push(server);
      return this.json(res, server);
    }
    const mcpIdMatch = pathOnly.match(/^\/mcp-servers\/(\d+)$/);
    if (mcpIdMatch && method === 'PATCH') {
      const id = parseInt(mcpIdMatch[1], 10);
      const body = await this.readJson(req);
      const idx = this.mcpServers.findIndex((s) => s.id === id);
      if (idx >= 0) {
        this.mcpServers[idx] = { ...this.mcpServers[idx], ...body };
        return this.json(res, this.mcpServers[idx]);
      }
      return this.error(res, 404, 'MCP server not found');
    }
    if (mcpIdMatch && method === 'DELETE') {
      const id = parseInt(mcpIdMatch[1], 10);
      this.mcpServers = this.mcpServers.filter((s) => s.id !== id);
      res.statusCode = 204;
      return res.end();
    }
    // ── Kurisu Drive ───────────────────────────────────────────────────────
    // Above the catch-all below on purpose: that returns `{}` with a 200, so an
    // unimplemented drive route would look like an empty folder rather than a
    // missing endpoint.
    if (pathOnly === '/drive/usage' && method === 'GET') {
      return this.json(res, {
        used_bytes: this.driveUsedBytes(),
        quota_bytes: this.driveQuotaBytes,
        file_count: this.driveNodes.filter((n) => !n.is_dir).length,
        max_file_bytes: 2 * 1024 * 1024 * 1024,
      });
    }

    if (pathOnly === '/drive/resolve' && method === 'GET') {
      const node = this.driveResolve(query.get('path') ?? '/');
      if (!node) return this.error(res, 404, 'Not found');
      return this.json(res, this.driveResponse(node));
    }

    if (pathOnly === '/drive/nodes' && method === 'GET') {
      const raw = query.get('parent_id');
      const parentId = raw === null ? null : Number(raw);
      if (parentId !== null) {
        const parent = this.driveNodes.find((n) => n.id === parentId);
        if (!parent) return this.error(res, 404, 'Not found');
        // 400, not 404: the backend distinguishes "no such node" from "that
        // node is a file", and a client that treated them alike would pass here
        // and misreport against the real server.
        if (!parent.is_dir) return this.error(res, 400, 'That is a file, not a folder.');
      }
      const children = this.driveNodes
        .filter((n) => n.parent_id === parentId)
        .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
      return this.json(res, children.map((n) => this.driveResponse(n)));
    }

    const driveContentMatch = pathOnly.match(/^\/drive\/files\/(\d+)\/content$/);
    if (driveContentMatch) {
      const node = this.driveNodes.find((n) => n.id === Number(driveContentMatch[1]));
      if (!node) return this.error(res, 404, 'Not found');
      if (node.is_dir) return this.error(res, 400, 'That is a folder, not a file.');
      if (method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${node.name}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', String(node.content.length));
        return res.end(node.content);
      }
      if (method === 'PUT') {
        node.content = await this.readRaw(req);
        node.size = node.content.length;
        node.updated_at = new Date().toISOString();
        return this.json(res, this.driveResponse(node));
      }
    }

    const driveNodeMatch = pathOnly.match(/^\/drive\/nodes\/(\d+)$/);
    if (driveNodeMatch) {
      const id = Number(driveNodeMatch[1]);
      const node = this.driveNodes.find((n) => n.id === id);
      if (!node) return this.error(res, 404, 'Not found');
      if (method === 'GET') return this.json(res, this.driveResponse(node));
      if (method === 'PATCH') {
        const body = await this.readJson(req);
        if (body.name !== undefined) {
          const nameError = this.driveNameError(body.name);
          if (nameError) return this.error(res, 400, nameError);
        }
        const name = body.name ?? node.name;
        const parentId = body.parent_id === undefined ? node.parent_id : body.parent_id;
        const clash = this.driveChild(parentId, name);
        if (clash && clash.id !== node.id) {
          return this.error(res, 409, `'${name}' already exists here`);
        }
        if (parentId !== null && this.driveSubtreeIds(node.id).includes(parentId)) {
          return this.error(res, 409, 'A folder cannot be moved into itself');
        }
        node.name = name;
        node.parent_id = parentId;
        node.updated_at = new Date().toISOString();
        return this.json(res, this.driveResponse(node));
      }
      if (method === 'DELETE') {
        const doomed = new Set(this.driveSubtreeIds(id));
        this.driveNodes = this.driveNodes.filter((n) => !doomed.has(n.id));
        return this.json(res, { deleted: true });
      }
    }

    if (pathOnly === '/drive/folders' && method === 'POST') {
      const body = await this.readJson(req);
      const parentId = body.parent_id ?? null;
      const nameError = this.driveNameError(body.name);
      if (nameError) return this.error(res, 400, nameError);
      if (parentId !== null && !this.driveNodes.some((n) => n.id === parentId && n.is_dir)) {
        return this.error(res, 404, 'Not found');
      }
      if (this.driveChild(parentId, body.name)) {
        return this.error(res, 409, `'${body.name}' already exists here`);
      }
      return this.json(res, this.driveResponse(this.makeDriveNode(parentId, body.name, true, Buffer.alloc(0))));
    }

    if (pathOnly === '/drive/files' && method === 'POST') {
      // Raw body, destination in the query string — not multipart. A route
      // declaring an UploadFile makes FastAPI parse and spool the whole body
      // before it resolves dependencies, i.e. before it has authenticated the
      // caller or checked the size ceiling and the quota.
      const name = query.get('name') ?? '';
      const rawParent = query.get('parent_id');
      const parentId = rawParent === null ? null : Number(rawParent);
      const overwrite = query.get('overwrite') === 'true';

      const nameError = this.driveNameError(name);
      if (nameError) {
        await this.readRaw(req);
        return this.error(res, 400, nameError);
      }
      // The backend refuses an unknown or non-folder parent before it writes
      // anything; accepting one here would create an orphan the real server
      // never would.
      if (parentId !== null) {
        const parent = this.driveNodes.find((n) => n.id === parentId);
        if (!parent) {
          await this.readRaw(req);
          return this.error(res, 404, 'Not found');
        }
        if (!parent.is_dir) {
          await this.readRaw(req);
          return this.error(res, 400, 'That is a file, not a folder.');
        }
      }

      const existing = this.driveChild(parentId, name);
      // Order matters, and it is the backend's: the name clash is decided
      // before the quota, so a duplicate is 409 rather than 507.
      if (existing && !overwrite) {
        await this.readRaw(req);
        return this.error(res, 409, `'${name}' already exists here`);
      }
      if (existing && existing.is_dir) {
        await this.readRaw(req);
        return this.error(res, 409, 'A folder of that name is already here.');
      }

      const content = await this.readRaw(req);
      // Replacing a file releases its bytes, so they are not spent twice —
      // without this an overwrite of a file that fills the quota is refused
      // where the backend accepts it.
      const reclaimed = existing ? existing.size : 0;
      if (this.driveUsedBytes() - reclaimed + content.length > this.driveQuotaBytes) {
        return this.error(res, 507, 'Your drive is full. Remove something, or ask for more space.');
      }
      this.lastDriveUpload = { name, parent_id: parentId, bytes: content.length };

      if (existing) {
        existing.content = content;
        existing.size = content.length;
        existing.updated_at = new Date().toISOString();
        return this.json(res, this.driveResponse(existing));
      }
      return this.json(res, this.driveResponse(this.makeDriveNode(parentId, name, false, content)));
    }

    if (pathOnly === '/skills') return this.json(res, []);
    if (pathOnly === '/faces') return this.json(res, []);
    if (pathOnly === '/tts/backends') return this.json(res, { backends: [] });
    if (pathOnly === '/tts/voices' || pathOnly.startsWith('/tts/voices')) return this.json(res, { voices: [] });
    if (pathOnly === '/tts/models') {
      if (this.unreachable.has('/tts/models')) {
        return this.error(res, 502, 'The speech service is unavailable. (reference: mock)');
      }
      return this.json(res, { models: [] });
    }

    // Default: empty object, 200
    return this.json(res, {});
  }

  // ── Kurisu Drive ─────────────────────────────────────────────────────────
  //
  // A tree in memory, shaped like `drive_nodes`: rows with a parent link, and
  // the bytes alongside. Ownership is not modelled — this mock authenticates
  // nobody, so who-may-read-what is tested against the real backend's `db`
  // suite, not here.

  /**
   * The backend's `drive_storage.validate_name`, mirrored.
   *
   * The standing rule is that when the mock and the backend disagree the
   * backend wins — so a name the server would refuse with a 400 has to be
   * refused here too, or a spec passes against a server that would not have
   * accepted it.
   */
  private driveNameError(name: unknown): string | null {
    if (typeof name !== 'string' || name.trim() === '') return 'A name is required.';
    if (name.trim() !== name) return 'A name cannot start or end with a space.';
    if (Buffer.byteLength(name, 'utf8') > 255) return 'A name cannot be longer than 255 bytes.';
    if (name.includes('/') || name.includes('\\')) {
      return 'A name cannot contain a slash or a null byte.';
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name)) return 'A name cannot contain control characters.';
    if (name === '.' || name === '..') return 'That name is reserved.';
    return null;
  }

  private driveChild(parentId: number | null, name: string) {
    return this.driveNodes.find((n) => n.parent_id === parentId && n.name === name);
  }

  private driveMime(name: string): string {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const known: Record<string, string> = {
      md: 'text/markdown', txt: 'text/plain', json: 'application/json',
      png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf', wav: 'audio/x-wav',
    };
    return known[ext] ?? 'application/octet-stream';
  }

  private makeDriveNode(parentId: number | null, name: string, isDir: boolean, content: Buffer) {
    const now = new Date().toISOString();
    const node = {
      id: this.nextDriveId++,
      parent_id: parentId,
      name,
      is_dir: isDir,
      size: isDir ? 0 : content.length,
      mime: isDir ? null : this.driveMime(name),
      checksum: isDir ? null : `mock-${content.length}`,
      created_at: now,
      updated_at: now,
      content,
    };
    this.driveNodes.push(node);
    return node;
  }

  /** `/Reports/Q3.md` → the folders it implies, then the file. */
  private seedDriveEntry(entry: MockDriveEntry) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) return;
    const leaf = segments.pop()!;
    let parentId: number | null = null;
    for (const segment of segments) {
      const existing = this.driveChild(parentId, segment);
      parentId = existing ? existing.id : this.makeDriveNode(parentId, segment, true, Buffer.alloc(0)).id;
    }
    if (this.driveChild(parentId, leaf)) return;
    this.makeDriveNode(parentId, leaf, entry.isDir ?? false, Buffer.from(entry.content ?? '', 'utf8'));
  }

  private driveResponse(node: (typeof this.driveNodes)[number]) {
    return {
      id: node.id,
      parent_id: node.parent_id,
      name: node.name,
      is_dir: node.is_dir,
      size: node.size,
      mime: node.mime,
      checksum: node.checksum,
      created_at: node.created_at,
      updated_at: node.updated_at,
    };
  }

  private driveResolve(path: string) {
    let node: (typeof this.driveNodes)[number] | undefined;
    for (const segment of path.split('/').filter(Boolean)) {
      node = this.driveChild(node ? node.id : null, segment);
      if (!node) return undefined;
    }
    return node;
  }

  private driveSubtreeIds(id: number): number[] {
    const found = [id];
    let frontier = [id];
    while (frontier.length) {
      const next = this.driveNodes.filter((n) => n.parent_id !== null && frontier.includes(n.parent_id));
      frontier = next.map((n) => n.id);
      found.push(...frontier);
    }
    return found;
  }

  private driveUsedBytes(): number {
    return this.driveNodes.filter((n) => !n.is_dir).reduce((sum, n) => sum + n.size, 0);
  }

  /** Seed or inspect the drive from a spec. */
  public addDriveEntry(entry: MockDriveEntry): void {
    this.seedDriveEntry(entry);
  }

  public getDrivePaths(): string[] {
    const pathOf = (node: (typeof this.driveNodes)[number]): string => {
      const parent = this.driveNodes.find((n) => n.id === node.parent_id);
      return parent ? `${pathOf(parent)}/${node.name}` : `/${node.name}`;
    };
    return this.driveNodes.map(pathOf).sort();
  }

  private messageResponse(m: StoredMessage) {
    const persona = this.findPersona(m.persona_id);
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      has_raw_data: false,
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.name ? { name: m.name } : {}),
      ...(m.tool_args ? { tool_args: m.tool_args } : {}),
      ...(m.tool_status ? { tool_status: m.tool_status } : {}),
      // Only an assistant message has a speaker. The embedded stamp is what the
      // bubble renders its name and avatar from on a reload.
      ...(m.persona_id !== null
        ? {
            persona_id: m.persona_id,
            ...(persona
              ? {
                  persona: {
                    id: persona.id,
                    name: persona.name,
                    avatar_uuid: persona.avatar_uuid ?? null,
                    voice_reference: persona.voice_reference ?? null,
                  },
                }
              : {}),
          }
        : {}),
    };
  }

  private json(res: http.ServerResponse, body: unknown) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  }

  private error(res: http.ServerResponse, status: number, detail: string) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify({ detail }));
  }

  private async readRaw(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return {}; }
  }

  private handleWs(ws: WebSocket) {
    const send = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (process.env.MOCK_DEBUG) console.log('[mock] ws send:', payload.type, payload.content ?? '');
        ws.send(JSON.stringify({ event_id: randomUUID(), timestamp: new Date().toISOString(), ...payload }));
      } else if (process.env.MOCK_DEBUG) {
        console.log('[mock] ws send SKIPPED (not open):', payload.type, 'state=', ws.readyState);
      }
    };

    // Per-connection cancel flag — set when a cancel event arrives, cleared when a new
    // chat_request starts. The streaming loop polls this before each chunk so it can
    // abort without letting late chunks leak onto the client after a stop click.
    let cancelRequested = false;

    // Announce connection. The real session outlives one socket, so a reconnect
    // reports the last turn's conversation and the persona that spoke it.
    send({
      type: 'connected',
      chat_active: false,
      conversation_id: this.lastTurn.conversationId,
      persona_id: this.lastTurn.personaId,
      vision_active: false,
      vision_config: null,
    });

    ws.on('message', async (raw) => {
      let event: any;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (process.env.MOCK_DEBUG) console.log('[mock] ws recv:', event.type, event.text ?? '');

      if (event.type === 'chat_request') {
        cancelRequested = false;
        this.lastChatRequest = event;

        // The real server refuses the turn when neither the assistant row nor the
        // request names a model, before it creates a conversation — see
        // backend/kurisuassistant/websocket/handlers.py. A new account is in
        // exactly that state, so the mock has to be able to reproduce it.
        if (!this.assistant.model_name && !event.model_name) {
          send({
            type: 'error',
            error: 'No model is selected yet. Choose one on the Assistant screen, then send your message again.',
            code: 'NO_MODEL_SELECTED',
          });
          return;
        }

        let conv = event.conversation_id ? this.conversations.get(event.conversation_id) : undefined;

        // Binding precedence, as the backend resolves it: an explicit per-turn
        // `persona_id` → the conversation's existing binding → the assistant's
        // default. `agent_id` is not accepted; a client still sending it gets
        // the default, exactly as the real server would.
        const persona = this.resolvePersona(event.persona_id, conv);

        if (!conv) {
          // A null conversation_id means "start one". A stale id the mock has
          // never seen keeps its number, so the client's own bookkeeping stays
          // consistent instead of silently moving to a different conversation.
          conv = this.createConversation(persona?.id ?? null, 'Mock Conversation', event.conversation_id ?? undefined);
        } else if (persona && conv.persona_id !== persona.id) {
          // A per-turn override rebinds the conversation server-side.
          conv.persona_id = persona.id;
        }
        const conversationId = conv.id;
        this.lastTurn = { conversationId, personaId: persona?.id ?? null };

        conv.messages.push({
          id: this.nextMessageId++,
          role: 'user',
          content: event.text ?? '',
          thinking: null,
          persona_id: null,
          name: null,
          tool_args: null,
          tool_status: null,
          created_at: new Date().toISOString(),
        });
        this.touch(conv);

        // Chunks are grouped into stored messages the way the backend groups
        // them: a new message starts whenever the role or the speaker changes.
        type Segment = {
          role: string; content: string; thinking: string;
          personaId: number | null; name: string | null;
          toolArgs: Record<string, unknown> | null; toolStatus: string | null;
        };
        const segments: Segment[] = [];
        let aborted = false;

        for (const chunk of this.stream.chunks) {
          if (chunk.delayMs) await sleep(chunk.delayMs);
          if (cancelRequested) { aborted = true; break; }

          const role = chunk.role ?? 'assistant';
          const isTool = role === 'tool';

          // An assistant chunk speaks as a persona; a tool chunk speaks as
          // nobody, and `name` carries the tool's own label instead.
          const speaker = isTool
            ? undefined
            : (this.findPersona(chunk.personaId) ?? persona);
          const personaId = isTool ? null : (chunk.personaId ?? speaker?.id ?? null);
          const personaName = isTool ? null : (chunk.personaName ?? speaker?.name ?? null);
          const label = isTool ? (chunk.name ?? 'mock_tool') : personaName;

          const last = segments[segments.length - 1];
          if (!last || last.role !== role || last.name !== label) {
            segments.push({
              role,
              content: chunk.content,
              thinking: chunk.thinking ?? '',
              personaId,
              name: label,
              toolArgs: chunk.toolArgs ?? null,
              toolStatus: chunk.toolStatus ?? (isTool ? 'success' : null),
            });
          } else {
            last.content += chunk.content;
            if (chunk.thinking) last.thinking += chunk.thinking;
          }

          send({
            type: 'stream_chunk',
            content: chunk.content,
            thinking: chunk.thinking ?? null,
            role,
            persona_id: personaId,
            persona_name: personaName,
            name: label,
            voice_reference: isTool ? null : (speaker?.voice_reference ?? null),
            model_name: isTool ? null : this.assistant.model_name,
            provider_type: isTool ? null : this.assistant.provider_type,
            tool_args: chunk.toolArgs ?? null,
            tool_status: chunk.toolStatus ?? (isTool ? 'success' : null),
            // Only meaningful on a tool chunk, and the client's only source for
            // the sub-agent tag and the call duration.
            tool_kind: isTool ? (chunk.toolKind ?? 'tool') : null,
            duration_ms: isTool ? (chunk.durationMs ?? 12) : null,
            conversation_id: conversationId,
            images: null,
            token_count: null,
          });
        }

        // Persist whatever made it out (partial content on cancel counts).
        for (const seg of segments) {
          conv.messages.push({
            id: this.nextMessageId++,
            role: seg.role,
            content: seg.content,
            thinking: seg.thinking || null,
            persona_id: seg.personaId,
            name: seg.name,
            tool_args: seg.toolArgs,
            tool_status: seg.toolStatus,
            created_at: new Date().toISOString(),
          });
        }
        this.touch(conv);

        if (!aborted) {
          send({ type: 'done', conversation_id: conversationId });
        }
        // Cancel path: client already synthesized its own local 'done' equivalent
        // via handleCancel. A server 'done' here would re-enter handleDone and
        // clear cancelledRef, re-enabling late chunk delivery.
      }

      if (event.type === 'cancel') {
        cancelRequested = true;
      }

      // Compaction. The backend summarizes, opens a NEW conversation carrying
      // the same persona, and announces the move — nothing in the mock produced
      // this event before, so the client's switch path was never exercised.
      if (event.type === 'compact_context') {
        const oldId = event.conversation_id;
        const old = oldId ? this.conversations.get(oldId) : undefined;
        if (!old) return;

        send({
          type: 'context_info',
          conversation_id: oldId,
          compacting: true,
          compacted_up_to_id: 0,
          compacted_context: '',
        });

        // In place, like the server since #99: the conversation keeps its id
        // and its messages, `compacted_context` holds the summary and the
        // watermark moves to the last message it covers.
        const summary = `Summary of conversation ${oldId}.`;
        const lastMessageId = old.messages.length
          ? old.messages[old.messages.length - 1].id
          : 0;
        old.compacted_context = summary;
        old.compacted_up_to_id = lastMessageId;
        this.lastTurn = { conversationId: oldId, personaId: old.persona_id };

        send({
          type: 'context_info',
          conversation_id: oldId,
          compacting: false,
          compacted_up_to_id: lastMessageId,
          compacted_context: summary,
        });
      }
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
