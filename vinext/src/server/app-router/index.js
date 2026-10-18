/**
 * App Router seam for the dev server: runs the rsc environment's fetch
 * handler for requests an app/ route answers. Returning false hands the
 * request to the Pages Router.
 */
import { Readable } from "node:stream";

/** A web Request for a Node IncomingMessage. */
export function toWebRequest(req) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.originalUrl || req.url || "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(":") || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Write a web Response to a Node ServerResponse, streaming its body. */
export async function writeWebResponse(response, res) {
  res.statusCode = response.status;
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const [key, value] of response.headers) {
    if (key === "set-cookie") continue;
    res.setHeader(key, value);
  }
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

export async function handleAppRouterRequest(server, req, res, ctx) {
  const pathname = (req.url || "/").split("?")[0];
  if (pathname.startsWith("/_next/")) return false;
  const rsc = server.environments.rsc;
  const entry = await rsc.runner.import(ctx.rscEntry);
  if (!entry.hasRoute(pathname) && ctx.hasPagesRoute && ctx.hasPagesRoute(pathname.replace(/\.rsc$/, ""))) {
    if (!pathname.endsWith(".rsc")) return false;
    res.statusCode = 200;
    res.setHeader("x-vinext-reload", "1");
    res.end();
    return true;
  }
  const response = await entry.default(toWebRequest(req));
  await writeWebResponse(response, res);
  return true;
}
