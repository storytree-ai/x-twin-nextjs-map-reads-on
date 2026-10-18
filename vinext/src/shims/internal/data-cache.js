/**
 * The data cache behind unstable_cache, "use cache" and cached fetch: values
 * by key in this process, each with its tags, the paths rendered while it was
 * made, and when it goes stale. revalidateTag/revalidatePath drop entries.
 * One store per process, found through globalThis (Vite may load a module
 * more than once).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestContext } from "./request-context.js";

const STATE = Symbol.for("vinext.dataCache");
const state = (globalThis[STATE] ??= {
  entries: new Map(),
  pending: new Map(),
  // "use cache" scopes: what cacheLife()/cacheTag() inside one set.
  scopes: new AsyncLocalStorage(),
  // Listeners told of revalidateTag/revalidatePath (the ISR page cache).
  listeners: new Set(),
});

/** Next.js's built-in cacheLife profiles, in seconds. */
export const CACHE_LIFE_PROFILES = {
  default: { stale: 300, revalidate: 900, expire: Infinity },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: Infinity },
};

export function resetDataCache() {
  state.entries.clear();
  state.pending.clear();
}

/** A stable string for cache keys: object keys sorted, functions and symbols left out. */
export function stableKey(value, seen = new Set()) {
  if (value === undefined) return "u";
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") return "f";
    if (typeof value === "bigint") return `n${value}`;
    return JSON.stringify(value) ?? "u";
  }
  if (seen.has(value)) return "c";
  seen.add(value);
  let out;
  if (value instanceof Date) out = `d${value.toISOString()}`;
  else if (value instanceof URLSearchParams) out = `q${value.toString()}`;
  else if (value instanceof Map) out = `m${stableKey([...value.entries()], seen)}`;
  else if (value instanceof Set) out = `s${stableKey([...value], seen)}`;
  else if (Array.isArray(value)) out = `[${value.map((v) => stableKey(v, seen)).join(",")}]`;
  else {
    const keys = Object.keys(value).sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return out;
}

function isFresh(entry, now = Date.now()) {
  return entry.expiresAt > now;
}

/** Note on the current request the tags the render used (its ISR entry is dropped with them). */
function recordTags(tags) {
  if (!tags.length) return;
  // An enclosing "use cache" function's entry carries the tags too.
  state.scopes.getStore()?.tags.push(...tags);
  const ctx = getRequestContext();
  if (!ctx) return;
  ctx.cacheTags ??= new Set();
  for (const tag of tags) ctx.cacheTags.add(tag);
}

/** The pathname the current request renders, when there is one. */
function requestPath() {
  const ctx = getRequestContext();
  if (!ctx?.request?.url) return null;
  try {
    return new URL(ctx.request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * The cached value for `key`, or the value `fn()` resolves to (stored for
 * `revalidate` seconds with `tags`). Concurrent calls for one key share a run;
 * a run that throws stores nothing.
 */
export async function cached(key, fn, { tags = [], revalidate } = {}) {
  const hit = state.entries.get(key);
  if (hit && isFresh(hit)) {
    recordTags(hit.tags);
    return hit.value;
  }
  if (state.pending.has(key)) {
    const { value, tags: used } = await state.pending.get(key);
    recordTags(used);
    return value;
  }
  const path = requestPath();
  const run = (async () => {
    const result = await fn();
    const allTags = [...new Set([...tags, ...(result.tags || [])])];
    const seconds = result.revalidate ?? revalidate;
    if (seconds !== 0) {
      state.entries.set(key, {
        value: result.value,
        tags: allTags,
        paths: path ? [path] : [],
        expiresAt: typeof seconds === "number" && seconds !== Infinity ? Date.now() + seconds * 1000 : Infinity,
      });
    }
    return { value: result.value, tags: allTags };
  })();
  state.pending.set(key, run);
  try {
    const { value, tags: used } = await run;
    recordTags(used);
    return value;
  } finally {
    state.pending.delete(key);
  }
}

/**
 * Call a "use cache" function: `id` names the function, `args` are its
 * arguments. cacheLife()/cacheTag() inside it set the entry's life and tags.
 */
export function useCache(id, fn, args) {
  const key = `use-cache:${id}:${stableKey(Array.from(args || []))}`;
  return cached(key, async () => {
    const scope = { tags: [], life: CACHE_LIFE_PROFILES.default };
    const value = await state.scopes.run(scope, () => fn(...Array.from(args || [])));
    return { value, tags: scope.tags, revalidate: scope.life.revalidate };
  });
}

/** cacheLife(profile) inside a "use cache" function. */
export function setCacheLife(profile) {
  const scope = state.scopes.getStore();
  if (!scope) return;
  if (typeof profile === "string") {
    const life = CACHE_LIFE_PROFILES[profile];
    if (!life) throw new Error(`[vinext] unknown cacheLife profile "${profile}"`);
    scope.life = life;
    return;
  }
  if (profile && typeof profile === "object") scope.life = { ...CACHE_LIFE_PROFILES.default, ...profile };
}

/** cacheTag(...tags) inside a "use cache" function. */
export function addCacheTags(tags) {
  const scope = state.scopes.getStore();
  if (scope) scope.tags.push(...tags.filter((t) => typeof t === "string"));
}

/** Drop entries carrying any of `tags`. */
export function invalidateTags(tags) {
  const set = new Set(tags);
  for (const [key, entry] of state.entries) {
    if (entry.tags.some((t) => set.has(t))) state.entries.delete(key);
  }
  for (const listener of state.listeners) listener({ tags: [...set] });
}

function normalizePath(p) {
  if (!p) return "/";
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Whether `pathname` falls under a revalidatePath(path, type) call. */
export function pathMatches(path, type, pathname) {
  const target = normalizePath(path);
  const actual = normalizePath(pathname);
  if (actual === target) return true;
  return type === "layout" && (target === "/" || actual.startsWith(target + "/"));
}

/** Drop entries made while rendering `path` (and, for type "layout", the paths below it). */
export function invalidatePath(path, type) {
  for (const [key, entry] of state.entries) {
    if (entry.paths.some((p) => pathMatches(path, type, p))) state.entries.delete(key);
  }
  for (const listener of state.listeners) listener({ path, type });
}

/** Be told of each invalidation: ({ tags }) or ({ path, type }). Returns an unsubscribe. */
export function onInvalidate(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Tags a render used, recorded on the request (for tagging other cache entries). */
export { recordTags };
