/**
 * The App Router's ISR page cache (vinext start): a page rendered with a
 * finite revalidate (its Cache-Control carries s-maxage) is kept by key
 * ("html:<path and query>" or "rsc:<path and query>") and served as x-vinext-cache HIT until it
 * is that many seconds old, then STALE while one background render replaces
 * it. revalidatePath()/revalidateTag() drop entries.
 */
import { onInvalidate, pathMatches } from "../../shims/internal/data-cache.js";

const KEY = Symbol.for("vinext.appIsrCache");
const cache = (globalThis[KEY] ??= new Map());
const UNSUBSCRIBE = Symbol.for("vinext.appIsrCache.unsubscribe");
globalThis[UNSUBSCRIBE] ??= onInvalidate(({ tags, path, type }) => {
  for (const [key, entry] of cache) {
    if (tags ? entry.tags.some((t) => tags.includes(t)) : pathMatches(path, type, entry.pathname)) cache.delete(key);
  }
});

/** The seconds in a Cache-Control's s-maxage, or null. */
export function revalidateSeconds(cacheControl) {
  const m = /(?:^|[,\s])s-maxage=([\d.]+)/.exec(cacheControl || "");
  return m ? Number(m[1]) : null;
}

/** A cache entry for a rendered response, or null when it is not an ISR page. */
async function entryFor(pathname, { response, tags = [] }) {
  const seconds = response.status === 200 ? revalidateSeconds(response.headers.get("cache-control")) : null;
  if (!seconds || response.headers.has("set-cookie")) return null;
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    body,
    status: response.status,
    headers: [...response.headers],
    tags: [...tags],
    pathname,
    staleAt: Date.now() + seconds * 1000,
    regenerating: false,
  };
}

function respond(entry, state) {
  const headers = new Headers(entry.headers);
  headers.set("x-vinext-cache", state);
  return new Response(entry.body.slice(), { status: entry.status, headers });
}

/**
 * Answer from the cache, or with `render()` ({ response, tags }) stored when
 * it is an ISR page. `pathname` is what revalidatePath() matches.
 */
export async function serveWithIsr(key, pathname, render) {
  const hit = cache.get(key);
  if (hit) {
    if (Date.now() < hit.staleAt) return respond(hit, "HIT");
    if (!hit.regenerating) {
      hit.regenerating = true;
      regenerate(key, pathname, hit, render);
    }
    return respond(hit, "STALE");
  }
  const rendered = await render();
  const entry = await entryFor(pathname, rendered).catch(() => null);
  if (!entry) return rendered.response;
  cache.set(key, entry);
  return respond(entry, "MISS");
}

function regenerate(key, pathname, stale, render) {
  Promise.resolve()
    .then(render)
    .then((rendered) => entryFor(pathname, rendered))
    .then((entry) => {
      if (cache.get(key) !== stale) return;
      if (entry) cache.set(key, entry);
      else cache.delete(key);
    })
    .catch((error) => {
      console.error(`[vinext] ISR regeneration of ${pathname} failed:`, error);
      stale.regenerating = false;
    });
}
