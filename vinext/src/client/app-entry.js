/**
 * App Router browser entry: hydrates the document from the RSC payload the
 * server inlined in the HTML, navigates by fetching RSC payloads, and calls
 * server actions by POSTing to the current page.
 */
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  createFromReadableStream,
  createFromFetch,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import { AppRoot, router, navigate, commitPayload } from "./app-router.js";
import { rscUrl } from "../shared/rsc-url.js";

function inlinePayloadStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const queue = (self.__VINEXT_RSC__ ||= []);
      for (const chunk of queue) controller.enqueue(encoder.encode(chunk));
      queue.length = 0;
      queue.push = (chunk) => {
        controller.enqueue(encoder.encode(chunk));
        return 0;
      };
      const close = () => controller.close();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", close, { once: true });
      else close();
    },
  });
}

async function fetchPayload(url) {
  const response = await fetch(url, { headers: { Accept: "text/x-component" } });
  const redirect = response.headers.get("x-vinext-redirect");
  if (redirect) return { redirect };
  if (response.headers.get("x-vinext-reload") || !(response.headers.get("content-type") || "").includes("text/x-component")) {
    return { reload: true };
  }
  return { payload: await createFromFetch(Promise.resolve(response)) };
}

/**
 * React's callServer: run server action `id` with `args`. The response's
 * re-rendered page (after revalidatePath or a cookie write) is committed; a
 * redirect() navigates, the call settling once the target is committed.
 */
async function callServer(id, args) {
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await encodeReply(args, { temporaryReferences });
  const response = await fetch(rscUrl(window.location.href), {
    method: "POST",
    headers: { Accept: "text/x-component", "x-rsc-action": id },
    body,
  });
  const redirect = response.headers.get("x-vinext-redirect");
  if (redirect) {
    const mode = response.headers.get("x-vinext-redirect-type") === "replace" ? "replace" : "push";
    await navigate(redirect, { mode });
    return undefined;
  }
  if (!(response.headers.get("content-type") || "").includes("text/x-component")) {
    throw new Error(`Server action failed (${response.status}): ${await response.text()}`);
  }
  const payload = await createFromFetch(Promise.resolve(response), { temporaryReferences });
  if (payload.tree) commitPayload(payload);
  if (!payload.returnValue.ok) throw payload.returnValue.data;
  return payload.returnValue.data;
}

setServerCallback(callServer);

const initialPayload = createFromReadableStream(inlinePayloadStream());
// After a form post, useActionState hydrates with the action's form state.
initialPayload.then((payload) => {
  hydrateRoot(document, createElement(AppRoot, { initialPayload, fetchPayload }), { formState: payload.formState ?? null });
});

// Server component edits: refetch the current payload.
if (import.meta.hot) import.meta.hot.on("rsc:update", () => router.refresh());
