/**
 * A section that cannot work where you are is not listed there.
 *
 * The failure this prevents is specific: an entry in the settings navigation
 * that opens a page with nothing on it, because the thing it configures belongs
 * to a host this build is not running on (#190).
 */
import { describe, expect, it } from 'vitest';
import { fakeBridge } from '@kurisu/platform/testing';
import { visibleSettingsItems } from './SettingsPage';

const labels = (caps: Parameters<typeof visibleSettingsItems>[0]) =>
  visibleSettingsItems(caps).map((item) => item.label);

describe('which settings sections a host shows', () => {
  it('shows everything to a host that can do everything', () => {
    const caps = { ...fakeBridge().capabilities };
    for (const key of Object.keys(caps) as Array<keyof typeof caps>) caps[key] = true;

    expect(labels(caps)).toContain('Host Access');
    expect(labels(caps)).toContain('Extensions');
  });

  it('hides the host-only sections from a host that has no machine to offer', () => {
    // The web bridge answers no to everything, which is the honest default for
    // any host that is not the one this app was written for first.
    const { capabilities } = fakeBridge();

    expect(labels(capabilities)).not.toContain('Host Access');
    expect(labels(capabilities)).not.toContain('Extensions');
  });

  it('still shows everything the server owns', () => {
    const { capabilities } = fakeBridge();

    for (const label of ['Account', 'Assistant', 'Personas', 'Sub-Agents', 'Skills', 'Kurisu Drive']) {
      expect(labels(capabilities)).toContain(label);
    }
  });
});
