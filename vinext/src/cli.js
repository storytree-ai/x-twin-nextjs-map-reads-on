#!/usr/bin/env node
/**
 * vinext CLI: `vinext dev [-p port]`, `vinext build`, `vinext start [-p port]`.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createStaticFileServer } from "./server/static-files.js";

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

export function parseArgs(argv) {
  const [command = "dev", ...rest] = argv;
  const opts = { command, port: undefined, hostname: undefined };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-p" || arg === "--port") opts.port = Number(rest[++i]);
    else if (arg.startsWith("--port=")) opts.port = Number(arg.slice(7));
    else if (arg === "-H" || arg === "--hostname") opts.hostname = rest[++i];
    else if (arg.startsWith("--hostname=")) opts.hostname = arg.slice(11);
  }
  if (!opts.port && process.env.PORT) opts.port = Number(process.env.PORT);
  return opts;
}

async function viteInlineConfig(root) {
  const configFile = VITE_CONFIGS.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (configFile) return { root, configFile };
  const { default: vinext } = await import("./index.js");
  return { root, configFile: false, plugins: [vinext()] };
}

async function dev(opts) {
  const { createServer } = await import("vite");
  const root = process.cwd();
  const server = await createServer({
    ...(await viteInlineConfig(root)),
    server: { port: opts.port || 3000, strictPort: true, host: opts.hostname },
  });
  await server.listen();
  server.printUrls();
}

async function build() {
  const { createBuilder } = await import("vite");
  const root = process.cwd();
  const builder = await createBuilder({ ...(await viteInlineConfig(root)), mode: "production" });
  await builder.buildApp();
}

/**
 * Vite's own build output (hashed chunks and its manifest), the counterpart
 * of Next.js's /_next/static: served before the request pipeline. Other
 * client build files are public/ copies, served once the pipeline routes there.
 */
export function isBuiltAsset(pathname) {
  return pathname.startsWith("/assets/") || pathname.startsWith("/.vite/");
}

/** A request for a built asset, answered from the client build; false otherwise. */
function serveBuiltAsset(serveFile, req, res) {
  const pathname = (req.url || "/").split("?")[0];
  return isBuiltAsset(pathname) && serveFile(pathname, req, res);
}

/** The built Pages Router server and its client entry URL, or null. */
async function loadPagesServer(root) {
  const serverEntry = path.join(root, "dist", "server", "index.js");
  const manifestFile = path.join(root, "dist", "client", ".vite", "manifest.json");
  if (!fs.existsSync(serverEntry) || !fs.existsSync(manifestFile)) return null;
  const viteManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const entry = Object.values(viteManifest).find((c) => c.isEntry && c.name === "vinext-client");
  if (!entry) return null;
  const mod = await import(pathToFileURL(serverEntry).href);
  return { ...mod, clientEntryUrl: "/" + entry.file };
}

async function startApp(opts, root, rscEntry) {
  const { handleAppRouterRequest } = await import("./server/app-router/index.js");
  const rsc = await import(pathToFileURL(rscEntry).href);
  const pages = await loadPagesServer(root);
  await rsc.instrumentationReady();
  const serveFile = createStaticFileServer([path.join(root, "dist", "client"), path.join(root, "public")].filter((d) => fs.existsSync(d)));
  const server = http.createServer(async (req, res) => {
    if (serveBuiltAsset(serveFile, req, res)) return;
    try {
      const handlePages = (request, response, routed) =>
        pages.handlePagesRequest(request, response, { dev: false, buildId: "production", clientEntryUrl: pages.clientEntryUrl, routed, serveFile });
      if (pages && (req.url || "/").startsWith("/_next/data/")) {
        await handlePages(req, res);
        return;
      }
      await handleAppRouterRequest(req, res, { entry: rsc, pagesRouteKind: pages ? pages.pagesRouteKind : undefined, handlePages, serveFile });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end("Internal Server Error");
    }
  });
  const port = opts.port || 3000;
  server.listen(port, opts.hostname, () => console.log(`vinext ready on http://localhost:${port}`));
}

async function start(opts) {
  process.env.NODE_ENV = "production";
  const root = process.cwd();
  const rscEntry = path.join(root, "dist", "rsc", "index.js");
  if (fs.existsSync(rscEntry)) return startApp(opts, root, rscEntry);
  const clientDir = path.join(root, "dist", "client");
  const serverEntry = path.join(root, "dist", "server", "index.js");
  if (!fs.existsSync(serverEntry)) {
    console.error("vinext start: no build found. Run `vinext build` first.");
    process.exit(1);
  }
  const viteManifest = JSON.parse(fs.readFileSync(path.join(clientDir, ".vite", "manifest.json"), "utf8"));
  const entry = Object.values(viteManifest).find((c) => c.isEntry && c.name === "vinext-client");
  const clientEntryUrl = "/" + entry.file;
  const { handlePagesRequest } = await import(pathToFileURL(serverEntry).href);
  const serveFile = createStaticFileServer([clientDir, path.join(root, "public")].filter((d) => fs.existsSync(d)));
  const server = http.createServer(async (req, res) => {
    if (serveBuiltAsset(serveFile, req, res)) return;
    try {
      await handlePagesRequest(req, res, { dev: false, buildId: "production", clientEntryUrl, serveFile });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end("Internal Server Error");
    }
  });
  const port = opts.port || 3000;
  server.listen(port, opts.hostname, () => console.log(`vinext ready on http://localhost:${port}`));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "dev") return dev(opts);
  if (opts.command === "build") return build(opts);
  if (opts.command === "start") return start(opts);
  console.error(`Unknown command: ${opts.command}\nUsage: vinext <dev|build|start> [-p port]`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
