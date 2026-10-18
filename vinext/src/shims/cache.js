/**
 * next/cache: the data cache (unstable_cache, cacheLife/cacheTag inside
 * "use cache") and revalidation. revalidatePath()/revalidateTag() drop cached
 * data and ISR pages, and mark the request: a server action that revalidates
 * answers with the page re-rendered.
 */
import { getRequestContext, markDynamic } from "./internal/request-context.js";
import { cached, stableKey, invalidateTags, invalidatePath, setCacheLife, addCacheTags } from "./internal/data-cache.js";

function markRevalidated() {
  const ctx = getRequestContext();
  if (ctx) ctx.revalidated = true;
}

export function revalidatePath(path, type) {
  if (typeof path === "string") invalidatePath(path, type);
  markRevalidated();
}

export function revalidateTag(tag, _profile) {
  if (typeof tag === "string") invalidateTags([tag]);
  markRevalidated();
}

export function updateTag(tag) {
  revalidateTag(tag);
}

/** Refresh the client router after the current server action. */
export function refresh() {
  markRevalidated();
}

export function unstable_noStore() {
  markDynamic();
}

export { unstable_noStore as noStore };

/**
 * Cache `fn`'s result by `keyParts` and its arguments, for `revalidate`
 * seconds (false: until revalidated) and under `tags`.
 */
export function unstable_cache(fn, keyParts = [], options = {}) {
  const tags = Array.isArray(options.tags) ? options.tags : [];
  const revalidate = options.revalidate === false ? Infinity : options.revalidate;
  const base = `unstable-cache:${keyParts.length ? stableKey(keyParts) : fn.toString()}`;
  return async (...args) =>
    cached(`${base}:${stableKey(args)}`, async () => ({ value: await fn(...args) }), { tags, revalidate });
}

/** The cache life ("seconds", "minutes", … or { revalidate, expire, stale }) of the enclosing "use cache" function. */
export function cacheLife(profile) {
  setCacheLife(profile);
}

/** Tags for the enclosing "use cache" function's entry. */
export function cacheTag(...tags) {
  addCacheTags(tags.flat());
}

export { cacheLife as unstable_cacheLife, cacheTag as unstable_cacheTag };
