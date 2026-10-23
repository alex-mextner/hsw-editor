/**
 * Settings registry and store. Every setting is declared once (type, default, titles, synonyms);
 * the palette lists them for search and inline toggling, the AI can read and change them through
 * the generated commands, and the user's choices persist as a small JSON object.
 */
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import { defineCommand, isDottedId, type Command } from './registry.ts';
import type { Context } from './when.ts';
import type { Label, LocalizedText } from './text.ts';

export type SettingGroup = 'appearance' | 'editor' | 'units' | 'keyboard' | 'ai' | 'advanced';

export const SETTING_GROUPS: Readonly<Record<SettingGroup, LocalizedText>> = {
  appearance: { en: 'Appearance', ru: 'Внешний вид' },
  editor: { en: 'Editor', ru: 'Редактор' },
  units: { en: 'Units', ru: 'Единицы' },
  keyboard: { en: 'Keyboard', ru: 'Клавиатура' },
  ai: { en: 'AI', ru: 'ИИ' },
  advanced: { en: 'Advanced', ru: 'Дополнительно' },
};

export type SettingValue = boolean | number | string;

interface SettingBase {
  /** Dotted id, `appearance.theme`; persisted as the key of the settings object. */
  readonly id: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly keywords?: readonly string[];
  readonly group: SettingGroup;
  /** Not changeable by the AI. Default changeable. */
  readonly aiHidden?: boolean;
}

export interface BooleanSetting extends SettingBase {
  readonly type: 'boolean';
  readonly default: boolean;
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: Label;
}

export interface ChoiceSetting extends SettingBase {
  readonly type: 'choice';
  readonly default: string;
  readonly options: readonly ChoiceOption[];
}

export interface NumberSetting extends SettingBase {
  readonly type: 'number';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export type SettingDefinition = BooleanSetting | ChoiceSetting | NumberSetting;

export function defineSettings(
  definitions: readonly SettingDefinition[],
): readonly SettingDefinition[] {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new Error(`duplicate setting '${definition.id}'`);
    seen.add(definition.id);
    if (!isDottedId(definition.id)) {
      throw new Error(`invalid setting id '${definition.id}'`);
    }
    if (
      definition.type === 'number' &&
      !(definition.step > 0 && definition.min <= definition.max)
    ) {
      throw new Error(`setting ${definition.id}: needs step > 0 and min <= max`);
    }
    if (
      definition.type === 'choice' &&
      !definition.options.some((o) => o.value === definition.default)
    ) {
      throw new Error(`setting ${definition.id}: default is not one of the options`);
    }
  }
  return definitions;
}

/** The accepted form of `raw` for `definition`, or undefined when it is not valid. */
export function coerceSetting(
  definition: SettingDefinition,
  raw: unknown,
): SettingValue | undefined {
  switch (definition.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'choice':
      return typeof raw === 'string' && definition.options.some((o) => o.value === raw)
        ? raw
        : undefined;
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
      const clamped = Math.min(definition.max, Math.max(definition.min, raw));
      const steps = Math.round((clamped - definition.min) / definition.step);
      // Round to the step grid without accumulating float noise; the last grid point may overshoot
      // max when max is not on the grid, so clamp again.
      const snapped = Number((definition.min + steps * definition.step).toFixed(6));
      return snapped > definition.max ? definition.max : snapped;
    }
  }
}

export class SettingsStore {
  private readonly byId = new Map<string, SettingDefinition>();
  private values = new Map<string, SettingValue>();
  private readonly listeners = new Set<(id: string) => void>();

  constructor(
    readonly definitions: readonly SettingDefinition[],
    persisted?: unknown,
  ) {
    for (const definition of definitions) this.byId.set(definition.id, definition);
    if (persisted !== undefined) this.load(persisted);
  }

  definition(id: string): SettingDefinition | undefined {
    return this.byId.get(id);
  }

  /**
   * An id no definition declares is a programming error, so `get`, `set`, `toggle`, `reset` and
   * `isDefault` all throw on it; only a value that is not acceptable is a runtime outcome
   * (`set` and `toggle` return false).
   */
  private require(id: string): SettingDefinition {
    const definition = this.byId.get(id);
    if (definition === undefined) throw new Error(`unknown setting '${id}'`);
    return definition;
  }

  get(id: string): SettingValue {
    return this.values.get(id) ?? this.require(id).default;
  }

