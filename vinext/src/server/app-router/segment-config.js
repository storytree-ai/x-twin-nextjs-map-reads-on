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
  if (config.dynamic === "force-static" || revalidate === Infinity) return null;
  // No revalidate config: vinext renders the page for every request.
  return NO_STORE;
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

/**
 * Whether `params` may render, given modules ordered root layout first,
 * page last: with dynamicParams = false (on any of them), only params
 * generateStaticParams returns do. Each generateStaticParams runs once for
 * every params set its parents generated, as in Next.js.
 */
export async function staticParamsAllow(mods, params) {
  if (resolveSegmentConfig(mods).dynamicParams !== false) return true;
  let generated = [];
  let parents = [{}];
  for (const mod of mods) {
    if (typeof mod?.generateStaticParams !== "function") continue;
    const next = [];
    for (const parent of parents) {
      const list = (await mod.generateStaticParams({ params: parent })) || [];
      for (const entry of list) next.push({ ...parent, ...entry });
    }
    generated = parents = next;
  }
  const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? [].concat(a ?? []).map(String).join("/") === [].concat(b ?? []).map(String).join("/") : String(a) === String(b));
  return generated.some((entry) => Object.keys(entry).every((key) => same(entry[key], params[key])));
}
