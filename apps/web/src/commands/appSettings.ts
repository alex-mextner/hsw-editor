/**
 * Every app setting, declared once. Titles and keywords exist in both languages so the palette
 * finds "тема" and "theme" alike; the two-way link to the existing stores is `settingsBridge.ts`.
 */
import { defineSettings, type LocalizedText, type SettingDefinition } from '@hsw-editor/commands';
import { msg } from './messages.ts';

export const DEFAULT_CHORD_TIMEOUT_MS = 1500;

/**
 * Panel visibility depends on the screen: a phone starts with the side panels closed. It is bridged
 * to the layout store like every setting but stays on the device, so a phone never closes the
 * panels of the user's desktop.
 */
export function isDeviceLocalSetting(id: string): boolean {
  return id.startsWith('layout.');
}

const panel = (
  id: 'bank' | 'inspector' | 'history' | 'agent',
  title: LocalizedText,
  description: LocalizedText,
  keywords: readonly string[],
): SettingDefinition => ({
  id: `layout.${id}`,
  type: 'boolean',
  default: true,
  group: 'appearance',
  title,
  description,
  keywords: ['panel', 'show', 'hide', 'панель', 'показать', 'скрыть', ...keywords],
});

export const APP_SETTINGS: readonly SettingDefinition[] = defineSettings([
  {
    id: 'appearance.theme',
    type: 'choice',
    default: 'dark',
    group: 'appearance',
    title: msg('settings.appearance.theme'),
    description: msg('settings.appearance.theme.description'),
    keywords: ['dark', 'light', 'тема', 'тёмная', 'светлая', 'оформление', 'цвета', 'night'],
    options: [
      { value: 'dark', label: msg('settings.appearance.theme.dark') },
      { value: 'light', label: msg('settings.appearance.theme.light') },
    ],
  },
  {
    id: 'appearance.language',
    type: 'choice',
    default: 'ru',
    group: 'appearance',
    title: msg('settings.appearance.language'),
    description: msg('settings.appearance.language.description'),
    keywords: ['language', 'locale', 'русский', 'english', 'язык', 'перевод', 'интерфейс'],
    options: [
      { value: 'ru', label: msg('language.ru') },
      { value: 'en', label: msg('language.en') },
    ],
  },
  {
    id: 'editor.snap',
    type: 'boolean',
    default: true,
    group: 'editor',
    title: msg('settings.editor.snap'),
    description: msg('settings.editor.snap.description'),
    keywords: ['snap', 'grid', 'honeycomb', 'сетка', 'привязка', 'соты', 'шаг'],
  },
  {
    id: 'editor.nudge',
    type: 'number',
    default: 2,
    min: 1,
    max: 10,
    step: 1,
    group: 'editor',
    title: msg('settings.editor.nudge'),
    description: msg('settings.editor.nudge.description'),
    keywords: ['nudge', 'arrow', 'move', 'step', 'шаг', 'сдвиг', 'стрелки'],
  },
  {
    id: 'units.length',
    type: 'choice',
    default: 'mm',
    group: 'units',
    title: msg('settings.units.length'),
    description: msg('settings.units.length.description'),
    keywords: [
      'units',
      'metric',
      'inch',
      'единицы',
      'миллиметры',
      'сантиметры',
      'дюймы',
      'мм',
      'см',
    ],
    options: [
      { value: 'mm', label: msg('settings.units.length.mm') },
      { value: 'cm', label: msg('settings.units.length.cm') },
      { value: 'in', label: msg('settings.units.length.in') },
    ],
  },
  {
    id: 'view.mode',
    type: 'choice',
    default: 'perspective',
    group: 'appearance',
    title: msg('settings.view.mode'),
    description: msg('settings.view.mode.description'),
    keywords: ['camera', 'orthographic', 'front', 'камера', 'вид', 'перспектива', 'фронтальный'],
    options: [
      { value: 'perspective', label: msg('settings.view.mode.perspective') },
      { value: 'front', label: msg('settings.view.mode.front') },
    ],
  },
  panel('bank', msg('settings.layout.bank'), msg('settings.layout.bank.description'), [
    'bank',
    'банк',
    'элементы',
  ]),
  panel(
    'inspector',
    msg('settings.layout.inspector'),
    msg('settings.layout.inspector.description'),
    ['inspector', 'инспектор', 'свойства'],
  ),
  panel('history', msg('settings.layout.history'), msg('settings.layout.history.description'), [
    'history',
    'timeline',
    'история',
    'правки',
  ]),
  panel('agent', msg('settings.layout.agent'), msg('settings.layout.agent.description'), [
    'agent',
    'ai',
    'агент',
    'ии',
  ]),
  {
    id: 'ai.approval',
    type: 'boolean',
    default: true,
    group: 'ai',
    // The AI must not be able to switch off its own approval prompt.
    aiHidden: true,
    title: msg('settings.ai.approval'),
    description: msg('settings.ai.approval.description'),
    keywords: [
      'approve',
      'confirm',
      'auto',
      'ai',
      'ии',
      'подтверждение',
      'разрешение',
      'автоматически',
    ],
  },
  {
    id: 'vision.segmentQuality',
    type: 'choice',
    default: 'fast',
    group: 'advanced',
    title: msg('settings.vision.segmentQuality'),
    description: msg('settings.vision.segmentQuality.description'),
    keywords: [
      'segmentation',
      'segment',
      'sam2',
      'photo',
      'quality',
      'speed',
      'сегментация',
      'фото',
      'качество',
      'скорость',
      'точность',
    ],
    options: [
      { value: 'fast', label: msg('settings.vision.segmentQuality.fast') },
      { value: 'accurate', label: msg('settings.vision.segmentQuality.accurate') },
    ],
  },
  {
    id: 'keyboard.chordTimeout',
    type: 'number',
    default: DEFAULT_CHORD_TIMEOUT_MS,
    min: 300,
    max: 5000,
    step: 100,
    group: 'keyboard',
    title: msg('settings.keyboard.chordTimeout'),
    description: msg('settings.keyboard.chordTimeout.description'),
    keywords: ['chord', 'hotkey', 'shortcut', 'timeout', 'аккорд', 'клавиши', 'таймаут', 'горячие'],
  },
]);
