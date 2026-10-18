import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextShimAliases } from "./shims-map.js";
import { transformCjs } from "./cjs.js";
import { findNextConfig, loadNextConfig } from "./next-config.js";
import { fileToPattern } from "../routing/pages-routes.js";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHIMS_DIR = path.join(distDir, "shims");
export const CLIENT_ENTRY = path.join(distDir, "client", "pages-entry.js");
export const PAGES_SERVER_ENTRY = path.join(distDir, "server", "pages-server.js");
const ERROR_PAGE = path.join(distDir, "shared", "error-page.js");

const MANIFEST_ID = "virtual:vinext-pages-manifest";
const RESOLVED_MANIFEST_ID = "\0" + MANIFEST_ID;
const PAGE_FILE_RE = /\.(tsx|ts|jsx|js|mjs|mts)$/;
const APP_CODE_RE = /\.(m?[jt]sx?)$/;

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (PAGE_FILE_RE.test(entry.name) && !/\.d\.[mc]?ts$/.test(entry.name)) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

function findPagesDir(root) {
  for (const dir of ["pages", "src/pages"]) {
    const full = path.join(root, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full;
  }
  return null;
}

function findAppDir(root) {
  for (const dir of ["app", "src/app"]) {
    const full = path.join(root, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full;
  }
  return null;
}

function findSpecial(pagesDir, files, name) {
  const file = files.find((f) => f.replace(PAGE_FILE_RE, "") === name);
  return file ? path.join(pagesDir, file) : null;
}

/** Module source listing the pages, with lazy loaders, for one environment. */
export function generatePagesManifest(pagesDir, files, { server }) {
  const routeFiles = files.filter((f) => {
    const pattern = fileToPattern(f);
    return pattern !== null && (server || !(pattern === "/api" || pattern.startsWith("/api/")));
  });
  const imp = (file) => `() => import(${JSON.stringify(file)})`;
  const app = findSpecial(pagesDir, files, "_app");
  const doc = server ? findSpecial(pagesDir, files, "_document") : null;
  const notFound = findSpecial(pagesDir, files, "404");
  const lines = [
    `export const routeFiles = ${JSON.stringify(routeFiles)};`,
    `export const loaders = {`,
    ...routeFiles.map((f) => `  ${JSON.stringify(f)}: ${imp(path.join(pagesDir, f))},`),
    `};`,
    `export const loadApp = ${app ? imp(app) : "null"};`,
    `export const loadDocument = ${doc ? imp(doc) : "null"};`,
    `export const load404 = ${imp(notFound || ERROR_PAGE)};`,
    `export const has404 = ${notFound ? "true" : "false"};`,
  ];
  return lines.join("\n");
}

function envDefines(nextConfig) {
  const define = {};
  for (const [key, value] of Object.entries(nextConfig.env || {})) {
    define[`process.env.${key}`] = JSON.stringify(String(value));
  }
  return define;
}

/**
 * The vinext Vite plugin: next/* shims, the Pages Router dev server and
 * build, and CommonJS interop for app code.
 */
export default function vinext(options = {}) {
  let root = process.cwd();
  let pagesDir = null;
  let appDir = null;
  let nextConfig = {};

  const plugin = {
    name: "vinext",
    enforce: "pre",

    async config(userConfig, env) {
      root = path.resolve(options.root || userConfig.root || process.cwd());
      pagesDir = findPagesDir(root);
      appDir = options.appDir === false ? null : findAppDir(options.appDir ? path.resolve(options.appDir) : root);
      try {
        nextConfig = await loadNextConfig(root, env.command === "build" ? "phase-production-build" : "phase-development-server");
      } catch (err) {
        console.warn(`[vinext] failed to load ${findNextConfig(root)}: ${err?.message || err}`);
        nextConfig = {};
      }
      const build =
        env.command === "build"
          ? {
              builder: {
                async buildApp(builder) {
                  await builder.build(builder.environments.client);
                  await builder.build(builder.environments.ssr);
                },
              },
              environments: {
                client: {
                  build: {
                    outDir: path.join(root, "dist", "client"),
                    manifest: true,
                    rollupOptions: { input: { "vinext-client": CLIENT_ENTRY } },
                  },
                },
                ssr: {
                  build: {
                    outDir: path.join(root, "dist", "server"),
                    rollupOptions: { input: { index: PAGES_SERVER_ENTRY } },
                  },
                },
              },
            }
          : {};
      return {
        appType: "custom",
        resolve: {
          alias: nextShimAliases(SHIMS_DIR),
          dedupe: ["react", "react-dom"],
        },
        define: envDefines(nextConfig),
        optimizeDeps: {
          include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"],
          exclude: ["vinext", "next"],
          entries: pagesDir
            ? [path.relative(root, pagesDir).split(path.sep).join("/") + "/**/*.{js,jsx,ts,tsx,mjs}", "!**/api/**"]
            : [],
        },
        ssr: { noExternal: ["vinext"] },
        ...build,
      };
    },

    resolveId(id) {
      if (id === MANIFEST_ID) return RESOLVED_MANIFEST_ID;
      return null;
    },

    load(id) {
      if (id === RESOLVED_MANIFEST_ID) {
        const server = this.environment?.config?.consumer === "server";
        const files = pagesDir ? walk(pagesDir) : [];
        return generatePagesManifest(pagesDir || root, files, { server });
      }
      return null;
    },

    transform(code, id) {
      if (id.includes("/node_modules/") || id.startsWith("\0")) return null;
      const file = id.split("?")[0];
      if (!APP_CODE_RE.test(file) || !file.startsWith(root)) return null;
      const out = transformCjs(code);
      return out === null ? null : { code: out, map: null };
    },

    configureServer(server) {
      const invalidateManifest = (file) => {
        if (!pagesDir || !file.startsWith(pagesDir + path.sep)) return;
        for (const environment of Object.values(server.environments)) {
          const mod = environment.moduleGraph.getModuleById(RESOLVED_MANIFEST_ID);
          if (mod) environment.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", invalidateManifest);
      server.watcher.on("unlink", invalidateManifest);

      server.middlewares.use(async (req, res, next) => {
        if (!isPageRequest(req, root)) return next();
        try {
          if (appDir) {
            const { handleAppRouterRequest } = await import("../server/app-router/index.js");
            if (await handleAppRouterRequest(server, req, res, { appDir, root })) return;
          }
          const mod = await server.ssrLoadModule(PAGES_SERVER_ENTRY);
          await mod.handlePagesRequest(req, res, {
            dev: true,
            buildId: "development",
            clientEntryUrl: clientEntryUrl(root),
            transformHtml: (url, html) => server.transformIndexHtml(url, html),
          });
        } catch (err) {
          if (err instanceof Error) server.ssrFixStacktrace(err);
          console.error(err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
          }
          if (!res.writableEnded) res.end(`Internal Server Error\n\n${err?.stack || err}`);
        }
      });
    },
  };
  return plugin;
}

/** The browser URL of the client entry during dev. */
function clientEntryUrl(root) {
  const rel = path.relative(root, CLIENT_ENTRY).split(path.sep).join("/");
  return rel.startsWith("..") ? `/@fs${CLIENT_ENTRY}` : `/${rel}`;
}

/**
 * Requests the framework renders, as opposed to Vite's modules and assets:
 * a path with a dot in its last segment is a page unless a file (in the root
 * or public/) answers to it.
 */
export function isPageRequest(req, root = process.cwd()) {
  const url = req.url || "/";
  const pathname = url.split("?")[0];
  if (pathname.startsWith("/_next/data/")) return true;
  if (pathname.startsWith("/@") || pathname.startsWith("/__vite") || pathname.startsWith("/node_modules/")) return false;
  if (/[?&](import|raw|url|worker|inline|html-proxy|direct)\b/.test(url)) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!last.includes(".")) return true;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}
  return ![root, path.join(root, "public")].some((dir) => fs.existsSync(path.join(dir, decoded)));
}
