/**
 * Standalone entry for the mock backend (#126).
 *
 *   npm run mock:backend -- --port 15597 [--host 0.0.0.0] [--scenario tool-call]
 *   npm run mock:backend -- --list
 *
 * The same `MockBackend` the Playwright fixtures start per test, kept running
 * so a person can point a client at it — the desktop app's Server URL field, or
 * an Android emulator at http://10.0.2.2:<port> — and so the Android
 * instrumented suite has a server that needs no model. `package.json` bundles
 * this file with esbuild before running it, so nothing beyond `npm ci` is
 * needed.
 */

import { MockBackend } from './server';
import { DEFAULT_SCENARIO, SCENARIOS, scenarioNames } from './scenarios';

export interface CliArgs {
  port: number;
  host: string;
  scenario: string;
  list: boolean;
  help: boolean;
}

export const DEFAULT_PORT = 15597;

export const USAGE = `Usage: npm run mock:backend -- [options]

  --port <n>        Port to listen on (default ${DEFAULT_PORT}; 0 picks a free one)
  --host <addr>     Address to bind (default 127.0.0.1; 0.0.0.0 for an emulator or another machine)
  --scenario <name> Starting state (default "${DEFAULT_SCENARIO}"; see --list)
  --list            Print the scenarios and exit
  --help            This text

Any username and password sign in. Set MOCK_DEBUG=1 to log every socket event.`;

/** Parse `argv` (without node and the script). Throws on anything it does not know. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    scenario: DEFAULT_SCENARIO,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--port': {
        const port = Number.parseInt(value(), 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port: not a port: ${argv[i]}`);
        args.port = port;
        break;
      }
      case '--host':
        args.host = value();
        break;
      case '--scenario': {
        const name = value();
        if (!(name in SCENARIOS)) {
          throw new Error(`--scenario: unknown scenario "${name}" (one of: ${scenarioNames().join(', ')})`);
        }
        args.scenario = name;
        break;
      }
      case '--list':
        args.list = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

/** Build a backend in a scenario's starting state. */
export function createScenario(name: string): MockBackend {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario "${name}"`);
  const mock = new MockBackend(scenario.options);
  scenario.apply?.(mock);
  return mock;
}

export function listScenarios(): string {
  const width = Math.max(...scenarioNames().map((n) => n.length));
  return scenarioNames()
    .map((name) => `  ${name.padEnd(width)}  ${SCENARIOS[name].description}`)
    .join('\n');
}

async function main(argv: string[]) {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`mock backend: ${(e as Error).message}`);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  if (args.list) { console.log(listScenarios()); return; }

  const mock = createScenario(args.scenario);
  const port = await mock.start(args.port, args.host);
  const shownHost = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
  console.log(`mock backend listening on http://${shownHost}:${port}  (scenario: ${args.scenario})`);
  if (args.host === '0.0.0.0') {
    console.log(`  from an Android emulator: http://10.0.2.2:${port}`);
  }
  console.log('Ctrl-C to stop.');

  const shutdown = async () => {
    console.log('\nmock backend stopping');
    await mock.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

// Bundled by esbuild into dist-mock/cli.js and run with node; under vitest this
// module is imported for its functions and must not start a server.
if (typeof require !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2));
}
