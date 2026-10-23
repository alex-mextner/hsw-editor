/** Release version, read from the root package.json so `bun run release` is the only place it changes. */
import pkg from '../../../package.json';

export const SERVER_VERSION: string = pkg.version;
