/**
 * Consent for spawning a local MCP server.
 *
 * Starting a stdio MCP server means running a program on the user's machine
 * with their privileges. The command can come from a settings form, from an
 * agent tool (`app_add_mcp_server` writes rows a model composed), or from a
 * config the backend hands out — and the backend is a server someone else may
 * operate. None of those is the user saying yes, so the spawn asks, showing the
 * command and arguments exactly as they will be executed.
 *
 * The decision is remembered against the command line itself rather than the
 * server's name: renaming a server keeps its consent, editing what it runs asks
 * again.
 *
 * No `electron` import here, so the matching rules are unit-testable.
 */

export interface SpawnRequest {
  name: string;
  command?: string;
  args?: string[];
}

/**
 * The command line a consent decision is remembered against: the program and
 * its arguments, whitespace-normalised, joined with a space.
 */
export function commandLineFor(config: SpawnRequest): string {
  const parts = [config.command ?? '', ...(config.args ?? [])]
    .map((part) => String(part).trim())
    .filter((part) => part.length > 0);
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Has this exact command line been approved before? */
export function hasConsent(approved: string[], config: SpawnRequest): boolean {
  const line = commandLineFor(config);
  return line.length > 0 && approved.includes(line);
}

/** The approved list with this command line added, without duplicates. */
export function withConsent(approved: string[], config: SpawnRequest): string[] {
  const line = commandLineFor(config);
  if (!line || approved.includes(line)) return approved;
  return [...approved, line];
}

/** The approved list without this command line. */
export function withoutConsent(approved: string[], commandLine: string): string[] {
  return approved.filter((entry) => entry !== commandLine);
}

/**
 * What the prompt shows. The whole command line, unelided — a consent dialog
 * that truncates the interesting part is not consent.
 */
export function describeSpawn(config: SpawnRequest): string {
  return `${config.name} would run:\n\n${commandLineFor(config)}`;
}
