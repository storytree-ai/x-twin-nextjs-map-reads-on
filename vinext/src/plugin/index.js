import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextShimAliases, NEXT_SHIMS, REACT_SERVER_SHIMS } from "./shims-map.js";
import { transformCjs } from "./cjs.js";
import { findNextConfig, loadNextConfig } from "./next-config.js";
import { fileToPattern, buildPagesRoutes, matchPagesRoute } from "../routing/pages-routes.js";
import { buildAppRoutes, isAppFile, metadataFileOf } from "../routing/app-routes.js";
import { staticFileInfo } from "../server/app-router/metadata-routes.js";
import { normalizeRewrites } from "../server/request-pipeline.js";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHIMS_DIR = path.join(distDir, "shims");
export const CLIENT_ENTRY = path.join(distDir, "client", "pages-entry.js");
export const PAGES_SERVER_ENTRY = path.join(distDir, "server", "pages-server.js");
const ERROR_PAGE = path.join(distDir, "shared", "error-page.js");
export const APP_RSC_ENTRY = path.join(distDir, "server", "app-router", "rsc-entry.js");
export const APP_SSR_ENTRY = path.join(distDir, "server", "app-router", "ssr-entry.js");
export const APP_CLIENT_ENTRY = path.join(distDir, "client", "app-entry.js");

const PAGES_ENV = "vinext_pages";
const APP_MANIFEST_ID = "virtual:vinext-app-manifest";
const RESOLVED_APP_MANIFEST_ID = "\0" + APP_MANIFEST_ID;
// A static metadata file (icon.png, robots.txt, ...) as { data: base64, info }.
const METADATA_FILE_PREFIX = "virtual:vinext-metadata-file:";
const RESOLVED_METADATA_FILE_PREFIX = "\0vinext-metadata-file:";
const REACT_SERVER_REDIRECTS = new Map(
  Object.entries(REACT_SERVER_SHIMS).map(([id, file]) => [path.join(SHIMS_DIR, NEXT_SHIMS[id]), path.join(SHIMS_DIR, file)]),
);

const MANIFEST_ID = "virtual:vinext-pages-manifest";
const RESOLVED_MANIFEST_ID = "\0" + MANIFEST_ID;
const SERVER_CONFIG_ID = "virtual:vinext-server-config";
const RESOLVED_SERVER_CONFIG_ID = "\0" + SERVER_CONFIG_ID;
const MIDDLEWARE_NAMES = ["middleware", "proxy"];
const PAGE_FILE_RE = /\.(tsx|ts|jsx|js|mjs|mts)$/;
const APP_CODE_RE = /\.(m?[jt]sx?)$/;
// Vite's default CORS origins; preflightContinue lets OPTIONS reach route handlers.
const DEV_CORS = { origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/, preflightContinue: true };

const isPageFile = (rel) => PAGE_FILE_RE.test(rel) && !/\.d\.[mc]?ts$/.test(rel);

/** Files under `dir` (paths relative to it) that `include` takes. */
function walk(dir, include = isPageFile, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) walk(full, include, base, out);
    else if (include(rel)) out.push(rel);
  }
  return out.sort();
}

/** The module source of a static metadata file: its bytes, type, size and hash (and alt text). */
export function metadataFileModule(file) {
  const bytes = fs.readFileSync(file);
  const info = staticFileInfo(file, bytes);
  const altFile = file.replace(/\.[^./]+$/, ".alt.txt");
  if (/(opengraph|twitter)-image\d*\.[^./]+$/.test(file) && fs.existsSync(altFile)) info.alt = fs.readFileSync(altFile, "utf8").trim();
  return `export const data = ${JSON.stringify(bytes.toString("base64"))};\nexport const info = ${JSON.stringify(info)};`;
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

/** middleware.* (or Next 16's proxy.*) in the root or src/, or null. */
export function findMiddleware(root) {
  return findRootModule(root, MIDDLEWARE_NAMES);
}

/** The first of `names` (with a code extension) in the root or src/, or null. */
function findRootModule(root, names) {
  for (const dir of [root, path.join(root, "src")]) {
    for (const name of names) {
      for (const ext of ["ts", "js", "mts", "mjs", "tsx", "jsx"]) {
        const file = path.join(dir, `${name}.${ext}`);
        if (fs.existsSync(file)) return file;
      }
    }
  }
  return null;
}

/**
 * The parts of next.config the request pipeline and next/config read, with
 * redirects()/rewrites()/headers() resolved.
 */
export async function resolveServerConfig(nextConfig) {
  const call = async (fn) => (typeof fn === "function" ? await fn() : undefined);
  return {
    trailingSlash: Boolean(nextConfig.trailingSlash),
    redirects: (await call(nextConfig.redirects)) || [],
    rewrites: normalizeRewrites(await call(nextConfig.rewrites)),
    headers: (await call(nextConfig.headers)) || [],
    publicRuntimeConfig: nextConfig.publicRuntimeConfig || {},
    serverRuntimeConfig: nextConfig.serverRuntimeConfig || {},
  };
}

/** Module source listing the pages, with lazy loaders, for one environment. */
export function generatePagesManifest(pagesDir, files, { server, middleware = null }) {
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
    `export const loadMiddleware = ${server && middleware ? imp(middleware) : "null"};`,
  ];
  return lines.join("\n");
}

