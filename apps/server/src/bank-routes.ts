/** `/api/bank/*` and `/bank/assets/*`: the element bank served by `createBankHandler`. Contract: docs/bank.md. */
import { bankPaths, createBankHandler } from '@hsw-editor/bank/node';
import type { ServerModule } from './modules.ts';

type BankHandler = ReturnType<typeof createBankHandler>;

/** One handler per data home: it caches the loaded index and reloads when `index.json` changes. */
const handlers = new Map<string, BankHandler>();

function handlerFor(home: string): BankHandler {
  let handler = handlers.get(home);
  if (handler === undefined) {
    const paths = bankPaths({ ...process.env, HSW_EDITOR_HOME: home });
    handler = createBankHandler({ paths });
    handlers.set(home, handler);
  }
  return handler;
}

export const bankModule: ServerModule = {
  name: 'bank',
  handle: (request, deps) => handlerFor(deps.config.home)(request),
};
