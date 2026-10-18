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
  let sawBodyEnd = false;
  return htmlStream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        let html = decoder.decode(chunk, { stream: true });
        if (html.endsWith(BODY_END)) {
          html = html.slice(0, -BODY_END.length);
          sawBodyEnd = true;
        }
        controller.enqueue(encoder.encode(html));
        if (pending.length) controller.enqueue(encoder.encode(pending.splice(0).join("")));
      },
      async flush(controller) {
        const rest = decoder.decode();
        if (rest) controller.enqueue(encoder.encode(rest));
        await rscFinished;
        if (pending.length) controller.enqueue(encoder.encode(pending.splice(0).join("")));
        if (sawBodyEnd) controller.enqueue(encoder.encode(BODY_END));
      },
    }),
  );
}
