/**
 * Files served as they are: public/ (and, under `vinext start`, the client
 * build). The request pipeline decides whether a request reaches one.
 */
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The file under `dirs` a GET or HEAD for the (encoded) `pathname` names, or null. */
export function findStaticFile(dirs, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(dir, decoded);
    if (!file.startsWith(dir + path.sep)) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/**
 * `serveFile(pathname, req, res, status)`: answer with the file `pathname`
 * names under `dirs` (with `status`, a middleware rewrite's, or 200) and
 * return true, or return false when there is none or the method is not GET/HEAD.
 */
export function createStaticFileServer(dirs) {
  return (pathname, req, res, status) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const file = findStaticFile(dirs, pathname);
    if (!file) return false;
    res.statusCode = status || 200;
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  };
}
