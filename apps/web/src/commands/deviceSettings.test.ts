import { describe, expect, test } from 'bun:test';
import { SettingsStore } from '@hsw-editor/commands';
import { APP_SETTINGS } from './appSettings.ts';
import { DeviceSettings } from './deviceSettings.ts';

function setup() {
  const store = new SettingsStore(APP_SETTINGS);
  const device = new DeviceSettings();
  device.attach(store);
  return { store, device };
}

describe('synced overrides', () => {
  test('leave out panels and environment-picked values', () => {
    const { store, device } = setup();
    device.keep('appearance.language', store, 'en');
    store.set('layout.bank', false);
    store.set('appearance.theme', 'light');
    expect(device.synced(store.overrides())).toEqual({ 'appearance.theme': 'light' });
  });

  test('a later change of an environment-picked value makes it a real setting', () => {
    const { store, device } = setup();
    device.keep('appearance.language', store, 'en');
    store.set('appearance.language', 'ru');
    store.set('appearance.language', 'en');
    expect(device.synced(store.overrides())).toEqual({ 'appearance.language': 'en' });
  });
});

describe('merge of a received document', () => {
  test("keeps this device's panels and ignores the sender's", () => {
    const { device } = setup();
    expect(
      device.merge(
        { 'appearance.theme': 'light', 'layout.bank': true },
        { 'layout.bank': false, 'editor.snap': false },
      ),
    ).toEqual({ 'appearance.theme': 'light', 'layout.bank': false });
  });

  test('keeps an environment-picked value the server does not state', () => {
    const { store, device } = setup();
    device.keep('appearance.language', store, 'en');
    expect(device.merge({ 'units.length': 'in' }, store.overrides())).toEqual({
      'units.length': 'in',
      'appearance.language': 'en',
    });
  });

  test('a value the server states replaces the environment-picked one for good', () => {
    const { store, device } = setup();
    device.keep('appearance.language', store, 'en');
    expect(device.merge({ 'appearance.language': 'ru' }, store.overrides())).toEqual({
      'appearance.language': 'ru',
    });
    expect(device.isLocal('appearance.language')).toBe(false);
  });

  test('a removed or malformed document leaves only the local values', () => {
    const { device } = setup();
    expect(device.merge(undefined, { 'layout.history': false })).toEqual({
      'layout.history': false,
    });
    expect(device.merge([1, 2], {})).toEqual({});
  });
});
