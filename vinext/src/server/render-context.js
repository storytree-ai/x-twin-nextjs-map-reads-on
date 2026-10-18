/** The server half of vinext/unified-request-context: one store per process. */
import { AsyncLocalStorage } from "node:async_hooks";
import { UNIFIED_CONTEXT_KEY } from "../unified-request-context.js";

const storage = (globalThis[UNIFIED_CONTEXT_KEY] ??= new AsyncLocalStorage());

export { createUnifiedRequestContext } from "../unified-request-context.js";

export function runWithUnifiedRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}
