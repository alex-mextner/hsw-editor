import { describe, expect, test } from 'bun:test';
import { ApiError, NetworkError } from '@/api/http.ts';
import { userErrorMessage } from './userErrors.ts';

const api = (status: number, code: string): ApiError =>
  new ApiError(status, code, 'server text', null);

describe('userErrorMessage', () => {
  test('upload failures map to their own message', () => {
    expect(userErrorMessage(api(415, 'unsupported_media_type')).key).toBe(
      'bank.user.error.unsupported',
    );
    expect(userErrorMessage(api(413, 'payload_too_large')).key).toBe('bank.user.error.tooLarge');
    expect(userErrorMessage(api(422, 'mesh_unreadable')).key).toBe('bank.user.error.unreadable');
    expect(userErrorMessage(api(503, 'converter_unavailable')).key).toBe(
      'bank.user.error.converter',
    );
  });

  test('a dead daemon is the offline message, the form is kept', () => {
    expect(userErrorMessage(new NetworkError(new Error('fetch failed'))).key).toBe(
      'bank.user.error.offline',
    );
  });

  test('the server text travels as detail', () => {
    expect(userErrorMessage(api(400, 'invalid_body'))).toEqual({
      key: 'bank.user.error.invalid',
      detail: 'server text',
    });
    expect(userErrorMessage(new Error('boom'))).toEqual({
      key: 'bank.user.error.generic',
      detail: 'boom',
    });
  });
});
