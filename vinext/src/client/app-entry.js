/**
 * App Router browser entry: hydrates the document from the RSC payload the
 * server inlined in the HTML, then navigates by fetching RSC payloads.
 */
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { createFromReadableStream, createFromFetch } from "@vitejs/plugin-rsc/browser";
import { AppRoot, router } from "./app-router.js";

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

const initialPayload = createFromReadableStream(inlinePayloadStream());
hydrateRoot(document, createElement(AppRoot, { initialPayload, fetchPayload }));

// Server component edits: refetch the current payload.
if (import.meta.hot) import.meta.hot.on("rsc:update", () => router.refresh());
