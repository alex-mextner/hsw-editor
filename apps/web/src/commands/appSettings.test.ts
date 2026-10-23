import { describe, expect, test } from 'bun:test';
import { SettingsStore } from '@hsw-editor/commands';
import { APP_SETTINGS, isDeviceLocalSetting } from './appSettings.ts';

describe('app settings', () => {
  const store = new SettingsStore(APP_SETTINGS);

  test('cover theme, language, snap, nudge, units, view, panels, AI approval, photo segmentation and chord timeout', () => {
    const ids = APP_SETTINGS.map((setting) => setting.id);
    expect(ids).toEqual([
      'appearance.theme',
      'appearance.language',
      'editor.snap',
      'editor.nudge',
      'units.length',
      'view.mode',
      'layout.bank',
      'layout.inspector',
      'layout.history',
      'layout.agent',
      'ai.approval',
      'vision.segmentQuality',
      'keyboard.chordTimeout',
    ]);
  });

  test('every setting is titled and described in both languages', () => {
    for (const setting of APP_SETTINGS) {
      expect(setting.title.en.length).toBeGreaterThan(0);
      expect(setting.title.ru.length).toBeGreaterThan(0);
      expect(setting.description?.en.length).toBeGreaterThan(0);
      expect(setting.description?.ru.length).toBeGreaterThan(0);
    }
  });

  test('the AI cannot switch off its own approval prompt', () => {
    expect(store.definition('ai.approval')).toMatchObject({ aiHidden: true });
  });

  test('keywords carry the Russian words people search for', () => {
    const keywordsOf = (id: string) => store.definition(id)?.keywords ?? [];
    expect(keywordsOf('appearance.theme')).toContain('тема');
    expect(keywordsOf('appearance.language')).toContain('язык');
    expect(keywordsOf('editor.snap')).toContain('сетка');
  });

  test('the photo segmentation quality is a fast / accurate choice that defaults to fast and syncs across devices', () => {
    const definition = store.definition('vision.segmentQuality');
    expect(definition).toMatchObject({ type: 'choice', default: 'fast', group: 'advanced' });
    expect(definition?.type === 'choice' && definition.options.map((option) => option.value)).toEqual([
      'fast',
      'accurate',
    ]);
    expect(definition?.keywords).toContain('сегментация');
    expect(isDeviceLocalSetting('vision.segmentQuality')).toBe(false);
  });
});

test('only panel visibility is device-local', () => {
  expect(isDeviceLocalSetting('layout.bank')).toBe(true);
  expect(isDeviceLocalSetting('appearance.theme')).toBe(false);
});
