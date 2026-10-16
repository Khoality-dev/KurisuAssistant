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
// The two halves no longer live in the same package: the schema table is still
// this app's main process, while the dispatch that implements it moved to
// @kurisu/state, because it is renderer code that needs no Electron (#187).
// That split is exactly why this check has to keep existing.
const handlerSource = readFileSync(
  path.join(ROOT, '../../packages/state/src/appToolsHandler.ts'),
  'utf8',
);

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
    for (const capability of ['model_name', 'permission_mode', 'memory', 'trigger_word', 'think']) {
      expect(persona).not.toContain(`${capability}:`);
    }

    const assistant = paramsOf('app_update_assistant');
    for (const presentation of ['name:', 'system_prompt:', 'voice_reference:', 'avatar_uuid:']) {
      expect(assistant).not.toContain(`            ${presentation}`);
    }
  });

  it('cannot change the permission mode, nor bring back a tool list (#360)', () => {
    const at = schemaSource.indexOf("name: 'app_update_assistant'");
    const next = schemaSource.indexOf("name: 'app_", at + 1);
    const assistant = schemaSource.slice(at, next);
    expect(assistant).not.toContain('permission_mode');
    expect(assistant).not.toContain('available_tools');

    const handler = handlerSource.slice(
      handlerSource.indexOf('async function handleUpdateAssistant'),
      handlerSource.indexOf('async function', handlerSource.indexOf('async function handleUpdateAssistant') + 1),
    );
    expect(handler).not.toContain("'permission_mode'");
  });

  it('says which app tools only look, so Read only runs them (#360)', () => {
    const declared = schemaSource.slice(
      schemaSource.indexOf('APP_READ_ONLY_TOOLS'),
      schemaSource.indexOf(']);', schemaSource.indexOf('APP_READ_ONLY_TOOLS')),
    );
    const readOnly = matchAll(declared, /'(app_[a-z_]+)'/g);
    expect([...readOnly].sort()).toEqual([
      'app_get_assistant', 'app_get_open_files', 'app_get_personas',
      'app_list_mcp_servers', 'app_list_skills', 'app_list_tools',
    ]);
    for (const name of readOnly) expect(advertised.has(name)).toBe(true);
  });
});
