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
const APPS = join(dirname(PACKAGES), 'apps');

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

/** Every workspace member as `{ name, dir }`: the packages, then the apps. */
function members(): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  for (const [root, prefix] of [[PACKAGES, 'packages'], [APPS, 'apps']] as const) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!statSync(join(dir, 'package.json')).isFile()) continue;
      } catch {
        continue; // not a member
      }
      out.push({ name: `${prefix}/${entry}`, dir });
    }
  }
  return out;
}

/** A member's source directories: `src`, and for an app its main process too. */
function memberSourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const sub of ['src', 'electron']) {
    try {
      if (statSync(join(dir, sub)).isDirectory()) out = out.concat(sourceFiles(join(dir, sub)));
    } catch {
      // no such directory
    }
  }
  return out;
}

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

/**
 * Every module a set of files imports by name, not by relative path — static
 * `from`, dynamic `import()` and `require()` alike, because a lazy
 * `import('three')` is exactly how an engine would sneak past a check that
 * only read `from`.
 */
const IMPORT_FORMS = [
  /from ['"]([^.'"][^'"]*)['"]/g,
  /\bimport\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g,
  /\brequire\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g,
];

function externalImportsIn(files: string[], root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const code = codeOf(file);
    for (const form of IMPORT_FORMS) {
      for (const m of code.matchAll(form)) {
        const dep = m[1];
        const where = relative(root, file);
        const seen = found.get(dep) ?? [];
        if (!seen.includes(where)) found.set(dep, [...seen, where]);
      }
    }
  }
  return found;
}

/** Every module a package's sources import by name, not by relative path. */
function externalImportsOf(pkg: string): Map<string, string[]> {
  return externalImportsIn(sourceFiles(join(PACKAGES, pkg, 'src')), PACKAGES);
}

