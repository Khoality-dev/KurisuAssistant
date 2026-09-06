# CLAUDE.md

The TypeScript clients, as one npm workspace (see the root `CLAUDE.md`; the backend is in `../backend/`). `android/` sits in this directory but is **not** a member — it is Gradle and Kotlin and shares nothing here.

```
clients/
├── packages/          shared, and answerable to more than one app
│   ├── models/        the wire protocol as types and runtime data
│   ├── platform/      what a host lends the renderer, behind one interface
│   ├── api/           the server as this client calls it: REST, socket, tokens
│   ├── state/         what the client knows between renders (zustand)
│   └── hooks/         React bindings over state and api
└── apps/
    └── desktop/       Electron + React (clients/apps/desktop/CLAUDE.md)
```

This exists because the clients are growing a second and third surface (#128) and everything they would share was locked inside the Electron app. `apps/web` and `apps/mobile` land here; the packages are what they will be built from.

## Commands

Run these from **this directory**, not from an app:

- `npm ci` — the only place dependencies install. The lockfile is here and every member's `node_modules` hoists here, so an app directory has no lockfile of its own and `npm ci` inside one will not work.
- `npm test` — every member's suite, including `packages/platform/src/boundaries.test.ts`.
- `npm run typecheck` — every member.

An app's own commands (`electron:dev`, `test:e2e`, the packaging build) still run from that app's directory.

## The layering, and why a test enforces it

`models` → `platform` → `api` → `state` → `hooks` → an app. Nothing points back up,
and `boundaries.test.ts` fails when something does.

- **`models` depends on nothing.** It is the backend's shape and it is imported by every app and every future one, so a dependency here is a dependency everywhere: it needs a conversation, not an `npm install`.
- **`platform` is the only place that may name `window.electron`**, and only in `src/electron.ts`. The renderer reached for it about 130 times, in forty spellings of the same guard, while a document said where the seam was — which is why this is a test (`boundaries.test.ts`) and not a paragraph.
- **Ask what the host can do, never which host it is.** `capabilities.localFiles`, not `platform === 'web'`. The first reads as the reason the code is doing what it does and stays true when a third host appears; the second has to be revisited every time one does.
- **Nothing shared renders anything.** No package may import `@mui/*`, `@emotion/*`
  or `react-dom`. The screens belong to the app, and one day to a second app with a
  different widget set; a shared package that reaches for one decides that for both.
  `api` may not import React at all — it is the layer a non-React client would reuse
  as-is.

A `null` member on the bridge is not a failure — it is the host saying it does not offer that, and the matching capability flag is what a caller should ask before it renders a control for it.

## What has not moved yet

Phases 1 and 2 of #128. The **components** are still inside `apps/desktop`, and they
still use `window.electron` directly — everything underneath them goes through
`resolveBridge()`. The boundary test covers `packages/`, so it will not stop a
component doing that until the components move too.

The app-tool schema table is also still in `apps/desktop/electron/appTools.ts`, while
the dispatch that implements all 26 of those tools is in `packages/state` and needs no
Electron at all. `apps/desktop/tests/appTools.test.ts` reads both files across that
seam to keep them in step.
