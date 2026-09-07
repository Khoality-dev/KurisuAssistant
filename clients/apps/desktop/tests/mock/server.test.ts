// @vitest-environment node
/**
 * Unit tests for the E2E mock backend.
 *
 * The mock is the only description of the backend the Playwright suite ever
 * sees, so a wrong shape here does not fail loudly — it quietly makes the specs
 * agree with a server that does not exist. These tests pin the shapes that the
 * assistant/persona split changed, and they run under vitest, which needs no
 * Electron build.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MockBackend } from './server';
import {
  WIRE_PROTOCOL,
  WS_AUTH_SUBPROTOCOL,
  WS_WIRE_SUBPROTOCOL_PREFIX,
  WS_WIRE_PROTOCOL_MISMATCH,
} from '@kurisu/models';

let mock: MockBackend;

beforeEach(async () => {
  mock = new MockBackend();
  await mock.start();
});

afterEach(async () => {
  await mock.stop();
});

const get = async (path: string) => {
  const res = await fetch(`${mock.url}${path}`);
  return { status: res.status, body: await res.json() };
};

const patch = async (path: string, body: unknown) => {
  const res = await fetch(`${mock.url}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const del = async (path: string) => {
  const res = await fetch(`${mock.url}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
};

function connect(wireProtocol: number = WIRE_PROTOCOL): WebSocket {
  return new WebSocket(`${mock.url.replace('http:', 'ws:')}/ws/chat`, [
    WS_AUTH_SUBPROTOCOL,
    'test-token',
    `${WS_WIRE_SUBPROTOCOL_PREFIX}${wireProtocol}`,
  ]);
}

/** Send one chat_request and collect every event up to and including `done`. */
async function chat(payload: Record<string, unknown>): Promise<any[]> {
  const ws = connect();
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === 'connected') {
        ws.send(JSON.stringify({ type: 'chat_request', text: 'hi', model_name: 'test-model', ...payload }));
      }
      if (event.type === 'done') resolve();
    });
  });
  ws.close();
  return events;
}

describe('mock backend: assistant / persona / sub-agent split', () => {
  it('serves the assistant with every field the client type declares', async () => {
    const { body } = await get('/assistant');
    // trigger_word is non-optional on the client's Assistant type. Omitting it
    // is what forced a component to cast the response `as any`.
    expect(body).toEqual({
      id: 1,
      model_name: 'test-model',
      provider_type: 'mock',
      available_tools: null,
      think: false,
      use_deferred_tools: false,
      memory: null,
      memory_enabled: true,
      trigger_word: 'kurisu',
      default_persona_id: 1,
    });
  });

  it('serves personas as presentation only — no model, tools, memory or wake word', async () => {
    const { body } = await get('/personas');
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Kurisu');
    expect(Object.keys(body[0]).sort()).toEqual([
      'avatar_uuid', 'character_config', 'description', 'enabled', 'id',
      'name', 'preferred_name', 'system_prompt', 'voice_reference',
    ]);
  });

  it('serves a single persona by id, and 404s an unknown one', async () => {
    expect((await get('/personas/1')).body.name).toBe('Kurisu');
    expect((await get('/personas/999')).status).toBe(404);
  });

  it('serves sub-agents as a separate, initially empty resource', async () => {
    expect((await get('/sub-agents')).body).toEqual([]);
    const sub = mock.addSubAgent({ name: 'Researcher', model_name: 'sub-model' });
    const { body } = await get('/sub-agents');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: sub.id, name: 'Researcher', model_name: 'sub-model' });
    // A sub-agent has no identity: no avatar, no voice, no memory.
    expect(body[0]).not.toHaveProperty('avatar_uuid');
    expect(body[0]).not.toHaveProperty('voice_reference');
    expect(body[0]).not.toHaveProperty('memory');
  });

  it('hands the default to the oldest remaining persona when the default is deleted', async () => {
    // The backend allows deleting the default and repoints it rather than
    // leaving a dangling id, so a client re-reading /assistant must see a live
    // persona. Deleting the *last* one is what it refuses.
    const second = mock.addPersona({ name: 'Amadeus' });
    expect((await get('/assistant')).body.default_persona_id).toBe(1);

    const deleted = await del('/personas/1');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ message: 'Persona deleted successfully' });
    expect((await get('/assistant')).body.default_persona_id).toBe(second.id);

    // Down to one, and it cannot go: a user with no persona cannot chat.
    expect((await del(`/personas/${second.id}`)).status).toBe(400);
  });

  it('no longer answers /agents', async () => {
    // The catch-all returns {} rather than a list, so a client still calling it
    // gets nothing usable instead of a plausible-looking fixture.
    expect((await get('/agents')).body).toEqual({});
  });
});

