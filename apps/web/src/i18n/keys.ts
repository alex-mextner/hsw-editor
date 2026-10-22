import type { en } from './en.ts';

/** Every message id. English defines the keys (it has the simplest plural forms); Russian must cover them all. */
export type MessageKey = keyof typeof en;

/** Base id of a plural group: `<base>.one` + `<base>.other` exist, resolved via Intl.PluralRules. */
export type PluralKey =
  Extract<MessageKey, `${string}.other`> extends `${infer Base}.other` ? Base : never;

/** Plural categories English does not need but other languages (ru) add on top of the shared keys. */
export type ExtraPluralKey = `${PluralKey}.${'zero' | 'two' | 'few' | 'many'}`;

export type Catalogue = Readonly<Record<MessageKey, string>> &
  Readonly<Partial<Record<ExtraPluralKey, string>>>;

/** Russian messages of one feature: exactly the keys of that feature's English catalogue, plus extra plural forms. */
export type FeatureRu<En extends Readonly<Record<string, string>>> = Readonly<
  Record<keyof En, string>
> &
  Readonly<
    Partial<
      Record<
        `${Extract<keyof En, `${string}.other`> extends `${infer Base}.other` ? Base : never}.${'zero' | 'two' | 'few' | 'many'}`,
        string
      >
    >
  >;
