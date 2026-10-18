/**
 * next/cache: revalidatePath()/revalidateTag() and friends. vinext renders
 * App Router pages on each request, so revalidating marks the request: a
 * server action that revalidates answers with the page re-rendered.
 */
import { getRequestContext, markDynamic } from "./internal/request-context.js";

function markRevalidated() {
  const ctx = getRequestContext();
  if (ctx) ctx.revalidated = true;
}

export function revalidatePath(_path, _type) {
  markRevalidated();
}

export function revalidateTag(_tag, _profile) {
  markRevalidated();
}

export function updateTag(_tag) {
  markRevalidated();
}

/** Refresh the client router after the current server action. */
export function refresh() {
  markRevalidated();
}

export function unstable_noStore() {
  markDynamic();
}

export { unstable_noStore as noStore };
