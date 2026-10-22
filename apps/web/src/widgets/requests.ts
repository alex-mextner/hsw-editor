/**
 * Open input requests of the open wall. Nothing is persisted client-side: the server is the source
 * of truth, this store mirrors `GET /requests?status=open` plus the live SSE events.
 *
 * Wiring (wall/session.ts): `loadOpenRequests(wallId)` when a wall opens, `handleRequestEvent` for the
 * `request_input` / `request_resolved` SSE events, `clearRequests()` when the wall closes.
 */
import { createValueStore } from '#state-backend';
import type { JsonValue } from '@hsw-editor/core';
import {
  answerRequest,
  cancelRequest,
  listOpenRequests,
  type InputRequest,
} from '@/api/requests.ts';
import { useStore } from '@/state/react.ts';
import { applyRequestEvent, parseRequestEvent, sortRequests } from './requestsLogic.ts';

export interface RequestsState {
  /** Wall the list belongs to; null before the first load. */
  readonly wallId: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** Open requests, oldest first. */
  readonly requests: readonly InputRequest[];
}

const IDLE: RequestsState = { wallId: null, status: 'idle', requests: [] };

export const requestsStore = createValueStore<RequestsState>(IDLE);

/** Bumped per load so a slow response for a wall that was closed meanwhile is discarded. */
let generation = 0;
/** Requests resolved while a load was in flight: the (older) list response must not resurrect them. */
const resolvedDuringLoad = new Set<string>();
/** Requests raised by events while a load was in flight: newer than the response, so they are kept. */
const arrivedDuringLoad = new Map<string, InputRequest>();

function setRequests(requests: readonly InputRequest[]): void {
  requestsStore.set({ ...requestsStore.get(), requests });
}

function forget(id: string): void {
  resolvedDuringLoad.add(id);
  arrivedDuringLoad.delete(id);
  setRequests(requestsStore.get().requests.filter((entry) => entry.id !== id));
}

export function clearRequests(): void {
  generation += 1;
  resolvedDuringLoad.clear();
  arrivedDuringLoad.clear();
  requestsStore.set(IDLE);
}

export async function loadOpenRequests(wallId: string): Promise<void> {
  generation += 1;
  const mine = generation;
  resolvedDuringLoad.clear();
  arrivedDuringLoad.clear();
  // Reloading the same wall (SSE reconnect) keeps the cards on screen so half-filled forms survive;
  // the server list below replaces them, so a request resolved while disconnected disappears.
  const previous = requestsStore.get();
  const kept = previous.wallId === wallId ? previous.requests : [];
  requestsStore.set({ wallId, status: 'loading', requests: kept });
  try {
    const fetched = await listOpenRequests(wallId);
    if (mine !== generation) return;
    // Events seen during the fetch are newer than the response and win over its copy of the same id.
    const merged = [
      ...fetched.filter(
        (entry) => !resolvedDuringLoad.has(entry.id) && !arrivedDuringLoad.has(entry.id),
      ),
      ...arrivedDuringLoad.values(),
    ];
    requestsStore.set({ wallId, status: 'ready', requests: sortRequests(merged) });
  } catch {
    if (mine === generation)
      requestsStore.set({ wallId, status: 'error', requests: requestsStore.get().requests });
  }
}

/** SSE entry point; data that cannot be read is ignored, never thrown. */
export function handleRequestEvent(
  name: 'request_input' | 'request_resolved',
  data: unknown,
): void {
  const event = parseRequestEvent(name, data);
  if (!event) return;
  if (event.type === 'resolved') {
    resolvedDuringLoad.add(event.id);
    arrivedDuringLoad.delete(event.id);
  } else if (event.request.status === 'open') {
    resolvedDuringLoad.delete(event.request.id);
    arrivedDuringLoad.set(event.request.id, event.request);
  } else {
    // A re-announcement that is already answered/cancelled closes the request like a resolve does.
    resolvedDuringLoad.add(event.request.id);
    arrivedDuringLoad.delete(event.request.id);
  }
  setRequests(applyRequestEvent(requestsStore.get().requests, event));
}

/** The request the UI shows now: the oldest open one. */
export function activeRequest(state: RequestsState): InputRequest | undefined {
  return state.requests[0];
}

export function useRequests(): RequestsState {
  return useStore(requestsStore);
}

/** Tells the asker what the user did; the request leaves the queue as soon as the server accepts. */
export async function answerOpenRequest(
  wallId: string,
  requestId: string,
  answer: JsonValue,
): Promise<void> {
  await answerRequest(wallId, requestId, answer);
  forget(requestId);
}

/** "Skip": the asker is told the request was cancelled. */
export async function dismissOpenRequest(wallId: string, requestId: string): Promise<void> {
  await cancelRequest(wallId, requestId);
  forget(requestId);
}
