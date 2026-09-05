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
} from '../../src/constants';

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

export interface MockBackendOptions {
  personas?: MockPersona[];
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
      model_name: assistant.model_name ?? 'test-model',
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
        if (clientProtocol !== null && !Number.isNaN(clientProtocol) && clientProtocol !== WIRE_PROTOCOL) {
          ws.close(WS_WIRE_PROTOCOL_MISMATCH, `wire_protocol_mismatch (server ${WIRE_PROTOCOL})`);
          return;
        }
        this.handleWs(ws);
      });
    });
  }

  async start(port = 0): Promise<number> {
    await new Promise<void>((resolve) => this.httpServer.listen(port, '127.0.0.1', resolve));
    this._port = (this.httpServer.address() as AddressInfo).port;
    return this._port;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      this.httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  setStream(stream: StreamScript) {
    this.stream = stream;
  }

  setTools(tools: { mcp?: MockTool[]; builtin?: MockTool[] }) {
    this.tools = { mcp: tools.mcp ?? this.tools.mcp, builtin: tools.builtin ?? this.tools.builtin };
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
      messages: [],
    };
    this.conversations.set(conv.id, conv);
    return conv;
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
      return this.json(res, { backend_version: '0.4.0', wire_protocol: WIRE_PROTOCOL });
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
        compacted_up_to_id: 0,
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
      return this.json(res, { models: [{ name: 'test-model', provider: 'mock' }] });
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
    if (pathOnly === '/skills') return this.json(res, []);
    if (pathOnly === '/faces') return this.json(res, []);
    if (pathOnly === '/tts/backends') return this.json(res, { backends: [] });
    if (pathOnly === '/tts/voices' || pathOnly.startsWith('/tts/voices')) return this.json(res, { voices: [] });
    if (pathOnly === '/tts/models') return this.json(res, { models: [] });

    // Default: empty object, 200
    return this.json(res, {});
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

        const summary = `Summary of conversation ${oldId}.`;
        const next = this.createConversation(old.persona_id, old.title);
        next.compacted_context = summary;
        this.lastTurn = { conversationId: next.id, personaId: next.persona_id };

        send({
          type: 'conversation_switched',
          old_conversation_id: oldId,
          new_conversation_id: next.id,
          compacted_context: summary,
          // The persona follows the conversation across the split; without it a
          // compacted conversation comes back with no voice.
          persona_id: next.persona_id ?? 0,
        });
      }
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
