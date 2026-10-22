export type MessageParams = Readonly<Record<string, string | number>>;

/** Replaces `{name}` placeholders; an unknown placeholder is left visible so it is noticed. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Names of the `{placeholders}` a template uses, sorted (for catalogue parity checks). */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}
