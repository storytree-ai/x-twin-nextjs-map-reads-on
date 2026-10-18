/**
 * Per-render state for the Pages Router (vinext/unified-request-context):
 * the head elements next/head collected, a private per-render cache and the
 * HTML callbacks to insert into <head>. Every render, a background ISR
 * regeneration included, starts from a fresh context. The server installs
 * the AsyncLocalStorage (server/render-context.js); this module stays
 * browser-safe, where every call gets a throwaway context.
 */
export const UNIFIED_CONTEXT_KEY = Symbol.for("vinext.unifiedRequestContext");

export function createUnifiedRequestContext() {
  return { ssrHeadChildren: [], _privateCache: null, serverInsertedHTMLCallbacks: [] };
}

/** The current render's context (a throwaway one outside a render). */
export function getRequestContext() {
  return globalThis[UNIFIED_CONTEXT_KEY]?.getStore() || createUnifiedRequestContext();
}
