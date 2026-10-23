/** Pure parts of the request queue: SSE event parsing and list maintenance. */
import {
  RequestInputEventSchema,
  RequestResolvedEventSchema,
  type InputRequest,
  type RequestStatus,
} from '@/api/requests.ts';

export type RequestEvent =
  | { readonly type: 'opened'; readonly request: InputRequest }
  | { readonly type: 'resolved'; readonly id: string; readonly status: RequestStatus };

/** EventSource hands over strings; callers that already parsed the JSON pass the object. */
function toJson(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** `null` for anything this build cannot use: unknown event names, malformed data, unknown kinds. */
export function parseRequestEvent(name: string, data: unknown): RequestEvent | null {
  const json = toJson(data);
  if (name === 'request_input') {
    const parsed = RequestInputEventSchema.safeParse(json);
    return parsed.success ? { type: 'opened', request: parsed.data.request } : null;
  }
  if (name === 'request_resolved') {
    const parsed = RequestResolvedEventSchema.safeParse(json);
    return parsed.success
      ? { type: 'resolved', id: parsed.data.id, status: parsed.data.status }
      : null;
  }
  return null;
}

function millis(request: InputRequest): number {
  const { createdAt } = request;
  if (typeof createdAt === 'number') return createdAt;
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Oldest first; the id breaks ties so every client shows the same "first" request. */
export function sortRequests(requests: readonly InputRequest[]): InputRequest[] {
  return [...requests].sort(
    (a, b) => millis(a) - millis(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Only open requests are kept: an answered/cancelled one disappears whoever resolved it. */
export function applyRequestEvent(
  requests: readonly InputRequest[],
  event: RequestEvent,
): readonly InputRequest[] {
  if (event.type === 'resolved') {
    return event.status === 'open' ? requests : requests.filter((entry) => entry.id !== event.id);
  }
  const others = requests.filter((entry) => entry.id !== event.request.id);
  return event.request.status === 'open' ? sortRequests([...others, event.request]) : others;
}
