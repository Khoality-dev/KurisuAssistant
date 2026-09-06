// @vitest-environment node
/**
 * The standalone mock's argument parsing, and that every scenario builds and
 * serves — `npm run mock:backend -- --scenario x` must not be the first place
 * a broken script is discovered.
 */

import { describe, expect, it } from 'vitest';
import { createScenario, DEFAULT_PORT, listScenarios, parseArgs } from './cli';
import { DEFAULT_SCENARIO, SCENARIOS, scenarioNames } from './scenarios';

describe('parseArgs', () => {
  it('defaults to the conventional port, loopback and the default scenario', () => {
    expect(parseArgs([])).toEqual({
      port: DEFAULT_PORT, host: '127.0.0.1', scenario: DEFAULT_SCENARIO, list: false, help: false,
    });
  });

  it('reads --port, --host and --scenario, spaced or with =', () => {
    expect(parseArgs(['--port', '0', '--host', '0.0.0.0', '--scenario', 'handoff'])).toMatchObject({
      port: 0, host: '0.0.0.0', scenario: 'handoff',
    });
    expect(parseArgs(['--port=15598', '--scenario=no-model'])).toMatchObject({ port: 15598, scenario: 'no-model' });
  });

  it('refuses a scenario it does not have, naming the ones it does', () => {
    expect(() => parseArgs(['--scenario', 'nope'])).toThrow(/unknown scenario "nope".*tool-call/);
  });

  it('refuses a port that is not one', () => {
    expect(() => parseArgs(['--port', 'eighty'])).toThrow(/--port/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/--port/);
    expect(() => parseArgs(['--port'])).toThrow(/needs a value/);
  });

  it('refuses an option it does not know', () => {
    expect(() => parseArgs(['--verbose'])).toThrow(/unknown option --verbose/);
  });

  it('has --list and --help', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('scenarios', () => {
  it('has the ones the docs promise', () => {
    expect(scenarioNames()).toEqual(
      expect.arrayContaining(['default', 'tool-call', 'sub-agent', 'handoff', 'thinking', 'slow', 'no-model']),
    );
    expect(DEFAULT_SCENARIO in SCENARIOS).toBe(true);
  });

  it('lists each one with its description', () => {
    const listing = listScenarios();
    for (const name of scenarioNames()) {
      expect(listing).toContain(name);
      expect(listing).toContain(SCENARIOS[name].description);
    }
  });

  it.each(scenarioNames())('"%s" builds, starts and serves /version and /personas', async (name) => {
    const mock = createScenario(name);
    const port = await mock.start(0);
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
      expect(typeof version.wire_protocol).toBe('number');
      const personas = await (await fetch(`http://127.0.0.1:${port}/personas`)).json();
      expect(personas.map((p: { name: string }) => p.name)).toContain('Kurisu');
    } finally {
      await mock.stop();
    }
  });

  it('"no-model" is the fresh-account state', () => {
    expect(createScenario('no-model').getAssistant().model_name).toBeNull();
    expect(createScenario('default').getAssistant().model_name).not.toBeNull();
  });

  it('"handoff" speaks as a persona the scenario actually has', () => {
    const mock = createScenario('handoff');
    const ids = mock.getPersonas().map((p) => p.id);
    for (const chunk of SCENARIOS.handoff.options.stream!.chunks) {
      if (chunk.personaId !== undefined) expect(ids).toContain(chunk.personaId);
    }
  });
});
