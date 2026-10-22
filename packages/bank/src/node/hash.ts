/** Hashing shared by the bank pipeline: file contents, and the index `contentHash`. */

export function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

/**
 * The hash `BankIndex.contentHash` is defined over: the serialised index without the field itself. It is
 * a tamper/truncation check over the exact bytes the pipeline wrote, so it depends on the key order of
 * `index.json` (not canonical): reformatting or re-ordering the file is reported as an edit.
 */
export function indexContentHash(raw: object): string {
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'contentHash'));
  return sha256Hex(JSON.stringify(rest));
}
