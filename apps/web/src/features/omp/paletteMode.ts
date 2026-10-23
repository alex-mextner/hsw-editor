/**
 * "Palette mode": a question typed into the command palette (`?...`) goes to the same omp session as the
 * panel, wrapped in a short instruction block. The block steers the model (brief answer, act through
 * `app_command`) and marks the message, so the panel transcript can show it as a palette question instead
 * of a wall of instructions.
 */
import type { Locale } from '@hsw-editor/commands';

const OPEN = '<hsw-palette-mode>';
const CLOSE = '</hsw-palette-mode>';

const LANGUAGE: Readonly<Record<Locale, string>> = { en: 'English', ru: 'Russian' };

/** The question wrapped with the palette-mode instruction block. */
export function buildPalettePrompt(text: string, locale: Locale): string {
  return [
    OPEN,
    'The user asked this from the editor\u2019s command palette, not from the agent panel. Rules for this message only:',
    `- Answer in the language of the question (the interface language is ${LANGUAGE[locale]}), in at most three short sentences of plain text: no Markdown, the palette shows the text as is.`,
    '- To do something in the editor use the app_command tool: op=search or op=list to find the command, then op=run. Never invent command ids or arguments.',
    '- Before you run anything, say in one sentence what you will do.',
    '- Do not edit the wall unless the question asks for it.',
    CLOSE,
    text,
  ].join('\n');
}

/** The user's own text when `message` is a palette-mode prompt, else null. */
export function unwrapPalettePrompt(message: string): string | null {
  if (!message.startsWith(`${OPEN}\n`)) return null;
  const end = message.indexOf(`${CLOSE}\n`);
  return end === -1 ? null : message.slice(end + CLOSE.length + 1);
}
