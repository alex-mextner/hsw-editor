import { describe, expect, test } from 'bun:test';
import { InstallController, isIos, type InstallEnv, type InstallPromptEvent } from './install.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36';

function env(overrides: Partial<InstallEnv> = {}) {
  const listeners: Record<string, ((event: Event) => void)[]> = {};
  const full: InstallEnv = {
    userAgent: DESKTOP,
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    standalone: () => false,
    listen: (type, fn) => {
      listeners[type] = [...(listeners[type] ?? []), fn];
    },
    ...overrides,
  };
  return {
    env: full,
    fire: (type: string, event: Event) => listeners[type]?.forEach((fn) => fn(event)),
  };
}

function promptEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  let prompted = 0;
  Object.assign(event, {
    prompt: () => {
      prompted += 1;
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome }),
  });
  return { event: event as InstallPromptEvent, prompted: () => prompted };
}

describe('isIos', () => {
  test('iPhone, iPad and iPadOS-as-Mac are iOS; a desktop is not', () => {
    expect(isIos({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: DESKTOP, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: DESKTOP, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: DESKTOP, platform: 'Linux x86_64', maxTouchPoints: 0 })).toBe(false);
  });
});

describe('InstallController', () => {
  test('a desktop starts with nothing to offer until the browser says the app is installable', () => {
    const { env: e, fire } = env();
    const controller = new InstallController(e);
    expect(controller.getSnapshot()).toEqual({
      canPrompt: false,
      installed: false,
      iosHint: false,
    });
    const { event } = promptEvent('accepted');
    fire('beforeinstallprompt', event);
    expect(controller.getSnapshot().canPrompt).toBe(true);
    // The browser's own mini-infobar is suppressed so our button is the one way to install.
    expect(event.defaultPrevented).toBe(true);
  });

  test('prompt() shows the browser dialog once and reports the choice', async () => {
    const { env: e, fire } = env();
    const controller = new InstallController(e);
    const { event, prompted } = promptEvent('accepted');
    fire('beforeinstallprompt', event);
    expect(await controller.prompt()).toBe('accepted');
    expect(prompted()).toBe(1);
    expect(controller.getSnapshot().canPrompt).toBe(false);
    expect(await controller.prompt()).toBe('unavailable');
  });

  test('a dismissed prompt is reported as dismissed', async () => {
    const { env: e, fire } = env();
    const controller = new InstallController(e);
    fire('beforeinstallprompt', promptEvent('dismissed').event);
    expect(await controller.prompt()).toBe('dismissed');
  });

  test('prompt() with no offer is unavailable', async () => {
    expect(await new InstallController(env().env).prompt()).toBe('unavailable');
  });

  test('iPhone Safari gets the Share -> Add to Home Screen hint until it runs standalone', () => {
    const phone = env({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 });
    expect(new InstallController(phone.env).getSnapshot()).toMatchObject({
      iosHint: true,
      installed: false,
    });
    const installed = env({
      userAgent: IPHONE,
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: () => true,
    });
    expect(new InstallController(installed.env).getSnapshot()).toMatchObject({
      iosHint: false,
      installed: true,
    });
  });

  test('appinstalled flips to installed and withdraws the offer', () => {
    const { env: e, fire } = env();
    const controller = new InstallController(e);
    fire('beforeinstallprompt', promptEvent('accepted').event);
    fire('appinstalled', new Event('appinstalled'));
    expect(controller.getSnapshot()).toEqual({ canPrompt: false, installed: true, iosHint: false });
  });

  test('an unrelated event named beforeinstallprompt without the API is ignored', () => {
    const { env: e, fire } = env();
    const controller = new InstallController(e);
    fire('beforeinstallprompt', new Event('beforeinstallprompt'));
    expect(controller.getSnapshot().canPrompt).toBe(false);
  });
});
