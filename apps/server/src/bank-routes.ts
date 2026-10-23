/**
 * `/api/bank/*` and `/bank/assets/*`: the element bank served by `createBankHandler`, with the user's own
 * elements merged in (`/api/bank/user/*`, bank-user.ts). Contract: docs/bank.md, docs/api.md.
 */
import { bankContextFor, handleUserRoutes } from './bank-user.ts';
import type { ServerModule } from './modules.ts';

export const bankModule: ServerModule = {
  name: 'bank',
  async handle(request, deps) {
    return (
      (await handleUserRoutes(request, deps)) ?? bankContextFor(deps.config.home).handler(request)
    );
  },
};