describe('mock backend: conversations', () => {
  it('binds a new conversation to the assistant default persona', async () => {
    const events = await chat({ conversation_id: null });
    const chunk = events.find((e) => e.type === 'stream_chunk');
    expect(chunk.persona_id).toBe(1);
    expect(chunk.persona_name).toBe('Kurisu');

    const conversationId = chunk.conversation_id;
    const { body } = await get(`/conversations/${conversationId}`);
    // The store reads persona_id from here; returning none left it undefined
    // and the chat header silently fell back.
    expect(body.persona_id).toBe(1);
  });

  it('honours an explicit per-turn persona_id and rebinds the conversation', async () => {
    const other = mock.addPersona({ name: 'Amadeus' });
    const events = await chat({ conversation_id: null, persona_id: other.id });

    expect(mock.lastChatRequest.persona_id).toBe(other.id);
    const chunk = events.find((e) => e.type === 'stream_chunk');
    expect(chunk.persona_id).toBe(other.id);
    expect(chunk.persona_name).toBe('Amadeus');
    expect(mock.getConversation(chunk.conversation_id)!.persona_id).toBe(other.id);
  });

  it('ignores a legacy agent_id instead of aliasing it to persona_id', async () => {
    const other = mock.addPersona({ name: 'Amadeus' });
    const events = await chat({ conversation_id: null, agent_id: other.id });
    // Falls back to the default persona, exactly as the real server would.
    expect(events.find((e) => e.type === 'stream_chunk').persona_id).toBe(1);
  });

  it('lists conversations with persona_id, message_count and last_message', async () => {
    await chat({ conversation_id: null });
    const { body } = await get('/conversations');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ persona_id: 1, message_count: 2 });
    // The persona list's previews come from here; without last_message they
    // never populate.
    expect(body[0].last_message).toMatchObject({ content: 'Hello from mock backend.', role: 'assistant' });
  });

  it('honours ?persona_id= and answers with the stingy one-element shape', async () => {
    const other = mock.addPersona({ name: 'Amadeus' });
    const first = (await chat({ conversation_id: null })).find((e) => e.type === 'stream_chunk');
    const second = (await chat({ conversation_id: null, persona_id: other.id }))
      .find((e) => e.type === 'stream_chunk');

    const mine = await get(`/conversations?persona_id=${other.id}`);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(second.conversation_id);
    expect(mine.body[0].id).not.toBe(first.conversation_id);
    // The real endpoint omits these on the filtered path, so the client's
    // fallback must not learn to depend on them.
    expect(mine.body[0]).not.toHaveProperty('message_count');
    expect(mine.body[0]).not.toHaveProperty('last_message');

    expect((await get('/conversations?persona_id=999')).body).toEqual([]);
  });

  it('PATCHes a conversation title and persona, and unbinds on null', async () => {
    const other = mock.addPersona({ name: 'Amadeus' });
    const id = (await chat({ conversation_id: null })).find((e) => e.type === 'stream_chunk').conversation_id;

    expect((await patch(`/conversations/${id}`, { title: 'Renamed' })).body)
      .toMatchObject({ id, title: 'Renamed', persona_id: 1 });
    expect((await patch(`/conversations/${id}`, { persona_id: other.id })).body.persona_id).toBe(other.id);
    expect((await patch(`/conversations/${id}`, { persona_id: null })).body.persona_id).toBeNull();
    expect(mock.lastConversationPatch).toEqual({ id, body: { persona_id: null } });

    expect((await patch(`/conversations/${id}`, {})).status).toBe(400);
    expect((await patch(`/conversations/${id}`, { title: '  ' })).status).toBe(400);
    expect((await patch(`/conversations/${id}`, { persona_id: 999 })).status).toBe(404);
    expect((await patch('/conversations/999', { title: 'x' })).status).toBe(404);
  });

  it('refuses to bind a disabled persona', async () => {
    const other = mock.addPersona({ name: 'Amadeus', enabled: false });
    const id = (await chat({ conversation_id: null })).find((e) => e.type === 'stream_chunk').conversation_id;
    expect((await patch(`/conversations/${id}`, { persona_id: other.id })).status).toBe(400);
  });

  it('drops a disabled per-turn override instead of honouring it', async () => {
    // The two paths differ on purpose, and the mock has to keep them apart:
    // PATCH rejects a disabled persona outright (above), while `pick_persona`
    // on the chat path logs, ignores the id and falls through to the default.
    const other = mock.addPersona({ name: 'Amadeus', enabled: false });
    const chunk = (await chat({ conversation_id: null, persona_id: other.id }))
      .find((e) => e.type === 'stream_chunk');
    expect(chunk.persona_id).toBe(1);
    expect(chunk.persona_name).toBe('Kurisu');
  });

  it('stamps stored assistant messages with the persona and leaves tool messages unstamped', async () => {
    mock.setStream({
      chunks: [
        { content: 'Checking. ', role: 'assistant' },
        { content: '{"ok":true}', role: 'tool', name: 'lookup' },
      ],
    });
    const id = (await chat({ conversation_id: null })).find((e) => e.type === 'stream_chunk').conversation_id;
    const { body } = await get(`/conversations/${id}`);

    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.persona_id).toBe(1);
    expect(assistant.persona).toMatchObject({ id: 1, name: 'Kurisu' });

    const tool = body.messages.find((m: any) => m.role === 'tool');
    expect(tool).not.toHaveProperty('persona_id');
    expect(tool.name).toBe('lookup');
  });
});