/**
 * Module source for the rsc environment: the app/ route table, a lazy loader
 * per file it names, and loaders for middleware and instrumentation (or null).
 */
export function generateAppManifest(appDir, files, { middleware = null, instrumentation = null } = {}) {
  const { routes, root, intercepts } = buildAppRoutes(files);
  const used = new Set();
  const collect = (level) => {
    for (const key of ["layout", "template", "error", "loading", "notFound", "forbidden", "unauthorized", "globalError"]) {
      if (level[key]) used.add(level[key]);
    }
    for (const slot of Object.values(level.slots || {})) {
      slot.pages.forEach(collectSubtree);
      if (slot.default) collectSubtree(slot.default);
    }
  };
  const collectSubtree = ({ file, levels }) => {
    used.add(file);
    levels.forEach(collect);
  };
  collect(root);
  for (const route of routes) {
    collectSubtree(route);
    for (const level of route.levels) for (const entry of level.metadataFiles) used.add(entry.file);
  }
  intercepts.forEach(collectSubtree);
  const loader = (f) => {
    const full = path.join(appDir, f);
    return metadataFileOf(f)?.isStatic ? METADATA_FILE_PREFIX + full : full;
  };
  return [
    `export const routes = ${JSON.stringify(routes)};`,
    `export const root = ${JSON.stringify(root)};`,
    `export const intercepts = ${JSON.stringify(intercepts)};`,
    `export const loaders = {`,
    ...[...used].sort().map((f) => `  ${JSON.stringify(f)}: () => import(${JSON.stringify(loader(f))}),`),
    `};`,
    `export const loadMiddleware = ${middleware ? `() => import(${JSON.stringify(middleware)})` : "null"};`,
    `export const loadInstrumentation = ${instrumentation ? `() => import(${JSON.stringify(instrumentation)})` : "null"};`,
  ].join("\n");
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
  let serverConfig = null;
  let pagesRoutes = null;
  // The App Router needs @vitejs/plugin-rsc, so app/ is looked for up front.
  const initialRoot = path.resolve(options.root || process.cwd());
  const usesAppRouter =
    options.appDir !== false && findAppDir(options.appDir ? path.resolve(options.appDir) : initialRoot) !== null;

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
      try {
        serverConfig = await resolveServerConfig(nextConfig);
      } catch (err) {
        console.warn(`[vinext] next.config redirects/rewrites/headers failed: ${err?.message || err}`);
        serverConfig = await resolveServerConfig({});
      }
      const build =
        env.command === "build" && !appDir
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
          : env.command === "build" && pagesDir
            ? {
                // App Router build (@vitejs/plugin-rsc) plus the Pages Router: its
                // client entry joins the client build, its server gets an environment.
                environments: {
                  client: {
                    build: { manifest: true, rollupOptions: { input: { "vinext-client": CLIENT_ENTRY } } },
                  },
                  [PAGES_ENV]: {
                    consumer: "server",
                    resolve: { noExternal: ["vinext"] },
                    build: {
                      outDir: path.join(root, "dist", "server"),
                      copyPublicDir: false,
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
          tsconfigPaths: true,
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
        ...(userConfig.server?.cors === undefined ? { server: { cors: DEV_CORS } } : {}),
        ...build,
      };
    },

    buildApp: {
      order: "post",
      async handler(builder) {
        if (appDir && pagesDir && builder.environments[PAGES_ENV]) await builder.build(builder.environments[PAGES_ENV]);
      },
    },

    resolveId(id) {
      if (id === MANIFEST_ID) return RESOLVED_MANIFEST_ID;
      if (id === SERVER_CONFIG_ID) return RESOLVED_SERVER_CONFIG_ID;
      if (id === APP_MANIFEST_ID) return RESOLVED_APP_MANIFEST_ID;
      if (id.startsWith(METADATA_FILE_PREFIX)) return RESOLVED_METADATA_FILE_PREFIX + id.slice(METADATA_FILE_PREFIX.length);
      if (this.environment?.name === "rsc" && REACT_SERVER_REDIRECTS.has(id)) return REACT_SERVER_REDIRECTS.get(id);
      return null;
    },

    load(id) {
      if (id === RESOLVED_MANIFEST_ID) {
        const server = this.environment?.config?.consumer === "server";
        const files = pagesDir ? walk(pagesDir) : [];
        return generatePagesManifest(pagesDir || root, files, { server, middleware: findMiddleware(root) });
      }
      if (id === RESOLVED_SERVER_CONFIG_ID) {
        return `export default ${JSON.stringify(serverConfig || {})};`;
      }
      if (id === RESOLVED_APP_MANIFEST_ID) {
        return generateAppManifest(appDir, appDir ? walk(appDir, isAppFile) : [], {
          middleware: findMiddleware(root),
          instrumentation: findRootModule(root, ["instrumentation"]),
        });
      }
      if (id.startsWith(RESOLVED_METADATA_FILE_PREFIX)) {
        const file = id.slice(RESOLVED_METADATA_FILE_PREFIX.length);
        this.addWatchFile(file);
        return metadataFileModule(file);
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
        const inPages = pagesDir && file.startsWith(pagesDir + path.sep);
        const inApp = appDir && file.startsWith(appDir + path.sep);
        if (!inPages && !inApp) return;
        if (inPages) pagesRoutes = null;
        for (const environment of Object.values(server.environments)) {
          const mod = environment.moduleGraph.getModuleById(inPages ? RESOLVED_MANIFEST_ID : RESOLVED_APP_MANIFEST_ID);
          if (mod) environment.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      };
      const pagesRouteKind = (pathname) => {
        if (!pagesDir) return null;
        pagesRoutes ??= buildPagesRoutes(walk(pagesDir));
        const match = matchPagesRoute(pagesRoutes, pathname);
        return match ? (match.route.isDynamic ? "dynamic" : "static") : null;
      };
      server.watcher.on("add", invalidateManifest);
      server.watcher.on("unlink", invalidateManifest);

      server.middlewares.use(async (req, res, next) => {
        if (!isPageRequest(req, root)) return next();
        const handlePages = async (request, response, routed) => {
          const mod = await server.ssrLoadModule(PAGES_SERVER_ENTRY);
          await mod.handlePagesRequest(request, response, {
            dev: true,
            buildId: "development",
            clientEntryUrl: clientEntryUrl(root),
            transformHtml: (url, html) => server.transformIndexHtml(url, html),
            routed,
          });
        };
        try {
          // The App Router's pipeline runs middleware once for app/ and pages/
          // routes alike; Pages data requests keep the Pages Router's own.
          if (appDir && !(req.url || "/").startsWith("/_next/")) {
            const { handleAppRouterRequest } = await import("../server/app-router/index.js");
            const entry = await server.environments.rsc.runner.import(APP_RSC_ENTRY);
            await handleAppRouterRequest(req, res, { entry, pagesRouteKind, handlePages });
            return;
          }
          await handlePages(req, res);
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
  if (!usesAppRouter) return plugin;
  const rsc = import("@vitejs/plugin-rsc").then(({ default: vitePluginRsc }) =>
    vitePluginRsc({
      entries: { rsc: APP_RSC_ENTRY, ssr: APP_SSR_ENTRY, client: APP_CLIENT_ENTRY },
      serverHandler: false,
    }),
  );
  return [plugin, rsc];
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
