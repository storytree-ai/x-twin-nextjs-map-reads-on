/**
 * Metadata routes: robots.ts, sitemap.ts, manifest.ts and generated icons and
 * Open Graph images answer with what their default export returns, written
 * as Next.js writes it; static metadata files answer with their bytes.
 */
import crypto from "node:crypto";
import { METADATA_ID_PARAM } from "../../routing/app-routes.js";

const CACHE_CONTROL = "public, max-age=0, must-revalidate";
const CONTENT_TYPES = {
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  gif: "image/gif",
  txt: "text/plain",
  xml: "application/xml",
  json: "application/manifest+json",
  webmanifest: "application/manifest+json",
};

const arrayOf = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

export function resolveRobots(data) {
  let content = "";
  for (const rule of arrayOf(data?.rules)) {
    for (const agent of arrayOf(rule.userAgent ?? "*")) content += `User-Agent: ${agent}\n`;
    for (const item of arrayOf(rule.allow)) content += `Allow: ${item}\n`;
    for (const item of arrayOf(rule.disallow)) content += `Disallow: ${item}\n`;
    if (rule.crawlDelay) content += `Crawl-delay: ${rule.crawlDelay}\n`;
    content += "\n";
  }
  if (data?.host) content += `Host: ${data.host}\n`;
  for (const sitemap of arrayOf(data?.sitemap)) content += `Sitemap: ${sitemap}\n`;
  return content;
}

const escapeXml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function videoXml(video) {
  const field = (name, value) => (value === undefined || value === null || value === false ? null : `<video:${name}>${escapeXml(value)}</video:${name}>`);
  const attr = (name, value, key) => (value ? `<video:${name} ${key}="${escapeXml(value[key])}">${escapeXml(value.content)}</video:${name}>` : null);
  return [
    "<video:video>",
    field("title", video.title),
    field("thumbnail_loc", video.thumbnail_loc),
    field("description", video.description),
    field("content_loc", video.content_loc),
    field("player_loc", video.player_loc),
    field("duration", video.duration),
    field("view_count", video.view_count),
    field("tag", video.tag),
    field("rating", video.rating),
    field("expiration_date", video.expiration_date),
    field("publication_date", video.publication_date),
    field("family_friendly", video.family_friendly),
    field("requires_subscription", video.requires_subscription),
    field("live", video.live),
    attr("restriction", video.restriction, "relationship"),
    attr("platform", video.platform, "relationship"),
    video.uploader
      ? `<video:uploader${video.uploader.info ? ` info="${escapeXml(video.uploader.info)}"` : ""}>${escapeXml(video.uploader.content)}</video:uploader>`
      : null,
    "</video:video>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function resolveSitemap(entries) {
  const list = arrayOf(entries);
  const hasAlternates = list.some((item) => Object.keys(item.alternates?.languages ?? {}).length > 0);
  const hasImages = list.some((item) => item.images?.length);
  const hasVideos = list.some((item) => item.videos?.length);
  let content = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  if (hasImages) content += ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
  if (hasVideos) content += ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';
  if (hasAlternates) content += ' xmlns:xhtml="http://www.w3.org/1999/xhtml"';
  content += ">\n";
  for (const item of list) {
    content += `<url>\n<loc>${escapeXml(item.url)}</loc>\n`;
    for (const [lang, href] of Object.entries(item.alternates?.languages ?? {})) {
      content += `<xhtml:link rel="alternate" hreflang="${escapeXml(lang)}" href="${escapeXml(href)}" />\n`;
    }
    for (const image of item.images ?? []) content += `<image:image>\n<image:loc>${escapeXml(image)}</image:loc>\n</image:image>\n`;
    for (const video of item.videos ?? []) content += `${videoXml(video)}\n`;
    if (item.lastModified) {
      const date = item.lastModified instanceof Date ? item.lastModified.toISOString() : item.lastModified;
      content += `<lastmod>${escapeXml(date)}</lastmod>\n`;
    }
    if (item.changeFrequency) content += `<changefreq>${escapeXml(item.changeFrequency)}</changefreq>\n`;
    if (typeof item.priority === "number") content += `<priority>${item.priority}</priority>\n`;
    content += "</url>\n";
  }
  return `${content}</urlset>\n`;
}

/** Content type, size (PNG, ICO, JPEG headers) and content hash of a static metadata file. */
export function staticFileInfo(file, bytes) {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const info = { contentType: CONTENT_TYPES[ext] || "application/octet-stream", hash: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
  if (ext === "png" && bytes.length >= 24 && bytes.readUInt32BE(12) === 0x49484452) {
    info.width = bytes.readUInt32BE(16);
    info.height = bytes.readUInt32BE(20);
  } else if (ext === "ico" && bytes.length >= 8) {
    // The first directory entry; 0 means 256.
    info.width = bytes[6] || 256;
    info.height = bytes[7] || 256;
  } else if ((ext === "jpg" || ext === "jpeg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      const length = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = bytes.readUInt16BE(i + 5);
        info.width = bytes.readUInt16BE(i + 7);
        break;
      }
      i += 2 + length;
    }
  }
  return info;
}

function respond(body, contentType, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": contentType, "Cache-Control": CACHE_CONTROL } });
}

const notFound = () => new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });

