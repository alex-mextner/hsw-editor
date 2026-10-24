/**
 * Server module for tool physics: `GET /api/walls/:id/physics`, `GET /api/walls/:id/items/:itemId/physics` and the seat
 * proposals `GET /api/walls/:id/seat`, `GET /api/walls/:id/items/:itemId/seat`.
 * Contract: docs/api.md (Physics), the maths: docs/physics.md. Read-only; mounted after the global loopback guard.
 */
import { errorResponse } from '../api.ts';
import { HttpError } from '../http-error.ts';
import type { ServerDeps, ServerModule } from '../modules.ts';
import type { WallStore } from '../store/wall-store.ts';
import {
  createPhysicsService,
  ItemNotFoundError,
  NotAToolError,
  type PhysicsService,
} from './service.ts';

const WALL_ROUTE = /^\/api\/walls\/([^/]+)\/physics$/;
const ITEM_ROUTE = /^\/api\/walls\/([^/]+)\/items\/([^/]+)\/physics$/;
const SEAT_WALL_ROUTE = /^\/api\/walls\/([^/]+)\/seat$/;
const SEAT_ITEM_ROUTE = /^\/api\/walls\/([^/]+)\/items\/([^/]+)\/seat$/;

const SKIP_TEXT = {
  no_holder: 'it hangs on no holder (no parentId)',
  holder_missing: 'its holder is not on the wall or has no model in the bank',
  no_model: 'it has no tool model to weigh (a plain box preset)',
  no_physics: 'its model carries no mass',
} as const;

function decodeSegment(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    throw new HttpError(400, 'invalid_id', 'malformed id in the path');
  }
}

export function createPhysicsModule(): ServerModule {
  // The shared module list serves several daemons in tests: one service (and its caches) per store.
  const services = new WeakMap<WallStore, PhysicsService>();
  const serviceFor = (deps: ServerDeps): PhysicsService => {
    let service = services.get(deps.store);
    if (service === undefined) {
      service = createPhysicsService({ store: deps.store, home: deps.config.home });
      services.set(deps.store, service);
    }
    return service;
  };

  return {
    name: 'physics',
    async handle(request, deps) {
      const { pathname } = new URL(request.url);
      const seatWall = SEAT_WALL_ROUTE.exec(pathname);
      const seatItem = seatWall === null ? SEAT_ITEM_ROUTE.exec(pathname) : null;
      const wall = WALL_ROUTE.exec(pathname);
      const item = wall === null ? ITEM_ROUTE.exec(pathname) : null;
      if (wall === null && item === null && seatWall === null && seatItem === null) return null;
      if (request.method !== 'GET') {
        return Response.json(
          { error: { code: 'method_not_allowed', message: 'use GET' } },
          { status: 405, headers: { allow: 'GET' } },
        );
      }
      try {
        if (seatWall !== null || seatItem !== null) {
          const service = serviceFor(deps);
          const seatWallId = decodeSegment((seatWall ?? seatItem)?.[1]);
          const view =
            seatItem === null
              ? await service.proposeSeatAll(seatWallId)
              : await service.proposeSeat(seatWallId, decodeSegment(seatItem[2]));
          return Response.json(view, { headers: { 'cache-control': 'no-store' } });
        }
        const wallId = decodeSegment((wall ?? item)?.[1]);
        const itemId = item === null ? undefined : decodeSegment(item[2]);
        const report = await serviceFor(deps).analyseWall(
          wallId,
          itemId === undefined ? {} : { toolId: itemId },
        );
        if (itemId !== undefined && report.tools.length === 0) {
          const reason = report.skipped.find((s) => s.toolId === itemId)?.reason;
          throw new HttpError(
            409,
            'not_a_hung_tool',
            `item ${itemId} was not analysed: ${reason === undefined ? 'unknown reason' : SKIP_TEXT[reason]}`,
            { reason },
          );
        }
        return Response.json(report, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof ItemNotFoundError) {
          return errorResponse(new HttpError(404, 'item_not_found', error.message));
        }
        if (error instanceof NotAToolError) {
          return errorResponse(new HttpError(409, 'not_a_hung_tool', error.message));
        }
        return errorResponse(error);
      }
    },
  };
}