  /** Validates and stores `raw`; returns false (and changes nothing) when it is not acceptable. */
  set(id: string, raw: unknown): boolean {
    const definition = this.require(id);
    const value = coerceSetting(definition, raw);
    if (value === undefined) return false;
    if (value === this.get(id)) return true;
    if (value === definition.default) this.values.delete(id);
    else this.values.set(id, value);
    this.emit(id);
    return true;
  }

  reset(id: string): void {
    this.require(id);
    if (this.values.delete(id)) this.emit(id);
  }

  isDefault(id: string): boolean {
    this.require(id);
    return !this.values.has(id);
  }

  /** Flips a boolean, or steps a choice to its next option (wrapping). False for a number. */
  toggle(id: string): boolean {
    const definition = this.require(id);
    const current = this.get(id);
    if (definition.type === 'boolean') return this.set(id, !current);
    if (definition.type === 'choice') {
      const index = definition.options.findIndex((o) => o.value === current);
      const next = definition.options[(index + 1) % definition.options.length];
      return next !== undefined && this.set(id, next.value);
    }
    return false;
  }

  /** Non-default values only, the persisted form. */
  overrides(): Readonly<Record<string, SettingValue>> {
    return Object.fromEntries(this.values);
  }

  /** Replaces all values from a persisted object; unknown ids and invalid values are dropped. */
  load(persisted: unknown): void {
    const next = new Map<string, SettingValue>();
    if (typeof persisted === 'object' && persisted !== null && !Array.isArray(persisted)) {
      for (const [id, raw] of Object.entries(persisted)) {
        const definition = this.byId.get(id);
        if (definition === undefined) continue;
        const value = coerceSetting(definition, raw);
        if (value !== undefined && value !== definition.default) next.set(id, value);
      }
    }
    const changed = new Set([...this.values.keys(), ...next.keys()]);
    this.values = next;
    for (const id of changed) this.emit(id);
  }

  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Settings as context keys (`setting.appearance.grid`) for when-clauses. */
  context(): Context {
    const context: Record<string, SettingValue> = {};
    for (const definition of this.definitions)
      context[`setting.${definition.id}`] = this.get(definition.id);
    return context;
  }

  private emit(id: string): void {
    for (const listener of [...this.listeners]) listener(id);
  }
}

const SET_GROUP_KEYWORDS: readonly string[] = [
  'setting',
  'settings',
  'настройка',
  'настройки',
  'параметр',
];

/**
 * One command per changeable setting: `settings.toggle.<id>` for booleans and choices (steps to the
 * next option), `settings.set.<id>` with `{ value }` for any type. They give settings key bindings
 * and make them reachable for the AI through the same registry as every other action.
 */
export function settingCommands(store: SettingsStore): readonly Command[] {
  const commands: Command[] = [];
  for (const definition of store.definitions) {
    const shared = {
      title: definition.title,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      keywords: [...SET_GROUP_KEYWORDS, ...(definition.keywords ?? [])],
      group: 'settings' as const,
      mutates: true,
      hidden: true,
      // Hidden from the palette (its settings provider lists them), but the AI reaches them here.
      aiHidden: definition.aiHidden === true,
    };
    if (definition.type !== 'number') {
      commands.push(
        defineCommand({
          ...shared,
          id: `settings.toggle.${definition.id}`,
          handler: () => {
            store.toggle(definition.id);
            return store.get(definition.id);
          },
        }),
      );
    }
    const valueSchema = valueSchemaOf(definition);
    commands.push(
      defineCommand({
        ...shared,
        id: `settings.set.${definition.id}`,
        args: z.object({ value: valueSchema }),
        handler: ({ value }) => {
          if (!store.set(definition.id, value))
            throw new Error(`invalid value for ${definition.id}`);
          return store.get(definition.id);
        },
      }),
    );
  }
  return commands;
}

/** An enum, so the AI's JSON Schema lists the allowed values. */
function choiceSchema(values: readonly string[]): z.ZodType<string> {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('a choice setting needs at least one option');
  return z.enum([first, ...rest]);
}

function valueSchemaOf(definition: SettingDefinition): z.ZodType<SettingValue> {
  switch (definition.type) {
    case 'boolean':
      return z.boolean();
    case 'choice':
      return choiceSchema(definition.options.map((option) => option.value));
    case 'number':
      return z.number().min(definition.min).max(definition.max);
  }
}

/** JSON snapshot of the store for AI inspection: id, title, current value, default. */
export function describeSettings(store: SettingsStore): JsonValue {
  return store.definitions.map((definition) => ({
    id: definition.id,
    title: { en: definition.title.en, ru: definition.title.ru },
    type: definition.type,
    value: store.get(definition.id),
    default: definition.default,
  }));
}
