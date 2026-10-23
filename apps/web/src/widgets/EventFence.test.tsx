import { describe, expect, test } from 'bun:test';
import { mount, withDomGlobals } from '@/test/dom.tsx';
import { EventFence } from './EventFence.tsx';

withDomGlobals();

describe('EventFence', () => {
  test.each(['contextmenu', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'keydown'])(
    '%s inside the fence does not reach the canvas container',
    async (type) => {
      const reached: string[] = [];
      const mounted = await mount(
        <div
          role="presentation"
          onContextMenu={() => reached.push('contextmenu')}
          onClick={() => reached.push('click')}
          onDoubleClick={() => reached.push('dblclick')}
          onPointerDown={() => reached.push('pointerdown')}
          onPointerUp={() => reached.push('pointerup')}
          onWheel={() => reached.push('wheel')}
          onKeyDown={() => reached.push('keydown')}
        >
          <EventFence onEscape={() => undefined}>
            <button type="button">inside</button>
          </EventFence>
        </div>,
      );
      const inside = mounted.container.querySelector('button');
      if (!inside) throw new Error('button missing');
      inside.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
      await mounted.unmount();
      expect(reached).toEqual([]);
    },
  );

  test('Escape inside the fence asks to dismiss', async () => {
    let escapes = 0;
    const mounted = await mount(
      <EventFence onEscape={() => (escapes += 1)}>
        <button type="button">inside</button>
      </EventFence>,
    );
    const inside = mounted.container.querySelector('button');
    if (!inside) throw new Error('button missing');
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    inside.dispatchEvent(event);
    await mounted.unmount();
    expect(escapes).toBe(1);
  });
});
