/**
 * The rules behind the host-tool approval gate: what a decision is keyed on,
 * which paths a call would touch, and whether a path is inside the granted
 * scope.
 *
 * Kept free of `electron` imports so it can be unit-tested directly
 * (`tests/hostToolPolicy.test.ts`). The gate itself — dialogs, persistence,
 * session state — stays in `hostTools.ts`.
 */

import fs from 'fs';
import path from 'path';

export const HOST_TOOL_NAMES = new Set([
  'host_read',
  'host_write',
  'host_edit',
  'host_search',
  'host_list',
  'host_bash',
]);

/**
 * Resolve a path the way policy decisions must see it.
 *
 * `path.resolve` alone normalises `..` but follows nothing, so a symlink inside
 * an allowed directory pointing at `/etc` would pass a prefix test while
 * reading somewhere else entirely. Real paths are compared instead. For a file
 * that does not exist yet — every `host_write` of a new file — the parent is
 * resolved and the name appended, which is the directory that actually decides
 * where the write lands.
 */
export function resolveForPolicy(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // Missing leaf: resolve as much of the parent as exists.
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    try {
      return path.join(fs.realpathSync(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * Is `target` inside one of `allowed`?
 *
 * A directory grants its whole subtree; a file grants only itself. An empty
 * list grants nothing — with no rules configured every call is asked about, and
 * refused if the answer is no.
 */
export function isPathAllowed(target: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  const resolved = resolveForPolicy(target);
  return allowed.some((entry) => {
    const base = resolveForPolicy(entry);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

/**
 * Normalise a shell command for comparison: trimmed, with runs of whitespace
 * collapsed. Nothing else — no reordering, no unquoting. Two commands compare
 * equal only if they would do the same thing.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * The key a decision is remembered under.
 *
 * For `host_bash` this is the **whole normalised command**. Keying it on the
 * first token — what this did before — meant approving `git status` with
 * "Always" persisted a rule for `git`, and since the token split included `;`,
 * `&` and `|`, any later command *beginning* with `git` was auto-approved no
 * matter what came after the separator. The model chooses that string, and what
 * the model writes is influenced by whatever is already in the conversation.
 *
 * `host_list` and `host_search` are keyed per directory; the remaining tools
 * are keyed by name alone, because their scope is the path grant, not the key.
 */
export function ruleKeyFor(
  toolName: string,
  args: Record<string, unknown>,
  allowedPaths: string[],
): string {
  if (toolName === 'host_list' || toolName === 'host_search') {
    const targetPath = args.path as string | undefined;
    const effective = targetPath
      ? resolveForPolicy(targetPath)
      : allowedPaths.length > 0
        ? resolveForPolicy(allowedPaths[0])
        : null;
    if (effective) return `${toolName}:${effective}`;
  }
  if (toolName === 'host_bash') {
    const command = normalizeCommand((args.command as string) || '');
    if (command) return `host_bash:${command}`;
  }
  return toolName;
}

/**
 * The filesystem locations a call would touch, resolved.
 *
 * `host_bash` contributes its working directory only: the command itself can go
 * anywhere, which is why bash approval is the command string rather than a path
 * grant. An empty list means the call has no path to check.
 */
export function targetPathsFor(
  toolName: string,
  args: Record<string, unknown>,
  allowedPaths: string[],
): string[] {
  const fallback = allowedPaths.length > 0 ? allowedPaths[0] : undefined;
  const explicit = args.path as string | undefined;

  switch (toolName) {
    case 'host_read':
    case 'host_write':
    case 'host_edit':
    case 'host_list':
      return explicit ? [resolveForPolicy(explicit)] : [];
    case 'host_search': {
      const target = explicit ?? fallback;
      return target ? [resolveForPolicy(target)] : [];
    }
    case 'host_bash': {
      const workdir = (args.workdir as string | undefined) ?? fallback;
      return workdir ? [resolveForPolicy(workdir)] : [];
    }
    default:
      return [];
  }
}

/**
 * What "Always" should remember for a path-taking call.
 *
 * The exact path, not its parent. Choosing Always on one file used to add the
 * whole containing directory, so a single approval on something in the home
 * directory granted the home directory. A directory target still grants its
 * subtree — that is what a directory means here.
 */
export function alwaysGrantFor(target: string): string {
  return resolveForPolicy(target);
}
