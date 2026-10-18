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

// Generated params by the last module (the page), with the modules they came from.
const generatedCache = new WeakMap();

/** Every params set generateStaticParams makes over `mods`, each run once per parent params set. */
async function generatedParams(mods) {
  let parents = [{}];
  for (const mod of mods) {
    if (typeof mod?.generateStaticParams !== "function") continue;
    const next = [];
    for (const parent of parents) {
      const list = (await mod.generateStaticParams({ params: parent })) || [];
      for (const entry of list) next.push({ ...parent, ...entry });
    }
    parents = next;
  }
  return parents;
}

const sameParam = (a, b) =>
  Array.isArray(a) || Array.isArray(b) ? [].concat(a ?? []).map(String).join("/") === [].concat(b ?? []).map(String).join("/") : a !== undefined && String(a) === String(b);

/**
 * Whether `params` may render, given modules ordered root layout first,
 * page last: with dynamicParams = false (on any of them), only params
 * generateStaticParams returns do, every param among them. Generated params
 * are kept for the same modules, as Next.js generates them once at build.
 */
export async function staticParamsAllow(mods, params) {
  if (resolveSegmentConfig(mods).dynamicParams !== false) return true;
  const key = mods[mods.length - 1];
  let cached = key && typeof key === "object" ? generatedCache.get(key) : undefined;
  if (!cached || cached.mods.length !== mods.length || cached.mods.some((m, i) => m !== mods[i])) {
    cached = { mods, list: generatedParams(mods) };
    if (key && typeof key === "object") generatedCache.set(key, cached);
  }
  let list;
  try {
    list = await cached.list;
  } catch (error) {
    if (key && typeof key === "object" && generatedCache.get(key) === cached) generatedCache.delete(key);
    throw error;
  }
  return list.some((entry) => {
    const keys = new Set([...Object.keys(entry), ...Object.keys(params)]);
    return [...keys].every((k) => sameParam(entry[k], params[k]));
  });
}
