/** Positive integer env setting; a malformed value fails loudly instead of becoming NaN (which would disable a cap). */
export function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}
