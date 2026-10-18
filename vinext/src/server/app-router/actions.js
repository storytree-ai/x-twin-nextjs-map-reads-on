/**
 * Server actions in the rsc environment: a POST to a page runs a 'use server'
 * function, in the request context's "action" phase (cookies writable), before
 * the page answers. A client call (callServer) names the action in the
 * x-rsc-action header and encodes its arguments in the body; a form posted
 * without JavaScript carries the action's reference in its fields.
 * `rsc` is @vitejs/plugin-rsc/rsc's decoders.
 */
import { redirectInfo } from "../../shims/internal/navigation-errors.js";

const ACTION_HEADER = "x-rsc-action";

/** "fetch" for a client action call, "form" for a form post that may name one, else null. */
export function actionRequestKind(request) {
  if (request.method !== "POST") return null;
  if (request.headers.has(ACTION_HEADER)) return "fetch";
  const type = request.headers.get("content-type") || "";
  if (type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")) return "form";
  return null;
}

/**
 * Run the request's action. Resolves to { kind } with, for a client call,
 * `returnValue` ({ ok, data }) and `temporaryReferences`, or `notFound` for an
 * unknown action; for a form post, `formState` for useActionState. `redirect`
 * ({ url, type, status }) when the action called redirect().
 */
export async function runServerAction(ctx, rsc) {
  const { request } = ctx;
  const kind = actionRequestKind(request);
  if (kind === "fetch") {
    const id = request.headers.get(ACTION_HEADER);
    const type = request.headers.get("content-type") || "";
    const body = type.startsWith("multipart/form-data") ? await request.formData() : await request.text();
    const temporaryReferences = rsc.createTemporaryReferenceSet();
    let action;
    try {
      action = await rsc.loadServerAction(id);
    } catch {
      return { kind, notFound: true };
    }
    const args = await rsc.decodeReply(body, { temporaryReferences });
    try {
      return { kind, temporaryReferences, returnValue: { ok: true, data: await action.apply(null, args) } };
    } catch (error) {
      const redirect = redirectInfo(error);
      if (redirect) return { kind, temporaryReferences, redirect };
      return { kind, temporaryReferences, returnValue: { ok: false, data: error } };
    }
  }
  const formData = await request.formData();
  const action = await rsc.decodeAction(formData);
  if (!action) return { kind };
  try {
    const result = await action();
    return { kind, formState: await rsc.decodeFormState(result, formData) };
  } catch (error) {
    const redirect = redirectInfo(error);
    if (redirect) return { kind, redirect };
    throw error;
  }
}

/**
 * Leave the action phase for the page's re-render: cookies become read-only
 * again (with the action's writes visible). True when the action changed what
 * the page shows (revalidatePath/revalidateTag or a cookie write), so a client
 * call's response carries the re-rendered page.
 */
export function endActionPhase(ctx) {
  ctx.phase = "render";
  ctx.cookieStore = undefined;
  return Boolean(ctx.revalidated) || ctx.setCookieHeaders.getSetCookie().length > 0;
}
