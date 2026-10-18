/**
 * The control-flow errors next/navigation throws (notFound, redirect,
 * forbidden, unauthorized), recognised by their digest on the server and in
 * the browser. No React import: shared by every environment.
 */

export const HTTP_FALLBACK_PREFIX = "NEXT_HTTP_ERROR_FALLBACK;";
export const REDIRECT_PREFIX = "NEXT_REDIRECT;";

function controlError(message, digest) {
  const error = new Error(message);
  error.digest = digest;
  return error;
}

export function notFound() {
  throw controlError("NEXT_HTTP_ERROR_FALLBACK;404", `${HTTP_FALLBACK_PREFIX}404`);
}

export function forbidden() {
  throw controlError("NEXT_HTTP_ERROR_FALLBACK;403", `${HTTP_FALLBACK_PREFIX}403`);
}

export function unauthorized() {
  throw controlError("NEXT_HTTP_ERROR_FALLBACK;401", `${HTTP_FALLBACK_PREFIX}401`);
}

export const RedirectType = { push: "push", replace: "replace" };

// The request context's store, found without importing node:async_hooks (this
// module is shared with the browser): redirect() in a server action pushes.
const REQUEST_CONTEXT = Symbol.for("vinext.requestContext");

export function redirect(url, type, status = 307) {
  type ??= globalThis[REQUEST_CONTEXT]?.getStore()?.phase === "action" ? RedirectType.push : RedirectType.replace;
  throw controlError("NEXT_REDIRECT", `${REDIRECT_PREFIX}${type};${url};${status};`);
}

export function permanentRedirect(url, type) {
  redirect(url, type, 308);
}

/** The HTTP status of a notFound/forbidden/unauthorized error, or null. */
export function httpFallbackStatus(error) {
  const digest = error && typeof error === "object" ? error.digest : undefined;
  if (typeof digest !== "string" || !digest.startsWith(HTTP_FALLBACK_PREFIX)) return null;
  const status = Number(digest.slice(HTTP_FALLBACK_PREFIX.length));
  return status === 404 || status === 403 || status === 401 ? status : null;
}

/** { url, type, status } of a redirect error, or null. */
export function redirectInfo(error) {
  const digest = error && typeof error === "object" ? error.digest : undefined;
  if (typeof digest !== "string" || !digest.startsWith(REDIRECT_PREFIX)) return null;
  const [, type, ...rest] = digest.split(";");
  const status = Number(rest[rest.length - 2]);
  const url = rest.slice(0, -2).join(";");
  return { url, type, status: status || 307 };
}

/** True for errors that are navigation control flow, not failures. */
export function isNavigationError(error) {
  return httpFallbackStatus(error) !== null || redirectInfo(error) !== null;
}

/** Rethrow control-flow errors caught by user code (next/navigation's unstable_rethrow). */
export function unstable_rethrow(error) {
  if (isNavigationError(error)) throw error;
}
