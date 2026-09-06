# CLAUDE.md

The TypeScript clients, as one npm workspace (see the root `CLAUDE.md`; the backend is in `../backend/`). `android/` sits in this directory but is **not** a member — it is Gradle and Kotlin and shares nothing here.

```
clients/
├── packages/          shared, and answerable to more than one app
│   ├── models/        the wire protocol as types and runtime data
│   └── platform/      what a host lends the renderer, behind one interface
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

`models` → `platform` → an app. Nothing points back up.

- **`models` depends on nothing.** It is the backend's shape and it is imported by every app and every future one, so a dependency here is a dependency everywhere: it needs a conversation, not an `npm install`.
- **`platform` is the only place that may name `window.electron`**, and only in `src/electron.ts`. The renderer reached for it about 130 times, in forty spellings of the same guard, while a document said where the seam was — which is why this is a test (`boundaries.test.ts`) and not a paragraph.
- **Ask what the host can do, never which host it is.** `capabilities.localFiles`, not `platform === 'web'`. The first reads as the reason the code is doing what it does and stays true when a third host appears; the second has to be revisited every time one does.

A `null` member on the bridge is not a failure — it is the host saying it does not offer that, and the matching capability flag is what a caller should ask before it renders a control for it.

## What has not moved yet

Phase 1 of #128 only. The API client, the stores, the hooks and the components are still inside `apps/desktop`, and its components still use `window.electron` directly — the layers underneath them go through `resolveBridge()`. The boundary test covers `packages/`, so it will not stop a component doing that until those components move too.
