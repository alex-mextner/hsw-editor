/**
 * Puts the showcase wall (`src/demo/showcase.ts`: generated tools hanging in real holders) on a running daemon, for visual proofs and
 * manual checks of how tools look on the wall:
 *
 *   bun apps/web/scripts/showcase-wall.ts [--api http://127.0.0.1:8794] [--id showcase] [--replace] [--template]
 *
 * Holders and tool poses come from the bank the daemon serves and the tool models of its asset store, so the wall shows exactly what
 * a drag-and-drop of the same tools would produce.
 */
import type { HolderSpec } from '@hsw-editor/compat';
import type { Op } from '@hsw-editor/core';
import { ToolAssetIndexSchema } from '@hsw-editor/tools/contract';
import { buildShowcaseWall } from '../src/demo/showcase.ts';
import { SHOWCASE_LAYOUT } from '../src/demo/showcaseLayout.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const api = flag('api', 'http://127.0.0.1:8794').replace(/\/+$/, '');
const id = flag('id', 'showcase');

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${api}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

interface BankElementLike {
  id: string;
  category: string;
  bboxMm: HolderSpec['bboxMm'];
  fitsTool?: HolderSpec['fitsTool'];
}

const bankIndex = (await getJson('/api/bank/index')) as { elements: BankElementLike[] };
const tools = ToolAssetIndexSchema.parse(await getJson('/api/tools/assets/index'));
const specs = new Map<string, HolderSpec>(
  bankIndex.elements.map((element) => [
    element.id,
    {
      id: element.id,
      category: element.category,
      fitsTool: element.fitsTool ?? [],
      bboxMm: element.bboxMm,
    },
  ]),
);
const { wall, unhung } = buildShowcaseWall(
  id,
  'Showcase: generated tools',
  SHOWCASE_LAYOUT,
  specs,
  tools,
);
if (unhung.length > 0) console.error(`not hung: ${unhung.join('; ')}`);

if (args.includes('--replace')) {
  const removed = await fetch(`${api}/api/walls/${id}`, { method: 'DELETE' });
  if (!removed.ok && removed.status !== 404)
    console.error(`delete wall ${id}: HTTP ${removed.status}`);
}
const created = await fetch(`${api}/api/walls`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, name: wall.name }),
});
if (!created.ok) throw new Error(`create wall: HTTP ${created.status} ${await created.text()}`);
const ops: Op[] = [
  ...wall.models.map((model): Op => ({ type: 'addModelRef', model })),
  ...wall.items.map((item): Op => ({ type: 'addItem', item })),
];
const applied = await fetch(`${api}/api/walls/${id}/ops`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ops: [{ type: 'batch', label: 'showcase', ops }] }),
});
if (!applied.ok) throw new Error(`ops: HTTP ${applied.status} ${await applied.text()}`);
if (args.includes('--template')) {
  const marked = await fetch(`${api}/api/walls/${id}/template`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: true }),
  });
  if (!marked.ok) throw new Error(`template: HTTP ${marked.status} ${await marked.text()}`);
}
console.log(`wall ${id}: ${wall.items.length} items, ${wall.models.length} models on ${api}`);