describe('mock backend: seeded conversations', () => {
  /**
   * A client that draws a list needs a list before anyone has chatted, and the
   * documented way to regenerate the Chats screenshot could only ever produce
   * one row (#194). A seed has to be indistinguishable from a conversation that
   * was chatted into, or the picture documents a shape the app never serves.
   */

  let seeded: MockBackend;

  beforeEach(async () => {
    await mock.stop();
    seeded = new MockBackend({
      personas: [
        { id: 1, name: 'Kurisu' },
        { id: 2, name: 'Amadeus' },
      ],
      conversations: [
        {
          title: 'Older, and answered by the second persona',
          persona: 'Amadeus',
          agoMinutes: 3 * 24 * 60,
          messages: [
            { role: 'user', content: 'Ask something' },
            { role: 'assistant', content: 'Answer something' },
          ],
        },
        {
          title: 'Newest',
          persona: 'Kurisu',
          agoMinutes: 5,
          messages: [
            { role: 'user', content: 'Recent question' },
            { role: 'assistant', content: 'Recent answer' },
          ],
        },
      ],
    });
    await seeded.start();
    mock = seeded;
  });

  const seededGet = async (path: string) => {
    const res = await fetch(`${seeded.url}${path}`);
    return { status: res.status, body: await res.json() };
  };

  it('lists a seeded conversation exactly as it lists a chatted one', async () => {
    const { body } = await seededGet('/conversations');
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      title: 'Newest',
      persona_id: 1,
      message_count: 2,
    });
    expect(body[0].last_message).toMatchObject({
      content: 'Recent answer',
      role: 'assistant',
    });
  });

  it('orders by the seeded age, newest first', async () => {
    const { body } = await seededGet('/conversations');
    expect(body.map((c: any) => c.title)).toEqual([
      'Newest',
      'Older, and answered by the second persona',
    ]);

    // The age is the point: a list that labels rows by recency has nothing to
    // show if every seed is stamped with the moment the process started.
    const ageMinutes = (iso: string) => (Date.now() - Date.parse(iso)) / 60_000;
    expect(ageMinutes(body[0].last_message.created_at)).toBeGreaterThan(4);
    expect(ageMinutes(body[0].last_message.created_at)).toBeLessThan(7);
    expect(ageMinutes(body[1].updated_at)).toBeGreaterThan(3 * 24 * 60 - 2);
  });

  it('stamps the persona on the assistant turns only', async () => {
    // A user message carries no speaker at all — the key is absent, not null,
    // exactly as it is on a conversation that was chatted into.
    const list = (await seededGet('/conversations')).body;
    const { body } = await seededGet(`/conversations/${list[0].id}`);
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(body.messages[0]).not.toHaveProperty('persona_id');
    expect(body.messages[1]).toMatchObject({ persona_id: 1, persona: { name: 'Kurisu' } });
  });

  it('seeds a tool turn, so a rail can be photographed without racing a stream', async () => {
    await seeded.stop();
    seeded = new MockBackend({
      personas: [{ id: 1, name: 'Kurisu' }],
      conversations: [{
        title: 'With a rail',
        persona: 'Kurisu',
        agoMinutes: 2,
        messages: [
          { role: 'user', content: 'Show me where that is enforced.' },
          {
            role: 'tool',
            name: 'history_search',
            args: { query: 'personas table columns' },
            content: 'personas table: no model_name, no available_tools, no memory.',
          },
          { role: 'assistant', content: 'In the schema itself.' },
        ],
      }],
    });
    await seeded.start();
    mock = seeded;

    const list = (await seededGet('/conversations')).body;
    const { body } = await seededGet(`/conversations/${list[0].id}`);
    expect(body.messages[1]).toMatchObject({
      role: 'tool',
      name: 'history_search',
      tool_args: { query: 'personas table columns' },
      tool_status: 'success',
    });
    // A tool turn is nobody's, so the rail prints no speaker above it.
    expect(body.messages[1]).not.toHaveProperty('persona_id');
  });

  it('refuses a seed naming a persona that does not exist', () => {
    expect(() => new MockBackend({
      personas: [{ id: 1, name: 'Kurisu' }],
      conversations: [
        { title: 'Nobody answers this', persona: 'Nobody', agoMinutes: 1, messages: [] },
      ],
    })).toThrow(/no persona named "Nobody"/);
  });
});

