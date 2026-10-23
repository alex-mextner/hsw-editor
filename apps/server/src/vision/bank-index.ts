/**
 * The bank index (`GET /api/bank/index`: elements, tool classes, `contentHash`) for the vision jobs, read from the same
 * bank handler the daemon mounts (user elements included) instead of a loopback HTTP request to ourselves.
 */
import { type JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import { bankContextFor } from '../bank-user.ts';

/** `null` when no bank can be served: recognition then runs against the built-in vocabulary. */
export async function readBankIndex(home: string): Promise<JsonValue | null> {
  try {
    const response = await bankContextFor(home).handler(
      new Request('http://localhost/api/bank/index'),
    );
    if (response === null || !response.ok) {
      console.warn(`vision: no bank index (${response === null ? 'no route' : response.status})`);
      return null;
    }
    return z.json().parse(await response.json());
  } catch (error) {
    console.warn('vision: the bank index could not be read:', error);
    return null;
  }
}
