// @vitest-environment node
/**
 * The app-tool schemas and their handlers must stay in lockstep.
 *
 * A schema in `electron/appTools.ts` with no case in `appToolsHandler.ts` is not
 * a harmless stub: the model is told the tool exists, pays for its schema in
 * every request, calls it, and gets "Unknown app tool". That is exactly how the
 * pre-split persona quartet survived — advertised, never wired, never noticed.
 *
 * Read as source text rather than imported, because the schema module pulls in
 * `electron` and the MCP SDK, neither of which loads outside the main process.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const schemaSource = readFileSync(path.join(ROOT, 'electron/appTools.ts'), 'utf8');
const handlerSource = readFileSync(path.join(ROOT, 'src/services/appToolsHandler.ts'), 'utf8');

const matchAll = (source: string, re: RegExp) =>
  new Set(Array.from(source.matchAll(re), (m) => m[1]));

/** Names in the APP_TOOL_NAMES set — what `app-tools:is-app-tool` will claim. */
const declaredNames = matchAll(
  schemaSource.slice(0, schemaSource.indexOf('function getAppToolSchemas')),
  /'(app_[a-z_]+)'/g,
);
/** Names actually advertised to the model. */
const advertised = matchAll(schemaSource, /name: '(app_[a-z_]+)'/g);
/** Names the renderer can actually execute. */
const dispatched = matchAll(handlerSource, /case '(app_[a-z_]+)'/g);

// Handled in the main process before the IPC round-trip, so it has no renderer case.
const MAIN_PROCESS_ONLY = new Set(['app_launch_browser']);

describe('app tools', () => {
  it('advertises exactly the names it claims to own', () => {
    expect([...advertised].sort()).toEqual([...declaredNames].sort());
  });

  it('has a handler for every advertised tool', () => {
    const orphans = [...advertised].filter((n) => !dispatched.has(n) && !MAIN_PROCESS_ONLY.has(n));
    expect(orphans).toEqual([]);
  });

  it('advertises every tool it can handle', () => {
    expect([...dispatched].filter((n) => !advertised.has(n))).toEqual([]);
  });

  it('splits capability and presentation into separate tools', () => {
    // Capability (model, tools, memory, wake word) is the assistant's; a name,
    // prompt, voice or avatar is a persona's. The pre-split app_update_agent
    // took both in one allowlist and could not say which it was writing.
    expect(advertised.has('app_update_assistant')).toBe(true);
    expect(advertised.has('app_update_persona')).toBe(true);
    // And the resource that no longer exists must not be advertised at all.
    for (const gone of ['app_get_agents', 'app_create_agent', 'app_update_agent', 'app_delete_agent']) {
      expect(advertised.has(gone)).toBe(false);
    }
  });

  it('keeps capability fields off the persona tool and presentation off the assistant tool', () => {
    const paramsOf = (toolName: string) => {
      const at = schemaSource.indexOf(`name: '${toolName}'`);
      expect(at).toBeGreaterThan(-1);
      const next = schemaSource.indexOf("name: 'app_", at + 1);
      return schemaSource.slice(at, next === -1 ? undefined : next);
    };

    const persona = paramsOf('app_update_persona');
    for (const capability of ['model_name', 'available_tools', 'memory', 'trigger_word', 'think']) {
      expect(persona).not.toContain(`${capability}:`);
    }

    const assistant = paramsOf('app_update_assistant');
    for (const presentation of ['name:', 'system_prompt:', 'voice_reference:', 'avatar_uuid:']) {
      expect(assistant).not.toContain(`            ${presentation}`);
    }
  });
});