describe('mock backend: skills and models', () => {
  /**
   * `/skills` used to be a hardcoded empty list, so the Skills screen could only
   * ever be photographed empty and its New skill button fell through to the
   * catch-all `{}` (#195). It mirrors `routers/skills.py` now.
   */

  let furnished: MockBackend;

  beforeEach(async () => {
    await mock.stop();
    furnished = new MockBackend({
      skills: [
        { id: 1, name: 'Concise replies', instructions: 'Answer in at most five sentences.' },
        { id: 2, name: 'Cite the file', instructions: 'Name the file and line you read it from.' },
      ],
      models: [{ name: 'qwen3:8b', provider: 'ollama' }, { name: 'qwen3:4b' }],
    });
    await furnished.start();
    mock = furnished;
  });

  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${furnished.url}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('lists seeded skills in the order they are appended to the prompt', async () => {
    const { body } = await call('/skills');
    expect(body.map((k: any) => k.name)).toEqual(['Concise replies', 'Cite the file']);
    expect(body[0]).toMatchObject({ id: 1, instructions: 'Answer in at most five sentences.' });
    expect(typeof body[0].created_at).toBe('string');
  });

  it('creates, renames and deletes a skill', async () => {
    const made = await call('/skills', json('POST', { name: 'Tool discipline', instructions: 'One call.' }));
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ id: 3, name: 'Tool discipline' });

    const renamed = await call('/skills/3', json('PATCH', { name: 'Tool budget' }));
    expect(renamed.body).toMatchObject({ id: 3, name: 'Tool budget', instructions: 'One call.' });

    expect((await call('/skills/3', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/skills')).body.map((k: any) => k.id)).toEqual([1, 2]);
    expect((await call('/skills/3', json('PATCH', { name: 'Gone' }))).status).toBe(404);
  });

  it('refuses a skill with no name, as the backend does', async () => {
    expect((await call('/skills', json('POST', { name: '  ' }))).status).toBe(400);
    expect((await call('/skills/1', json('PATCH', { name: '' }))).status).toBe(400);
  });

  it('offers the scenario\'s models, not a hardcoded one', async () => {
    // The Assistant screen's picker reads this; it has to be able to name the
    // model the assistant is actually set to.
    const { body } = await call('/models');
    expect(body.models).toEqual([
      { name: 'qwen3:8b', provider: 'ollama' },
      { name: 'qwen3:4b', provider: 'ollama' },
    ]);
    expect(body.unavailable).toEqual([]);
  });
});

describe('mock backend: streaming', () => {
  it('sets persona fields on assistant chunks only, and tool metadata on tool chunks', async () => {
    mock.setStream({
      chunks: [
        { content: 'Let me check. ', role: 'assistant' },
        { content: '{"result":"42"}', role: 'tool', name: 'lookup', toolKind: 'sub_agent', durationMs: 250 },
        { content: 'It is 42.', role: 'assistant' },
      ],
    });
    const chunks = (await chat({ conversation_id: null })).filter((e) => e.type === 'stream_chunk');

    expect(chunks[0]).toMatchObject({
      persona_id: 1, persona_name: 'Kurisu', name: 'Kurisu', tool_kind: null, duration_ms: null,
    });
    // A tool chunk is not the persona speaking: `name` is the tool's own label,
    // and tool_kind/duration_ms are the client's only source for the sub-agent
    // tag and the call timing.
    expect(chunks[1]).toMatchObject({
      persona_id: null, persona_name: null, name: 'lookup',
      tool_kind: 'sub_agent', duration_ms: 250, tool_status: 'success',
    });
    expect(chunks[2].persona_id).toBe(1);
  });

  it('scripts a persona handoff by changing persona_id mid-stream', async () => {
    const other = mock.addPersona({ name: 'Amadeus' });
    mock.setStream({
      chunks: [
        { content: 'Kurisu here. ', role: 'assistant' },
        { content: 'Amadeus here.', role: 'assistant', personaId: other.id },
      ],
    });
    const chunks = (await chat({ conversation_id: null })).filter((e) => e.type === 'stream_chunk');
    expect(chunks.map((c) => c.persona_id)).toEqual([1, other.id]);
    expect(chunks.map((c) => c.persona_name)).toEqual(['Kurisu', 'Amadeus']);

    // And the two speakers are stored as two messages, not one run-together blob.
    const { body } = await get(`/conversations/${chunks[0].conversation_id}`);
    const assistantMessages = body.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMessages.map((m: any) => m.content)).toEqual(['Kurisu here. ', 'Amadeus here.']);
  });

  it('reports the last turn on a later connect, so a reconnect knows who spoke', async () => {
    const events = await chat({ conversation_id: null });
    const conversationId = events.find((e) => e.type === 'stream_chunk').conversation_id;

    const ws = connect();
    const connected = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.close();
    expect(connected).toMatchObject({
      type: 'connected', chat_active: false, conversation_id: conversationId, persona_id: 1,
    });
  });
});

