/**
 * App Router ssr environment entry: turns an RSC stream into an HTML stream,
 * inlining the RSC payload so the browser hydrates without refetching.
 */
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { AppRoot } from "../../client/app-router.js";
import { injectPayload } from "./inline-payload.js";

/**
 * Render the RSC stream to HTML. Rejects when the shell fails (a server
 * component threw outside any Suspense boundary), with the thrown error,
 * whose `digest` tells notFound()/redirect() apart from failures.
 */
export async function renderHtml(rscStream, { nonce } = {}) {
  const [forSsr, forBrowser] = rscStream.tee();
  let payload;
  function SsrRoot() {
    payload ??= createFromReadableStream(forSsr);
    return createElement(AppRoot, { initialPayload: payload });
  }
  const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent("index");
  const htmlStream = await renderToReadableStream(createElement(SsrRoot), {
    bootstrapScriptContent,
    nonce,
    onError(error) {
      if (error && typeof error === "object" && typeof error.digest === "string") return error.digest;
      console.error(error);
    },
  });
  return injectPayload(htmlStream, forBrowser, { nonce });
}