/** Params as Next.js 15 passes them: a promise that also has the values as properties. */
function thenable(value) {
  return Object.assign(Promise.resolve(value), value);
}

/** An id that reads as its value and can be awaited, for Next 15 and 16 modules alike. */
function idValue(id) {
  const promise = Promise.resolve(id);
  promise.toString = () => String(id);
  promise[Symbol.toPrimitive] = () => id;
  return promise;
}

/**
 * The id a generated route's URL names, when its generate function lists
 * it, else null (not found). `generate` is generateSitemaps/generateImageMetadata.
 */
async function lookupId(generate, raw, args) {
  if (typeof generate !== "function") return null;
  const list = arrayOf(await generate(args));
  const entry = list.find((item) => String(item?.id) === raw);
  return entry ? entry.id : null;
}

/**
 * Answer a request for a metadata route. `mod` is the route's module (for a
 * static file: { data: base64, info }); `match` is the route and its params.
 */
export async function metadataRouteResponse(mod, { route, params }) {
  const { kind, isStatic } = route.metadata;
  if (isStatic) return respond(Buffer.from(mod.data, "base64"), mod.info.contentType);
  const { [METADATA_ID_PARAM]: rawId, ...routeParams } = params;
  const hasId = rawId !== undefined;
  if (typeof mod.default !== "function") return notFound();

  if (kind === "robots") return respond(resolveRobots(await mod.default()), "text/plain");
  if (kind === "manifest") return respond(JSON.stringify(await mod.default()), "application/manifest+json");
  if (kind === "sitemap") {
    if (typeof mod.generateSitemaps === "function" ? !hasId : hasId) return notFound();
    let id;
    if (hasId) {
      if (!rawId.endsWith(".xml")) return notFound();
      id = await lookupId(mod.generateSitemaps, rawId.slice(0, -4));
      if (id === null) return notFound();
    }
    return respond(resolveSitemap(await mod.default(hasId ? { id: idValue(id) } : {})), "application/xml");
  }

  // icon, apple-icon, opengraph-image, twitter-image
  const props = { params: thenable(routeParams) };
  if (typeof mod.generateImageMetadata === "function" ? !hasId : hasId) return notFound();
  if (hasId) {
    const id = await lookupId(mod.generateImageMetadata, rawId, { params: thenable(routeParams) });
    if (id === null) return notFound();
    props.id = idValue(id);
  }
  const response = await mod.default(props);
  if (!(response instanceof Response)) throw new Error(`[vinext] app/${route.file} did not return a Response`);
  return response;
}