describe('mock backend: compaction', () => {
  it('answers compact_context with context_info twice and compacts in place', async () => {
    // The server stopped forking in #99: the summary lands on the conversation
    // that was already open, and the closing context_info is what stops the
    // client's spinner.
    const conversationId = (await chat({ conversation_id: null }))
      .find((e) => e.type === 'stream_chunk').conversation_id;

    const ws = connect();
    const infos: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'conversation_switched') {
          reject(new Error('compaction forked instead of trimming in place'));
        }
        if (event.type === 'connected') {
          ws.send(JSON.stringify({ type: 'compact_context', conversation_id: conversationId }));
        }
        if (event.type === 'context_info') {
          infos.push(event);
          if (infos.length === 2) resolve();
        }
      });
    });
    ws.close();

    expect(infos.map((i) => i.compacting)).toEqual([true, false]);
    expect(infos[1].conversation_id).toBe(conversationId);
    expect(infos[1].compacted_context).toContain('Summary of conversation');
    expect(infos[1].compacted_up_to_id).toBeGreaterThan(0);

    // One conversation, carrying the summary and the watermark.
    expect(mock.getConversations()).toHaveLength(1);
    const stored = mock.getConversation(conversationId)!;
    expect(stored.compacted_context).toContain('Summary of conversation');
    expect(stored.compacted_up_to_id).toBe(infos[1].compacted_up_to_id);
  });
});

describe('mock backend: handshake', () => {
  it('closes with 4426 when the client declares a different wire protocol', async () => {
    const ws = connect(WIRE_PROTOCOL + 1);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(WS_WIRE_PROTOCOL_MISMATCH);
  });

  it('serves a client on the matching wire protocol', async () => {
    const ws = connect();
    const first = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.close();
    expect(first.type).toBe('connected');
  });
});

