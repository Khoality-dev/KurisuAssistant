/**
 * Settings › Tools lists what the assistant has, by where it runs (#360): the
 * server's own features, what this desktop lends, the user's MCP servers. Every
 * tool is tagged by whether it only looks — what Read only runs — and a tool that
 * does not say counts as changing something.
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from '@kurisu/models';
import { buildToolCatalog } from './toolCatalog';

const tool = (name: string, read_only?: boolean, description = ''): Tool => ({
  type: 'function',
  function: { name, description, parameters: {} },
  ...(read_only === undefined ? {} : { read_only }),
});

describe('the tool catalogue', () => {
  const catalog = buildToolCatalog({
    serverTools: [
      tool('calendar_list', true), tool('calendar_create', false),
      tool('task_list', true), tool('task_start', false),
      tool('drive_read', true), tool('drive_write', false),
      tool('history_list', true), tool('recall_regex', true),
      tool('notify_user', true), tool('get_skill_instructions', true),
    ],
    mcpServers: { Weather: [tool('get_weather', true), tool('set_units', false)], Lights: [tool('toggle')] },
    clientTools: [tool('host_read', true), tool('host_bash', false), tool('app_navigate', false), tool('app_get_open_files', true)],
    clientToolsByServer: { Playwright: [tool('browser_snapshot', true), tool('browser_click')] },
  });

  it('groups the server\'s own tools by feature', () => {
    expect(catalog.kurisu.map((g) => [g.name, g.tools.map((t) => t.name)])).toEqual([
      ['Calendar', ['calendar_list', 'calendar_create']],
      ['Tasks', ['task_list', 'task_start']],
      ['Kurisu Drive', ['drive_read', 'drive_write']],
      ['History and recall', ['history_list', 'recall_regex']],
      ['Other', ['notify_user', 'get_skill_instructions']],
    ]);
  });

  it('groups what this desktop lends, its local MCP servers included', () => {
    expect(catalog.desktop.map((g) => [g.name, g.tools.map((t) => t.name)])).toEqual([
      ['Files and commands', ['host_read', 'host_bash']],
      ['App control', ['app_navigate', 'app_get_open_files']],
      ['Playwright', ['browser_snapshot', 'browser_click']],
    ]);
  });

  it('keeps the user\'s MCP servers by server', () => {
    expect(Object.keys(catalog.mcp)).toEqual(['Weather', 'Lights']);
  });

  it('tags each tool by whether it only looks, and an unsaid tool changes something', () => {
    const effect = (name: string) =>
      [...catalog.kurisu, ...catalog.desktop].flatMap((g) => g.tools)
        .concat(...Object.values(catalog.mcp))
        .find((t) => t.name === name)!.effect;
    expect(effect('drive_read')).toBe('reads');
    expect(effect('drive_write')).toBe('changes');
    expect(effect('host_read')).toBe('reads');
    expect(effect('get_weather')).toBe('reads');
    expect(effect('toggle')).toBe('changes');
    expect(effect('browser_click')).toBe('changes');
  });

  it('leaves out an empty group', () => {
    const bare = buildToolCatalog({ serverTools: [tool('notify_user', true)], mcpServers: {}, clientTools: [], clientToolsByServer: {} });
    expect(bare.kurisu.map((g) => g.name)).toEqual(['Other']);
    expect(bare.desktop).toEqual([]);
  });
});
