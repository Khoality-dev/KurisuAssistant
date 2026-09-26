/**
 * The inline character panel's place in the layout (#241): whether it shows
 * and how tall it is, both remembered across a restart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshStore() {
  vi.resetModules();
  return import('./layoutStore');
}

describe('layoutStore: the character panel', () => {
  beforeEach(() => localStorage.clear());

  it('starts hidden, at the default height, on a first run', async () => {
    const { useLayoutStore, CHARACTER_PANEL_DEFAULT_HEIGHT } = await freshStore();
    expect(useLayoutStore.getState().characterVisible).toBe(false);
    expect(useLayoutStore.getState().characterPanelHeight).toBe(CHARACTER_PANEL_DEFAULT_HEIGHT);
  });

  it('remembers that it is showing the moment it is shown or hidden', async () => {
    const { useLayoutStore } = await freshStore();
    useLayoutStore.getState().setCharacterVisible(true);
    expect(localStorage.getItem('kurisu_character_visible')).toBe('true');
    expect((await freshStore()).useLayoutStore.getState().characterVisible).toBe(true);

    (await freshStore()).useLayoutStore.getState().setCharacterVisible(false);
    expect(localStorage.getItem('kurisu_character_visible')).toBe('false');
    expect((await freshStore()).useLayoutStore.getState().characterVisible).toBe(false);
  });

  it('remembers its height once a drag ends, with the column widths', async () => {
    const { useLayoutStore } = await freshStore();
    useLayoutStore.getState().setCharacterPanelHeight(410);
    useLayoutStore.getState().persistWidths();
    expect(localStorage.getItem('kurisu_character_panel_height')).toBe('410');
    expect((await freshStore()).useLayoutStore.getState().characterPanelHeight).toBe(410);
  });

  it('ignores a stored height that is not a number', async () => {
    localStorage.setItem('kurisu_character_panel_height', 'tall');
    const { useLayoutStore, CHARACTER_PANEL_DEFAULT_HEIGHT } = await freshStore();
    expect(useLayoutStore.getState().characterPanelHeight).toBe(CHARACTER_PANEL_DEFAULT_HEIGHT);
  });
});