describe('Kurisu Drive', () => {
  /**
   * The mock is the only description of the drive the Playwright suite sees, so
   * a wrong shape here does not fail loudly — it makes the specs agree with a
   * server that does not exist. These pin the shapes `fileSource` reads.
   *
   * Ownership is deliberately not tested here: this mock authenticates nobody.
   * Who may read whose files is settled in the backend's own `db` suite.
   */

  let drive: MockBackend;

  beforeEach(async () => {
    await mock.stop();
    drive = new MockBackend({
      drive: [
        { path: '/Reports/Q3-revenue-notes.md', content: '# Q3 revenue notes' },
        { path: '/Reports/weekly', isDir: true },
        { path: '/Notes/reading-list.md', content: '# Reading list' },
      ],
    });
    await drive.start();
    mock = drive;
  });

  const driveGet = async (path: string) => {
    const res = await fetch(`${drive.url}${path}`);
    return { status: res.status, body: await res.json() };
  };

  /** Raw body, destination in the query string — the real upload's shape. */
  const upload = (
    name: string,
    content: string | Uint8Array,
    options: { parentId?: number; overwrite?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ name });
    if (options.parentId !== undefined) params.set('parent_id', String(options.parentId));
    if (options.overwrite) params.set('overwrite', 'true');
    return fetch(`${drive.url}/drive/files?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
  };

  it('lists the top of the drive, folders first', async () => {
    const { status, body } = await driveGet('/drive/nodes');
    expect(status).toBe(200);
    expect(body.map((n: any) => n.name)).toEqual(['Notes', 'Reports']);
    expect(body.every((n: any) => n.is_dir)).toBe(true);
  });

  it('lists a folder by its parent id', async () => {
    const roots = (await driveGet('/drive/nodes')).body;
    const reports = roots.find((n: any) => n.name === 'Reports');

    const { body } = await driveGet(`/drive/nodes?parent_id=${reports.id}`);

    expect(body.map((n: any) => n.name)).toEqual(['weekly', 'Q3-revenue-notes.md']);
  });

  it('resolves a path to the node it names', async () => {
    const { status, body } = await driveGet('/drive/resolve?path=/Reports/Q3-revenue-notes.md');
    expect(status).toBe(200);
    expect(body.name).toBe('Q3-revenue-notes.md');
    expect(body.is_dir).toBe(false);
    expect(body.mime).toBe('text/markdown');
  });

  it('404s a path that is not there, rather than answering an empty object', async () => {
    // The catch-all below the drive routes returns `{}` with a 200. A missing
    // route would look like an empty folder; this proves the route exists.
    const { status } = await driveGet('/drive/resolve?path=/Nowhere');
    expect(status).toBe(404);
  });

  it('serves a file back as an attachment', async () => {
    const node = (await driveGet('/drive/resolve?path=/Notes/reading-list.md')).body;
    const res = await fetch(`${drive.url}/drive/files/${node.id}/content`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('# Reading list');
  });

  it('accepts a raw-body upload and lists it afterwards', async () => {
    const res = await upload('greeting.txt', 'hello drive');

    const node = await res.json();
    expect(res.status).toBe(200);
    expect(node.name).toBe('greeting.txt');
    expect(node.size).toBe('hello drive'.length);
    expect(drive.lastDriveUpload).toEqual({ name: 'greeting.txt', parent_id: null, bytes: 11 });
    expect(drive.getDrivePaths()).toContain('/greeting.txt');
  });

  it('uploads a file with binary bytes intact', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13]);
    await upload('raw.bin', bytes);

    const node = (await driveGet('/drive/resolve?path=/raw.bin')).body;
    const res = await fetch(`${drive.url}/drive/files/${node.id}/content`);

    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it('refuses a duplicate name and accepts an overwrite', async () => {
    expect((await upload('twice.txt', 'first')).status).toBe(200);
    expect((await upload('twice.txt', 'second')).status).toBe(409);
    expect((await upload('twice.txt', 'second', { overwrite: true })).status).toBe(200);

    const node = (await driveGet('/drive/resolve?path=/twice.txt')).body;
    const res = await fetch(`${drive.url}/drive/files/${node.id}/content`);
    expect(await res.text()).toBe('second');
  });

  it('refuses an upload that would overrun the quota', async () => {
    await drive.stop();
    drive = new MockBackend({ driveQuotaBytes: 8 });
    await drive.start();
    mock = drive;

    expect((await upload('big.bin', 'far too many bytes')).status).toBe(507);
  });

  it('lets an overwrite reuse the bytes it is replacing', async () => {
    // The backend subtracts what a replaced file releases before checking the
    // quota. A mock that forgot to would answer 507 where the server answers
    // 200 — and a spec written against it would be wrong about the server.
    await drive.stop();
    drive = new MockBackend({ driveQuotaBytes: 10 });
    await drive.start();
    mock = drive;

    expect((await upload('exact.bin', '0123456789')).status).toBe(200);
    expect((await upload('exact.bin', 'abcdefghij', { overwrite: true })).status).toBe(200);
  });

  it('decides a duplicate name before it decides the quota', async () => {
    await drive.stop();
    drive = new MockBackend({ driveQuotaBytes: 4 });
    await drive.start();
    mock = drive;

    await upload('taken.txt', 'abcd');
    // Over quota *and* a duplicate. The backend answers 409, because it settles
    // the name before it ever reads the body.
    expect((await upload('taken.txt', 'far too many bytes')).status).toBe(409);
  });

  it('refuses an upload into a parent that is not there', async () => {
    expect((await upload('orphan.txt', 'x', { parentId: 9999 })).status).toBe(404);
    expect(drive.getDrivePaths()).not.toContain('/orphan.txt');
  });

  it('refuses a name the backend would refuse, on upload as well as on mkdir', async () => {
    for (const name of ['..', 'a/b', ' leading', 'trailing ', '']) {
      expect((await upload(name, 'x')).status, name).toBe(400);
    }
  });

  it('answers 400 when an id names the wrong kind of node', async () => {
    const reports = (await driveGet('/drive/resolve?path=/Reports')).body;
    const file = (await driveGet('/drive/resolve?path=/Reports/Q3-revenue-notes.md')).body;

    // A folder is not a file...
    expect((await fetch(`${drive.url}/drive/files/${reports.id}/content`)).status).toBe(400);
    // ...and a file is not a folder.
    expect((await driveGet(`/drive/nodes?parent_id=${file.id}`)).status).toBe(400);
  });


  it('creates a folder, and refuses a name that would look like a path', async () => {
    const create = (name: string) =>
      fetch(`${drive.url}/drive/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id: null }),
      });

    expect((await create('Receipts')).status).toBe(200);
    expect((await create('Receipts')).status).toBe(409);
    expect((await create('a/b')).status).toBe(400);
    expect((await create('..')).status).toBe(400);
  });

  it('renames and moves', async () => {
    const notes = (await driveGet('/drive/resolve?path=/Notes')).body;
    const file = (await driveGet('/drive/resolve?path=/Reports/Q3-revenue-notes.md')).body;

    const res = await fetch(`${drive.url}/drive/nodes/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'q3.md', parent_id: notes.id }),
    });

    expect(res.status).toBe(200);
    expect(drive.getDrivePaths()).toContain('/Notes/q3.md');
  });

  it('refuses to move a folder into itself', async () => {
    const reports = (await driveGet('/drive/resolve?path=/Reports')).body;
    const weekly = (await driveGet('/drive/resolve?path=/Reports/weekly')).body;

    const res = await fetch(`${drive.url}/drive/nodes/${reports.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: weekly.id }),
    });

    expect(res.status).toBe(409);
  });

  it('deletes a folder and everything under it', async () => {
    const reports = (await driveGet('/drive/resolve?path=/Reports')).body;

    const res = await fetch(`${drive.url}/drive/nodes/${reports.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(drive.getDrivePaths()).toEqual(['/Notes', '/Notes/reading-list.md']);
  });

  it('writes a file in place, which is what the editor Save does', async () => {
    const node = (await driveGet('/drive/resolve?path=/Notes/reading-list.md')).body;

    await fetch(`${drive.url}/drive/files/${node.id}/content`, {
      method: 'PUT',
      body: '# Rewritten',
    });

    const res = await fetch(`${drive.url}/drive/files/${node.id}/content`);
    expect(await res.text()).toBe('# Rewritten');
  });

  it('reports usage, counting files and not folders', async () => {
    const { body } = await driveGet('/drive/usage');
    expect(body.file_count).toBe(2);
    expect(body.used_bytes).toBe('# Q3 revenue notes'.length + '# Reading list'.length);
    expect(body.quota_bytes).toBeGreaterThan(0);
  });
});
