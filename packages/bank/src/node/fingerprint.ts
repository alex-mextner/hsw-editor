/** Content hashes of the code that shapes pipeline output, used in cache keys. */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BankPaths } from './paths.ts';

const FINGERPRINT_FILE = /\.(ts|py|scad|json|toml)$/;
const FINGERPRINT_SKIP_DIR = new Set(['node_modules', '__pycache__', '.venv']);

/** Hash of the given files/directories, recursively (test files excluded). */
export async function codeFingerprint(paths: BankPaths, roots: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const walk = async (rel: string): Promise<void> => {
    const target = join(paths.repoRoot, rel);
    const info = await stat(target).catch(() => null);
    if (info === null) return;
    if (!info.isDirectory()) {
      hasher.update(`${rel}\0`);
      hasher.update(await Bun.file(target).arrayBuffer());
      return;
    }
    for (const entry of (await readdir(target, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (!FINGERPRINT_SKIP_DIR.has(entry.name)) await walk(`${rel}/${entry.name}`);
      } else if (FINGERPRINT_FILE.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        await walk(`${rel}/${entry.name}`);
      }
    }
  };
  for (const root of roots) await walk(root);
  return hasher.digest('hex');
}

const buildCodes = new Map<string, Promise<string>>();

/** Hash of what shapes a built element's artefacts (mesh tool and compressor); computed once per process. */
export function buildCodeHash(paths: BankPaths): Promise<string> {
  let hash = buildCodes.get(paths.repoRoot);
  if (!hash) {
    hash = codeFingerprint(paths, ['scripts/bank/py', 'packages/bank/src/node/compress.ts']);
    buildCodes.set(paths.repoRoot, hash);
  }
  return hash;
}
