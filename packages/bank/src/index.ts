/** HSW element bank index. Content (GLB, thumbnails) is produced by the ingestion pipeline. */
export interface BankElement {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  /** Path of the GLB relative to the bank root; absent for parametric-only elements. */
  readonly glb?: string;
  readonly thumbnail?: string;
  /** Licence under which the element may be redistributed; unknown = fetch at setup only. */
  readonly license: string;
}

export interface BankIndex {
  readonly version: 1;
  readonly elements: readonly BankElement[];
}

export const EMPTY_BANK_INDEX: BankIndex = { version: 1, elements: [] };
