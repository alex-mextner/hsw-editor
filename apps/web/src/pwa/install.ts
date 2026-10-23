/**
 * "Install the app". Chromium browsers fire `beforeinstallprompt` when the PWA is installable; the editor
 * keeps the event and offers an Install button that calls `prompt()`. Safari on iPhone has no such event:
 * the only way is Share -> Add to Home Screen, so there the panel shows that hint instead (`iosHint`).
 */

/** `beforeinstallprompt` is not in lib.dom. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

export function isInstallPromptEvent(event: Event): event is InstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;
}

export interface InstallEnv {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  /** `navigator.standalone` (iOS) or the `(display-mode: standalone)` media query. */
  readonly standalone: () => boolean;
  readonly listen: (
    type: 'beforeinstallprompt' | 'appinstalled',
    fn: (event: Event) => void,
  ) => void;
}

export interface InstallState {
  /** The browser offered an install prompt we can show on demand. */
  readonly canPrompt: boolean;
  /** Running as an installed app (standalone window / home-screen icon). */
  readonly installed: boolean;
  /** iPhone/iPad Safari: show the "Share -> Add to Home Screen" hint. */
  readonly iosHint: boolean;
}

export function isIos(env: Pick<InstallEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/iPad|iPhone|iPod/.test(env.userAgent)) return true;
  // iPadOS 13+ reports itself as a Mac with a touch screen.
  return env.platform === 'MacIntel' && env.maxTouchPoints > 1;
}

export class InstallController {
  private deferred: InstallPromptEvent | null = null;
  private state: InstallState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly env: InstallEnv) {
    const installed = env.standalone();
    this.state = { canPrompt: false, installed, iosHint: isIos(env) && !installed };
    env.listen('beforeinstallprompt', (event) => {
      if (!isInstallPromptEvent(event)) return;
      // Keep the event: the browser's own mini-infobar is replaced by our button.
      event.preventDefault();
      this.deferred = event;
      this.set({ canPrompt: true });
    });
    env.listen('appinstalled', () => {
      this.deferred = null;
      this.set({ canPrompt: false, installed: true, iosHint: false });
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): InstallState => this.state;

  /** Shows the browser's install dialog. `unavailable` when the browser has not offered one. */
  async prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = this.deferred;
    if (!event) return 'unavailable';
    // A prompt event can be used once.
    this.deferred = null;
    this.set({ canPrompt: false });
    await event.prompt();
    return (await event.userChoice).outcome;
  }

  private set(patch: Partial<InstallState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
