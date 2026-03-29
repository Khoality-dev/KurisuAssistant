/**
 * Client-side slash command system.
 *
 * Commands are parsed and executed entirely on the frontend.
 * Add new commands to the `commands` array below.
 */

import { wsManager } from '../api/websocket';
import { useConversationStore } from '../store/conversationStore';
import { storage } from './storage';

export interface CommandContext {
  activeConversationId: number | null;
  agentId: number | null;
}

interface Command {
  name: string;
  description: string;
  execute: (args: string, ctx: CommandContext) => void;
}

const commands: Command[] = [
  {
    name: 'compact',
    description: 'Compact conversation context to free up token space',
    execute: (_args, ctx) => {
      if (ctx.activeConversationId) {
        wsManager.send({ type: 'compact_context', conversation_id: ctx.activeConversationId });
      }
    },
  },
  {
    name: 'clear',
    description: 'Clear the current conversation',
    execute: async (_args, ctx) => {
      if (ctx.activeConversationId) {
        const convStore = useConversationStore.getState();
        await convStore.deleteConversation(ctx.activeConversationId);
        if (ctx.agentId) {
          storage.clearAgentConversationId(ctx.agentId);
        } else {
          storage.clearAgentConversationId('group');
        }
      }
    },
  },
];

/**
 * Try to handle text as a slash command.
 * Returns true if the text was a command (handled), false otherwise.
 */
export function handleCommand(text: string, ctx: CommandContext): boolean {
  if (!text.startsWith('/')) return false;

  const spaceIdx = text.indexOf(' ');
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  const cmd = commands.find((c) => c.name === name);
  if (!cmd) return false;

  cmd.execute(args, ctx);
  return true;
}

/** Get all registered commands (for autocomplete/help). */
export function getCommands(): { name: string; description: string }[] {
  return commands.map((c) => ({ name: c.name, description: c.description }));
}
