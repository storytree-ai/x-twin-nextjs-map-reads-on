/**
 * Route segment config (`export const revalidate`, `dynamic`, …) merged over
 * a route's layouts and page, and the Cache-Control a rendered page gets.
 */

export const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

/** Merge segment config from modules ordered root layout first, page last. */
export function resolveSegmentConfig(mods) {
  const config = { revalidate: undefined, dynamic: "auto", dynamicParams: true };
  for (const mod of mods) {
    if (!mod) continue;
    if (typeof mod.revalidate === "number" || mod.revalidate === false) {
      const value = mod.revalidate === false ? Infinity : mod.revalidate;
      config.revalidate = config.revalidate === undefined ? value : Math.min(config.revalidate, value);
    }
    if (typeof mod.dynamic === "string") config.dynamic = mod.dynamic;
    if (mod.dynamicParams === false) config.dynamicParams = false;
  }
  return config;
}

/** Cache-Control for a page rendered with `config`; `dynamic` when it read request-time data. */
export function pageCacheControl(config, dynamic) {
  if (config.dynamic === "force-dynamic" || config.revalidate === 0) return NO_STORE;
  if (dynamic && config.dynamic !== "force-static") return NO_STORE;
  const { revalidate } = config;
  if (typeof revalidate === "number" && revalidate > 0 && revalidate !== Infinity) {
    return `s-maxage=${revalidate}, stale-while-revalidate`;
  }
  return null;
}

/**
 * The body and Cache-Control for a rendered page. A page that would be
 * cacheable is rendered to the end first, so a dynamic API read late (inside
 * a Suspense boundary) still turns it to no-store; others keep streaming.
 */
export async function finalizeCacheControl(stream, config, isDynamic) {
  const early = pageCacheControl(config, isDynamic());
  if (early === null || early === NO_STORE) return { body: stream, cacheControl: early };
  const body = new Uint8Array(await new Response(stream).arrayBuffer());
  return { body, cacheControl: pageCacheControl(config, isDynamic()) };
}
