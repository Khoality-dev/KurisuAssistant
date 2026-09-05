/**
 * Client-side slash command system.
 *
 * Commands are parsed and executed entirely on the frontend.
 * Add new commands to the `commands` array below.
 */

export interface CommandContext {
  activeConversationId: number | null;
  personaId: number | null;
}

interface Command {
  name: string;
  description: string;
  execute: (args: string, ctx: CommandContext) => Promise<string> | string;
}

const commands: Command[] = [
  {
    name: 'clear',
    description: 'Start a new empty conversation (keeps the current one in history)',
    execute: async (_args, ctx) => {
      const { useConversationStore } = await import('../store/conversationStore');
      const { storage } = await import('./storage');
      const convStore = useConversationStore.getState();
      convStore.clearCurrentConversation();
      if (ctx.personaId) {
        storage.clearPersonaConversationId(ctx.personaId);
      } else {
        storage.clearPersonaConversationId('unbound');
      }
      return 'Started a new conversation';
    },
  },
  {
    name: 'delete',
    description: 'Permanently delete the current conversation',
    execute: async (_args, ctx) => {
      if (!ctx.activeConversationId) {
        return 'No active conversation';
      }
      const { useConversationStore } = await import('../store/conversationStore');
      const { storage } = await import('./storage');
      const convStore = useConversationStore.getState();
      await convStore.deleteConversation(ctx.activeConversationId);
      if (ctx.personaId) {
        storage.clearPersonaConversationId(ctx.personaId);
      } else {
        storage.clearPersonaConversationId('unbound');
      }
      return 'Conversation deleted';
    },
  },
  {
    name: 'resume',
    description: 'Pick a previous conversation to resume',
    execute: (_args, ctx) => {
      if (!ctx.personaId) {
        return 'No persona selected';
      }
      window.dispatchEvent(new Event('kurisu:open-resume-picker'));
      return '';
    },
  },
  {
    name: 'context',
    description: 'Show the context breakdown for the current conversation',
    execute: (_args, ctx) => {
      if (!ctx.activeConversationId) {
        return 'No active conversation';
      }
      window.dispatchEvent(new Event('kurisu:open-context-breakdown'));
      return '';
    },
  },
  {
    name: 'persona',
    description: 'Switch the persona answering in this conversation',
    execute: () => {
      window.dispatchEvent(new Event('kurisu:open-persona-picker'));
      return '';
    },
  },
  {
    name: 'refresh',
    description: 'Reload the current conversation from the server',
    execute: (_args, ctx) => {
      if (!ctx.activeConversationId) {
        return 'No active conversation';
      }
      window.dispatchEvent(new Event('kurisu:refresh-conversation'));
      return 'Reloading…';
    },
  },
  {
    name: 'live-animate',
    description: 'Toggle the animated character window',
    execute: () => {
      window.dispatchEvent(new Event('kurisu:toggle-character'));
      return '';
    },
  },
  {
    name: 'vision',
    description: 'Toggle the webcam vision pipeline on/off',
    execute: () => {
      window.dispatchEvent(new Event('kurisu:toggle-vision'));
      return '';
    },
  },
  {
    name: 'compact',
    description: 'Compact this conversation now (summarize older messages)',
    execute: async (_args, ctx) => {
      if (!ctx.activeConversationId) {
        return 'No active conversation';
      }
      const { wsManager } = await import('../api/websocket');
      wsManager.send({ type: 'compact_context', conversation_id: ctx.activeConversationId });
      return 'Compacting context…';
    },
  },
];

/**
 * Try to handle text as a slash command.
 * Returns feedback message if handled, null if not a command.
 */
export async function handleCommand(text: string, ctx: CommandContext): Promise<string | null> {
  if (!text.startsWith('/')) return null;

  const spaceIdx = text.indexOf(' ');
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  const cmd = commands.find((c) => c.name === name);
  if (!cmd) return null;

  return await cmd.execute(args, ctx);
}

/** Get all registered commands (for autocomplete/help). */
export function getCommands(): { name: string; description: string }[] {
  return commands.map((c) => ({ name: c.name, description: c.description }));
}
