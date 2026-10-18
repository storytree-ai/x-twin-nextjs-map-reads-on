/**
 * instrumentation.ts: register() once before requests are answered, and
 * onRequestError() for unhandled errors, as Next.js calls them.
 */
import { parseRscPath } from "../shared/rsc-url.js";

/** `load` imports the instrumentation module (or is null when the app has none). */
export function createInstrumentation(load) {
  let readyPromise = null;
  let mod = null;
  // Errors already reported, per request: one error may fail many requests.
  const reported = new WeakMap();

  function ready() {
    readyPromise ??= (async () => {
      mod = load ? await load() : null;
      if (typeof mod?.register === "function") await mod.register();
    })().catch((err) => console.error("[vinext] instrumentation register() failed:", err));
    return readyPromise;
  }

  /**
   * Tell onRequestError about an error, once per error and request. `route` is the
   * app/ route ({ file, pattern }) or null; `routeType` "route" or "render".
   */
  function report(error, request, route, routeType) {
    const onRequestError = mod?.onRequestError;
    if (typeof onRequestError !== "function") return;
    if (error && typeof error === "object") {
      let seen = reported.get(request);
      if (!seen) reported.set(request, (seen = new WeakSet()));
      if (seen.has(error)) return;
      seen.add(error);
    }
    const url = new URL(request.url);
    const { pathname } = parseRscPath(url.pathname);
    const err = error instanceof Error ? error : new Error(String(error));
    // Next.js's routePath is the app/ file's page: "/blog/[slug]/page", "/api/x/route".
    const routePath = route ? "/" + route.file.replace(/\.[^./]+$/, "") : pathname;
    Promise.resolve()
      .then(() =>
        onRequestError(
          err,
          { path: pathname + url.search, method: request.method, headers: Object.fromEntries(request.headers) },
          { routerKind: "App Router", routePath, routeType },
        ),
      )
      .catch((e) => console.error("[vinext] onRequestError failed:", e));
  }

  return { ready, report };
}
