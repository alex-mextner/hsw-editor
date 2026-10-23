/** Messages the page sends to the service worker. One today: the user accepted an update. */
export interface SkipWaitingMessage {
  readonly type: 'SKIP_WAITING';
}

export const SKIP_WAITING: SkipWaitingMessage = { type: 'SKIP_WAITING' };

export function isSkipWaiting(data: unknown): data is SkipWaitingMessage {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === SKIP_WAITING.type
  );
}
