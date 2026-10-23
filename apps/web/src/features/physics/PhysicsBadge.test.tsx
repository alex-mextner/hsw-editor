import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { localeStore } from '@/i18n/index.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { PhysicsBadge, type HolderPhysicsRating } from './PhysicsBadge.tsx';

let mounted: Mounted | null = null;
beforeEach(() => localeStore.set('en'));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
withDomGlobals();

const rating = (patch: Partial<HolderPhysicsRating>): HolderPhysicsRating => ({
  stability: 0.9,
  convenience: 0.9,
  status: 'stable',
  reasons: [],
  ...patch,
});

describe('PhysicsBadge', () => {
  test('a stable, comfortable holder shows one chip', async () => {
    mounted = await mount(<PhysicsBadge rating={rating({})} />);
    expect(mounted.container.textContent).toBe('Stable');
  });

  test('an unstable holder shows the reason sentence as its tooltip', async () => {
    mounted = await mount(
      <PhysicsBadge
        rating={rating({
          status: 'unstable',
          stability: 0.2,
          reasons: [{ code: 'slides_off', params: { marginG: 0.1, neededG: 0.3 } }],
        })}
      />,
    );
    const badge = mounted.container.querySelector<HTMLElement>('[data-testid="physics-badge"]');
    expect(badge?.textContent).toBe('Unstable');
    expect(badge?.title).toBe('Hang: Unstable\nSlides off sideways when bumped');
  });

  test('convenience below 0.5 adds an "Awkward" chip, 0.5 does not', async () => {
    mounted = await mount(
      <PhysicsBadge rating={rating({ convenience: 0.49, status: 'marginal' })} />,
    );
    expect(mounted.container.textContent).toBe('MarginalAwkward');
    await mounted.render(<PhysicsBadge rating={rating({ convenience: 0.5 })} />);
    expect(mounted.container.textContent).toBe('Stable');
    await mounted.render(<PhysicsBadge rating={rating({ convenience: null })} />);
    expect(mounted.container.textContent).toBe('Stable');
  });

  test('renders nothing while the rating is unknown, and speaks Russian', async () => {
    mounted = await mount(<PhysicsBadge rating={undefined} />);
    expect(mounted.container.textContent).toBe('');
    await act(async () => localeStore.set('ru'));
    await mounted.render(
      <PhysicsBadge rating={rating({ status: 'marginal', convenience: 0.1 })} />,
    );
    expect(mounted.container.textContent).toBe('На грани' + 'Неудобно');
  });
});
