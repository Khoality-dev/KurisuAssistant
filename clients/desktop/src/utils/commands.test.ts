import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleCommand, getCommands } from './commands';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// commands.ts uses dynamic imports for the conversation store, storage, and
// apiClient. We intercept those so each test runs in isolation.

vi.mock('../store/conversationStore', () => {
  const state = {
    deleteConversation: vi.fn(async (_id: number) => {}),
    clearCurrentConversation: vi.fn(),
    loadConversation: vi.fn(async (_id: number) => {}),
  };
  return {
    useConversationStore: {
      getState: () => state,
      __state: state,
    },
  };
});

vi.mock('./storage', () => {
  return {
    storage: {
      clearAgentConversationId: vi.fn(),
      setAgentConversationId: vi.fn(),
    },
  };
});

vi.mock('../api/client', () => {
  return {
    apiClient: {
      getLatestConversationForAgent: vi.fn(async (_id: number) => null),
    },
  };
});

vi.mock('../api/websocket', () => {
  return {
    wsManager: {
      send: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the expected command set', () => {
    const names = getCommands().map((c) => c.name).sort();
    expect(names).toEqual([
      'agents',
      'clear',
      'compact',
      'context',
      'delete',
      'live-animate',
      'refresh',
      'resume',
      'vision',
    ]);
  });

  it('returns null for non-command input', async () => {
    expect(await handleCommand('hello there', { activeConversationId: null, agentId: null })).toBeNull();
    expect(await handleCommand('not-a-command', { activeConversationId: 1, agentId: 1 })).toBeNull();
  });

  it('returns null for unknown command', async () => {
    expect(await handleCommand('/notARealCommand', { activeConversationId: 1, agentId: 1 })).toBeNull();
  });

  describe('/clear', () => {
    it('clears store + storage without deleting from DB', async () => {
      const { useConversationStore } = await import('../store/conversationStore');
      const { storage } = await import('./storage');
      const result = await handleCommand('/clear', { activeConversationId: 7, agentId: 3 });

      expect(result).toBe('Started a new conversation');
      const state = (useConversationStore as any).__state;
      expect(state.clearCurrentConversation).toHaveBeenCalledOnce();
      expect(state.deleteConversation).not.toHaveBeenCalled();
      expect(storage.clearAgentConversationId).toHaveBeenCalledWith(3);
    });

    it('falls back to "group" key when no agent is selected', async () => {
      const { storage } = await import('./storage');
      await handleCommand('/clear', { activeConversationId: 7, agentId: null });
      expect(storage.clearAgentConversationId).toHaveBeenCalledWith('group');
    });
  });

  describe('/delete', () => {
    it('calls deleteConversation and clears the storage mapping', async () => {
      const { useConversationStore } = await import('../store/conversationStore');
      const { storage } = await import('./storage');
      const result = await handleCommand('/delete', { activeConversationId: 7, agentId: 3 });

      expect(result).toBe('Conversation deleted');
      const state = (useConversationStore as any).__state;
      expect(state.deleteConversation).toHaveBeenCalledWith(7);
      expect(storage.clearAgentConversationId).toHaveBeenCalledWith(3);
    });

    it('refuses when there is no active conversation', async () => {
      const { useConversationStore } = await import('../store/conversationStore');
      const result = await handleCommand('/delete', { activeConversationId: null, agentId: 3 });
      expect(result).toBe('No active conversation');
      const state = (useConversationStore as any).__state;
      expect(state.deleteConversation).not.toHaveBeenCalled();
    });
  });

  describe('/resume', () => {
    it('dispatches the picker event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      const result = await handleCommand('/resume', { activeConversationId: 1, agentId: 3 });
      expect(result).toBe('');
      expect(spy).toHaveBeenCalled();
      const evt = spy.mock.calls[0][0] as Event;
      expect(evt.type).toBe('kurisu:open-resume-picker');
    });

    it('refuses when no agent is selected', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      const result = await handleCommand('/resume', { activeConversationId: 1, agentId: null });
      expect(result).toBe('No agent selected');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('/context', () => {
    it('dispatches the breakdown event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      await handleCommand('/context', { activeConversationId: 1, agentId: 3 });
      expect(spy.mock.calls[0][0].type).toBe('kurisu:open-context-breakdown');
    });

    it('refuses when no active conversation', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      const result = await handleCommand('/context', { activeConversationId: null, agentId: 3 });
      expect(result).toBe('No active conversation');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('/agents', () => {
    it('dispatches the agent-picker event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      await handleCommand('/agents', { activeConversationId: null, agentId: null });
      expect(spy.mock.calls[0][0].type).toBe('kurisu:open-agent-picker');
    });
  });

  describe('/refresh', () => {
    it('dispatches the refresh event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      await handleCommand('/refresh', { activeConversationId: 1, agentId: 3 });
      expect(spy.mock.calls[0][0].type).toBe('kurisu:refresh-conversation');
    });

    it('refuses when no active conversation', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      const result = await handleCommand('/refresh', { activeConversationId: null, agentId: 3 });
      expect(result).toBe('No active conversation');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('/live-animate', () => {
    it('dispatches the toggle-character event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      await handleCommand('/live-animate', { activeConversationId: null, agentId: null });
      expect(spy.mock.calls[0][0].type).toBe('kurisu:toggle-character');
    });
  });

  describe('/vision', () => {
    it('dispatches the toggle-vision event', async () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      await handleCommand('/vision', { activeConversationId: null, agentId: null });
      expect(spy.mock.calls[0][0].type).toBe('kurisu:toggle-vision');
    });
  });

  describe('/compact', () => {
    it('sends compact_context over the WebSocket', async () => {
      const { wsManager } = await import('../api/websocket');
      const result = await handleCommand('/compact', { activeConversationId: 42, agentId: 3 });
      expect(result).toBe('Compacting context…');
      expect(wsManager.send).toHaveBeenCalledWith({ type: 'compact_context', conversation_id: 42 });
    });

    it('refuses when no active conversation', async () => {
      const { wsManager } = await import('../api/websocket');
      const result = await handleCommand('/compact', { activeConversationId: null, agentId: 3 });
      expect(result).toBe('No active conversation');
      expect(wsManager.send).not.toHaveBeenCalled();
    });
  });
});
