import { describe, expect, test } from 'bun:test';
import { mount, withDomGlobals } from '@/test/dom.tsx';
import { type HolderRating, useRankedCandidates } from './suggest.ts';

withDomGlobals();

interface Card {
  readonly element: { readonly id: string };
  readonly score: number;
}

const card = (id: string, score: number): Card => ({ element: { id }, score });
const rating = (stability: number): HolderRating => ({
  stability,
  convenience: stability,
  status: stability > 0.7 ? 'stable' : 'unstable',
  reasons: [],
});

function List({
  cards,
  ratings,
}: {
  readonly cards: readonly Card[];
  readonly ratings: ReadonlyMap<string, HolderRating>;
}) {
  const ordered = useRankedCandidates(cards, ratings);
  return <p data-testid="order">{ordered.map((c) => c.element.id).join(',')}</p>;
}

const orderOf = (container: HTMLElement): string | null =>
  container.querySelector('[data-testid="order"]')?.textContent ?? null;

describe('useRankedCandidates', () => {
  test('compatibility order until ratings arrive, then re-ranked; small shifts keep the row order, big ones re-sort', async () => {
    const cards = [card('a', 0.9), card('b', 0.88), card('c', 0.86)];
    const none = new Map<string, HolderRating>();
    const mounted = await mount(<List cards={cards} ratings={none} />);
    expect(orderOf(mounted.container)).toBe('a,b,c');

    // b becomes a little better than a: one place apart, the list stays as it is under the pointer.
    await mounted.render(
      <List
        cards={cards}
        ratings={
          new Map([
            ['a', rating(0.5)],
            ['b', rating(0.6)],
            ['c', rating(0.4)],
          ])
        }
      />,
    );
    expect(orderOf(mounted.container)).toBe('a,b,c');

    // c turns out far the best: two places up, so the list re-sorts.
    await mounted.render(
      <List
        cards={cards}
        ratings={
          new Map([
            ['a', rating(0.2)],
            ['b', rating(0.3)],
            ['c', rating(1)],
          ])
        }
      />,
    );
    expect(orderOf(mounted.container)).toBe('c,b,a');
    await mounted.unmount();
  });

  test('settles on the ranked order (React throws on a render loop)', async () => {
    // b fits a little less than the unrated a, but hangs perfectly: 0.3 * 0.8 + 0.7 * 1 beats a's 0.9.
    const cards = [card('a', 0.9), card('b', 0.8)];
    const ratings = new Map([['b', rating(1)]]);
    const mounted = await mount(<List cards={cards} ratings={ratings} />);
    expect(orderOf(mounted.container)).toBe('b,a');
    await mounted.unmount();
  });
});
