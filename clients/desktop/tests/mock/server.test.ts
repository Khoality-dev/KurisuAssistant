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
} from '../../src/constants';

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
  it('answers compact_context with context_info then conversation_switched', async () => {
    const oldId = (await chat({ conversation_id: null })).find((e) => e.type === 'stream_chunk').conversation_id;

    const ws = connect();
    const events: any[] = [];
    const switched = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
        if (event.type === 'connected') {
          ws.send(JSON.stringify({ type: 'compact_context', conversation_id: oldId }));
        }
        if (event.type === 'conversation_switched') resolve(event);
      });
    });
    ws.close();

    expect(events.some((e) => e.type === 'context_info' && e.compacting === true)).toBe(true);
    expect(switched.old_conversation_id).toBe(oldId);
    expect(switched.new_conversation_id).not.toBe(oldId);
    // The persona follows the conversation across the split.
    expect(switched.persona_id).toBe(1);
    expect(mock.getConversation(switched.new_conversation_id)!.persona_id).toBe(1);
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
