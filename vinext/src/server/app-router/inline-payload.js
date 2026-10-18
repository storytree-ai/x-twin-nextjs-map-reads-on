/**
 * Inline an RSC stream into an HTML stream as scripts that push its chunks
 * onto `self.__VINEXT_RSC__`, keeping `</body></html>` last, so the browser
 * hydrates without fetching the payload again.
 */

const BODY_END = "</body></html>";

function escapeScript(json) {
  return json.replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function payloadScript(chunk, nonce) {
  const attr = nonce ? ` nonce="${nonce}"` : "";
  return `<script${attr}>(self.__VINEXT_RSC__||=[]).push(${escapeScript(JSON.stringify(chunk))})</script>`;
}

export function injectPayload(htmlStream, rscStream, { nonce } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = [];
  const rscFinished = (async () => {
    const reader = rscStream.getReader();
    const rscDecoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(payloadScript(rscDecoder.decode(value, { stream: true }), nonce));
    }
    const tail = rscDecoder.decode();
    if (tail) pending.push(payloadScript(tail, nonce));
  })();
  // React writes one flush as several chunks in the same task, splitting long
  // scripts between them, so HTML is held until the task ends and payload
  // scripts go only between flushes.
  let html = "";
  let scheduled = null;
  let sawBodyEnd = false;
  const emit = (controller) => {
    scheduled = null;
    if (html.endsWith(BODY_END)) {
      html = html.slice(0, -BODY_END.length);
      sawBodyEnd = true;
    }
    if (html) controller.enqueue(encoder.encode(html));
    html = "";
    if (pending.length) controller.enqueue(encoder.encode(pending.splice(0).join("")));
  };
  return htmlStream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        html += decoder.decode(chunk, { stream: true });
        scheduled ??= new Promise((resolve) => setTimeout(resolve, 0)).then(() => emit(controller));
      },
      async flush(controller) {
        await scheduled;
        html += decoder.decode();
        emit(controller);
        await rscFinished;
        emit(controller);
        if (sawBodyEnd) controller.enqueue(encoder.encode(BODY_END));
      },
    }),
  );
}
