/**
 * Mock backend for Playwright E2E tests.
 *
 * Implements the minimum HTTP + WebSocket surface the renderer hits on startup
 * and during a chat round-trip. All responses are deterministic so tests can
 * assert on concrete values.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { WIRE_PROTOCOL } from '../../src/constants';

export interface MockAgent {
  id: number;
  name: string;
  model_name: string;
}

export interface StreamScript {
  chunks: Array<{ content: string; thinking?: string; role?: string; delayMs?: number }>;
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
  agents?: MockAgent[];
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
  frame_id: number;
  created_at: string;
}

interface StoredConversation {
  id: number;
  title: string;
  messages: StoredMessage[];
}

export class MockBackend {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private _port: number = 0;
  private agents: MockAgent[];
  private stream: StreamScript;
  private nextConversationId = 1;
  private nextFrameId = 1;
  private nextMessageId = 1;
  private nextMcpServerId = 1;
  private conversations: Map<number, StoredConversation> = new Map();
  private mcpServers: Array<{
    id: number; name: string; transport_type: 'sse' | 'stdio'; url: string | null;
    command: string | null; args: string[] | null; env: Record<string, string> | null;
    enabled: boolean; location: 'server' | 'client'; created_at: string;
  }> = [];
  private tools: { mcp: MockTool[]; builtin: MockTool[] };
  public lastChatRequest: any = null;
  public lastMcpServerCreate: any = null;

  constructor(opts: MockBackendOptions = {}) {
    this.agents = opts.agents ?? [
      { id: 1, name: 'Kurisu', model_name: 'test-model' },
    ];
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
      if (url.startsWith('/ws/chat')) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWs(ws));
      } else {
        socket.destroy();
      }
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

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const pathOnly = url.split('?')[0];

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
      return this.json(res, { backend_version: '0.3.0', wire_protocol: WIRE_PROTOCOL });
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

    // Agents
    if (pathOnly === '/agents' && method === 'GET') {
      return this.json(res, this.agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: '',
        system_prompt: '',
        model_name: a.model_name,
        provider_type: 'mock',
        available_tools: [],
        think: false,
        memory: null,
        memory_enabled: false,
        enabled: true,
        is_system: false,
        use_deferred_tools: false,
        agent_type: 'main',
        voice_reference: null,
        avatar_uuid: null,
        character_config: null,
        preferred_name: null,
      })));
    }

    // Conversations
    if (pathOnly === '/conversations' && method === 'GET') {
      return this.json(res, Array.from(this.conversations.values()).map((c) => ({
        id: c.id,
        title: c.title,
        frame_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })));
    }
    const convMatch = pathOnly.match(/^\/conversations\/(\d+)$/);
    if (convMatch && method === 'GET') {
      const id = parseInt(convMatch[1], 10);
      const conv = this.conversations.get(id);
      const messages = conv?.messages ?? [];
      return this.json(res, {
        id,
        title: conv?.title ?? 'Mock Conversation',
        created_at: new Date().toISOString(),
        messages,
        frames: messages.length > 0 ? { 1: { id: 1, summary: null, created_at: null, updated_at: null } } : {},
        total_messages: messages.length,
        offset: 0,
        limit: 20,
        has_more: false,
        compacted_up_to_id: 0,
        compacted_context: '',
        system_prompt_token_count: 0,
      });
    }
    if (convMatch && method === 'DELETE') {
      const id = parseInt(convMatch[1], 10);
      this.conversations.delete(id);
      res.statusCode = 204;
      return res.end();
    }

    // Models and misc empty lists
    if (pathOnly === '/models') return this.json(res, { models: [{ name: 'test-model', provider: 'mock' }] });
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
      res.statusCode = 404; return res.end();
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

  private json(res: http.ServerResponse, body: unknown) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify(body));
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

    // Announce connection
    send({
      type: 'connected',
      chat_active: false,
      conversation_id: null,
      frame_id: null,
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
        const conversationId = event.conversation_id ?? this.nextConversationId++;
        const frameId = this.nextFrameId++;

        let conv = this.conversations.get(conversationId);
        if (!conv) {
          conv = { id: conversationId, title: 'Mock Conversation', messages: [] };
          this.conversations.set(conversationId, conv);
        }
        conv.messages.push({
          id: this.nextMessageId++,
          role: 'user',
          content: event.text ?? '',
          frame_id: frameId,
          created_at: new Date().toISOString(),
        });

        const assembledByRole: Record<string, string> = {};
        let aborted = false;
        for (const chunk of this.stream.chunks) {
          if (chunk.delayMs) await sleep(chunk.delayMs);
          if (cancelRequested) { aborted = true; break; }
          const role = chunk.role ?? 'assistant';
          assembledByRole[role] = (assembledByRole[role] ?? '') + chunk.content;
          send({
            type: 'stream_chunk',
            content: chunk.content,
            thinking: chunk.thinking ?? null,
            role,
            agent_id: event.agent_id,
            name: null,
            persona_name: null,
            voice_reference: null,
            model_name: 'test-model',
            provider_type: 'mock',
            tool_args: null,
            tool_status: null,
            conversation_id: conversationId,
            frame_id: frameId,
            images: null,
            token_count: null,
          });
        }

        // Persist whatever made it out (partial content on cancel counts).
        for (const [role, content] of Object.entries(assembledByRole)) {
          conv.messages.push({
            id: this.nextMessageId++,
            role,
            content,
            frame_id: frameId,
            created_at: new Date().toISOString(),
          });
        }

        if (!aborted) {
          send({ type: 'done', conversation_id: conversationId, frame_id: frameId });
        }
        // Cancel path: client already synthesized its own local 'done' equivalent
        // via handleCancel. A server 'done' here would re-enter handleDone and
        // clear cancelledRef, re-enabling late chunk delivery.
      }

      if (event.type === 'cancel') {
        cancelRequested = true;
      }
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
