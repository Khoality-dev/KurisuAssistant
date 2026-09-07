/**
 * The layering, enforced instead of agreed.
 *
 * #128 splits the clients into packages so a second app can be built from them.
 * That only holds if the shared packages stay free of the things that make code
 * desktop-only, and "we will remember" is not a mechanism — the renderer
 * accumulated about 130 direct `window.electron` references while a document
 * said where the seam was. This test is the mechanism.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const PACKAGES = dirname(dirname(dirname(new URL(import.meta.url).pathname)));

/** The one file allowed to name the Electron bridge: the Electron host itself. */
const HOST_IMPLEMENTATION = join(PACKAGES, 'platform', 'src', 'electron.ts');

/**
 * A file with its comments removed.
 *
 * The rule is about what the code *does*, not what it says. This file, the web
 * bridge and the fake all have to name the thing they exist to talk about, and a
 * grep that cannot tell prose from a call would either fail here forever or be
 * silenced with an exclusion list that grows.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function packageSources(): string[] {
  let out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) out = out.concat(sourceFiles(src));
    } catch {
      // a package without a src/ is not this test's business
    }
  }
  return out;
}

const manifest = (pkg: string) =>
  JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8'));

describe('the shared packages stay shareable', () => {
  it('reaches for the Electron bridge in exactly one file', () => {
    const offenders = packageSources()
      .filter((file) => file !== HOST_IMPLEMENTATION)
      .filter((file) => /window\.electron|\(window as[^)]*\)\.electron/.test(codeOf(file)))
      .map((file) => relative(PACKAGES, file));

    expect(offenders).toEqual([]);
  });

  it('never imports the electron module', () => {
    const offenders = packageSources()
      .filter((file) => /from ['"]electron['"]|require\(['"]electron['"]\)/.test(codeOf(file)))
      .map((file) => relative(PACKAGES, file));

    expect(offenders).toEqual([]);
  });

  it('keeps the protocol package free of runtime dependencies', () => {
    // @kurisu/models is the backend's shape and nothing else. A dependency here
    // is a dependency of every app and every future one, so it needs a reason
    // and a conversation, not an npm install.
    expect(manifest('models').dependencies ?? {}).toEqual({});
  });

  it('does not let the protocol package import a platform', () => {
    const offenders = sourceFiles(join(PACKAGES, 'models', 'src'))
      .filter((file) => /@kurisu\/platform/.test(codeOf(file)))
      .map((file) => relative(PACKAGES, file));

    expect(offenders).toEqual([]);
  });
});

/** Every module a package's sources import by name, not by relative path. */
function externalImportsOf(pkg: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(join(PACKAGES, pkg, 'src'))) {
    for (const m of codeOf(file).matchAll(/from ['"]([^.'"][^'"]*)['"]/g)) {
      const dep = m[1];
      found.set(dep, [...(found.get(dep) ?? []), relative(PACKAGES, file)]);
    }
  }
  return found;
}

describe('the layers point one way', () => {
  // api -> state -> hooks, and nothing points back up. A layer that reaches
  // upward is not a layer, and the app that imports it inherits everything it
  // dragged along.
  const forbidden: Array<[string, string[]]> = [
    ['models', ['@kurisu/api', '@kurisu/state', '@kurisu/hooks', '@kurisu/ui', '@kurisu/platform', 'react']],
    ['platform', ['@kurisu/api', '@kurisu/state', '@kurisu/hooks', '@kurisu/ui', 'react']],
    ['api', ['@kurisu/state', '@kurisu/hooks', '@kurisu/ui', 'react']],
    ['state', ['@kurisu/hooks', '@kurisu/ui']],
    ['hooks', ['@kurisu/ui']],
  ];

  it.each(forbidden)('%s does not import what sits above it', (pkg, banned) => {
    const imports = externalImportsOf(pkg);
    const offenders = banned
      .filter((dep) => imports.has(dep))
      .map((dep) => `${pkg} imports ${dep} in ${imports.get(dep)!.join(', ')}`);

    expect(offenders).toEqual([]);
  });

  // `ui` is deliberately absent: it is the package that renders, and the only
  // one allowed a widget library. Every other package is billed by both apps.
  it.each(['models', 'platform', 'api', 'state', 'hooks'])(
    '%s renders nothing, so it imports no widget library',
    (pkg) => {
      // The screens are the app's, and one day a second app's with a different
      // one. A shared package that reaches for MUI or a DOM decides that for
      // both of them.
      const offenders = [...externalImportsOf(pkg)]
        .filter(([dep]) => /^@mui\/|^react-dom|^@emotion\//.test(dep))
        .map(([dep, files]) => `${pkg} imports ${dep} in ${files.join(', ')}`);

      expect(offenders).toEqual([]);
    },
  );
});
