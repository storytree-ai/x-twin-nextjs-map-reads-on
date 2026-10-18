/** pages/api/* handlers with Next.js's req/res helpers. */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function parseSize(limit) {
  if (typeof limit === "number") return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(limit || "1mb"));
  if (!m) return 1024 * 1024;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || "b").toLowerCase()];
  return Math.floor(Number(m[1]) * mult);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error("Body exceeded size limit");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseBody(req, limit) {
  const raw = (await readBody(req, limit)).toString("utf8");
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error("Invalid JSON");
      err.statusCode = 400;
      throw err;
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

function enhanceResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  };
  res.send = (body) => {
    if (body === null || body === undefined) return res.end();
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", body.length);
      return res.end(body);
    }
    if (typeof body === "object") return res.json(body);
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(String(body));
  };
  res.redirect = (statusOrUrl, maybeUrl) => {
    const [status, url] = typeof statusOrUrl === "string" ? [307, statusOrUrl] : [statusOrUrl, maybeUrl];
    res.statusCode = status;
    res.setHeader("Location", url);
    res.end(url);
    return res;
  };
  return res;
}

export async function handleApiRoute(mod, req, res, query) {
  const handler = mod.default;
  enhanceResponse(res);
  if (typeof handler !== "function") {
    res.statusCode = 500;
    res.end("API route has no default export function");
    return;
  }
  const apiConfig = mod.config?.api || {};
  req.query = query;
  req.cookies = parseCookies(req.headers.cookie);
  try {
    const method = (req.method || "GET").toUpperCase();
    if (apiConfig.bodyParser !== false && method !== "GET" && method !== "HEAD") {
      req.body = await parseBody(req, parseSize(apiConfig.bodyParser?.sizeLimit));
    }
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = err.statusCode || 500;
      res.end(err.statusCode ? err.message : "Internal Server Error");
    } else if (!res.writableEnded) {
      res.end();
    }
    if (!err.statusCode) console.error(err);
  }
}
