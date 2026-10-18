/**
 * Which part of the window Ctrl+F belongs to (#312). The chat searches its
 * messages and the file tree filters its files, and both listen on the window:
 * one key used to open both. A part marks itself with `data-find-scope`, and
 * the key goes to the part that has focus — or, with focus nowhere in
 * particular (a click on text that takes none), the part last clicked.
 */
let lastPointer: Element | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => { lastPointer = e.target as Element | null; }, true);
}

export function findScope(): string | null {
  const active = document.activeElement;
  const where = active && active !== document.body ? active : lastPointer;
  return where?.closest?.('[data-find-scope]')?.getAttribute('data-find-scope') ?? null;
}
