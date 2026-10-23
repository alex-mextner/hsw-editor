/** Maps a failed user-element API call to a localised message key (the dialog shows it inline and keeps the form). */
import { ApiError, NetworkError } from '@/api/http.ts';
import type { MessageKey } from '@/i18n/index.ts';

export interface UserErrorMessage {
  readonly key: MessageKey;
  /** The server's own text, for the generic keys that have a `{detail}` placeholder. */
  readonly detail: string;
}

export function userErrorMessage(error: unknown): UserErrorMessage {
  if (error instanceof NetworkError) return { key: 'bank.user.error.offline', detail: '' };
  if (error instanceof ApiError) {
    const detail = error.message;
    switch (error.status) {
      case 413:
        return { key: 'bank.user.error.tooLarge', detail };
      case 415:
        return { key: 'bank.user.error.unsupported', detail };
      case 422:
        return { key: 'bank.user.error.unreadable', detail };
      case 503:
        return { key: 'bank.user.error.converter', detail };
      case 404:
        return { key: 'bank.user.error.notFound', detail };
      case 400:
        return { key: 'bank.user.error.invalid', detail };
      default:
        return { key: 'bank.user.error.generic', detail };
    }
  }
  return {
    key: 'bank.user.error.generic',
    detail: error instanceof Error ? error.message : String(error),
  };
}