describe('the layers point one way', () => {
  // api -> state -> hooks, and nothing points back up. A layer that reaches
  // upward is not a layer, and the app that imports it inherits everything it
  // dragged along.
  // `@kurisu/vrm` is banned below `ui` as well: it carries three.js, and only
  // the package that renders (and an app) may decide to load an engine. A
  // banned name covers its subpaths — `@kurisu/vrm/probe` is engine-free, but
  // a layer that does not render has no display to ask about.
  const forbidden: Array<[string, string[]]> = [
    ['models', ['@kurisu/api', '@kurisu/state', '@kurisu/hooks', '@kurisu/ui', '@kurisu/platform', '@kurisu/vrm', 'react']],
    ['platform', ['@kurisu/api', '@kurisu/state', '@kurisu/hooks', '@kurisu/ui', '@kurisu/vrm', 'react']],
    ['api', ['@kurisu/state', '@kurisu/hooks', '@kurisu/ui', '@kurisu/vrm', 'react']],
    ['state', ['@kurisu/hooks', '@kurisu/ui', '@kurisu/vrm']],
    ['hooks', ['@kurisu/ui', '@kurisu/vrm']],
    // The VRM driver sits beside `models`: it is imported by `ui` and by the
    // page an Android WebView hosts, so it may know the protocol's shapes and
    // nothing about a platform, a server, a store or a screen (#239).
    ['vrm', ['@kurisu/platform', '@kurisu/api', '@kurisu/state', '@kurisu/hooks', '@kurisu/ui', 'react']],
  ];

  it.each(forbidden)('%s does not import what sits above it', (pkg, banned) => {
    const imports = externalImportsOf(pkg);
    const offenders: string[] = [];
    for (const dep of banned) {
      for (const [name, files] of imports) {
        if (name === dep || name.startsWith(`${dep}/`)) offenders.push(`${pkg} imports ${name} in ${files.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // `ui` is deliberately absent: it is the package that renders, and the only
  // one allowed a widget library. Every other package is billed by both apps.
  it.each(['models', 'platform', 'api', 'state', 'hooks', 'vrm'])(
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

describe('three.js lives in one package', () => {
  // A WebGL engine is the heaviest thing a client carries and the Android page
  // bundle is built from `vrm` alone; a second package that imported three
  // would pull it into the main window's chunk and the browser build for every
  // 2D user (#239).
  it('is imported only by vrm — statically, dynamically, or by require, in the packages and the apps', () => {
    const offenders: string[] = [];
    for (const { name, dir } of members()) {
      if (name === 'packages/vrm') continue;
      for (const [dep, files] of externalImportsIn(memberSourceFiles(dir), dirname(PACKAGES))) {
        if (/^three(\/|$)|^@pixiv\//.test(dep)) offenders.push(`${name} imports ${dep} in ${files.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches a dynamic import and a require, not only a static one', () => {
    // The scan itself, pinned: a check that only read `from` would let a lazy
    // `import('three')` into the main chunk unnoticed.
    const imports = externalImportsIn([join(PACKAGES, 'platform', 'src', 'boundaries.fixture.txt')], PACKAGES);
    expect([...imports.keys()].sort()).toEqual(['@pixiv/three-vrm', 'three', 'three/examples/jsm/loaders/GLTFLoader.js']);
  });

  it('is reached only through its own package: nothing below ui may import @kurisu/vrm at all', () => {
    const offenders: string[] = [];
    for (const pkg of ['models', 'platform', 'api', 'state', 'hooks']) {
      for (const [dep, files] of externalImportsOf(pkg)) {
        if (/^@kurisu\/vrm(\/|$)/.test(dep)) offenders.push(`${pkg} imports ${dep} in ${files.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches the engine from ui lazily: no static import of @kurisu/vrm in the screens', () => {
    // `CharacterSurface` imports the engine with `import('@kurisu/vrm')` once a
    // VRM persona is on screen and the display passed the probe (#240). Any
    // static specifier — `import … from`, `export … from`, `import type`, or a
    // bare side-effect `import '…'` — of the package or a subpath of it other
    // than the engine-free `/probe` would put three.js (or its entry's side
    // effects) in the main window's chunk. Tests may import `/testing`.
    const banned = /^@kurisu\/vrm(\/(?!probe$).*)?$/;
    const statics = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(join(PACKAGES, 'ui', 'src'))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(statics)) {
        if (banned.test(match[1])) offenders.push(`${relative(PACKAGES, file)}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the lazy-import scan catches every static form, and lets the probe and a dynamic import through', () => {
    const banned = /^@kurisu\/vrm(\/(?!probe$).*)?$/;
    const statics = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
    // Built from a constant, so the layer scans above (which read this file too)
    // do not take the sample lines for real imports.
    const VRM = '@kurisu/' + 'vrm';
    const sample = [
      `import { createVrmDriver } from '${VRM}';`,
      `import type { VrmDriver } from '${VRM}';`,
      `export * from '${VRM}/testing';`,
      `import '${VRM}';`,
      `import { supportsWebGL } from '${VRM}/probe';`,
      `const m = await import('${VRM}');`,
      `type M = typeof import('${VRM}');`,
    ].join('\n');
    const hits = [...sample.matchAll(statics)].map((m) => m[1]).filter((spec) => banned.test(spec));
    expect(hits).toEqual(['@kurisu/vrm', '@kurisu/vrm', '@kurisu/vrm/testing', '@kurisu/vrm']);
  });

  it('keeps the probe engine-free', () => {
    // `@kurisu/vrm/probe` is what a surface asks before importing the engine;
    // the question must not carry the answer's weight.
    const probe = join(PACKAGES, 'vrm', 'src', 'probe.ts');
    expect([...externalImportsIn([probe], PACKAGES).keys()]).toEqual([]);
    expect(manifest('vrm').exports['./probe']).toBe('./src/probe.ts');
  });

  it('is pinned to one exact version in vrm', () => {
    const deps = manifest('vrm').dependencies ?? {};
    for (const name of ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation']) {
      expect(deps[name], `${name} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('every package runs in CI', () => {
  // The root scripts fan out with `--workspaces --if-present`: a member
  // without a `typecheck` or `test` script is skipped silently and green,
  // which is how the packages' suites went unrun for months (#225).
  it('declares both a typecheck and a test script, in every package and every app', () => {
    const missing: string[] = [];
    for (const { name, dir } of members()) {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
      for (const script of ['typecheck', 'test']) {
        if (!scripts[script]) missing.push(`${name} has no ${script} script`);
      }
    }
    expect(missing).toEqual([]);
  });
});
