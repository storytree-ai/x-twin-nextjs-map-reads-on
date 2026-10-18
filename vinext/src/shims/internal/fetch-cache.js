/**
 * fetch() as server code sees it: a GET with cache "force-cache" or
 * next.revalidate > 0 (or false) is answered from the data cache, under its
 * next.tags; cache "no-store" or next.revalidate 0 marks the render dynamic.
 */
import { cached } from "./data-cache.js";
import { markDynamic } from "./request-context.js";

const INSTALLED = Symbol.for("vinext.fetchCache");

/** A fetch that caches through the data cache, calling `base` on a miss. */
export function cachedFetch(base) {
  const wrapped = async function fetch(input, init = {}) {
    const next = init?.next || {};
    const request = input instanceof Request ? input : null;
    const method = (init?.method || request?.method || "GET").toUpperCase();
    const mode = init?.cache ?? request?.cache;
    const revalidate = next.revalidate === false ? Infinity : next.revalidate;
    if (mode === "no-store" || revalidate === 0) {
      markDynamic();
      return base(input, init);
    }
    const cacheable = (method === "GET" || method === "HEAD") && (mode === "force-cache" || (typeof revalidate === "number" && revalidate > 0));
    if (!cacheable) return base(input, init);
    const url = request ? request.url : String(input);
    const headers = [...new Headers(init?.headers || request?.headers || {})].sort();
    const key = `fetch:${method}:${url}:${JSON.stringify(headers)}`;
    const tags = Array.isArray(next.tags) ? next.tags : [];
    const stored = await cached(
      key,
      async () => {
        const res = await base(input, init);
        const body = new Uint8Array(await res.arrayBuffer());
        return { value: { body, status: res.status, statusText: res.statusText, headers: [...res.headers], url: res.url } };
      },
      { tags, revalidate },
    );
    const res = new Response(method === "HEAD" || stored.status === 204 || stored.status === 304 ? null : stored.body.slice(), {
      status: stored.status,
      statusText: stored.statusText,
      headers: stored.headers,
    });
    if (stored.url) Object.defineProperty(res, "url", { value: stored.url });
    return res;
  };
  wrapped[INSTALLED] = true;
  return wrapped;
}

/** Replace globalThis.fetch with the caching fetch, once per process. */
export function installFetchCache() {
  if (globalThis.fetch?.[INSTALLED]) return;
  globalThis.fetch = cachedFetch(globalThis.fetch.bind(globalThis));
}
