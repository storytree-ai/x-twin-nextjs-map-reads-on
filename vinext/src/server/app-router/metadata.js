/**
 * The head the App Router renders for a route: its segments' metadata and
 * viewport (metadata-resolve.js) and their file-convention icons and images,
 * as React elements React hoists into <head>.
 */
import { createElement, Fragment } from "react";
import { interpolatePattern } from "../../routing/pages-routes.js";
import { resolveMetadata, resolveViewport, metadataTags, viewportTags, fileMetadata } from "./metadata-resolve.js";

/**
 * The file-convention entries of one level for `fileMetadata`: hrefs filled
 * from the params, each file's type, size and alt from its static info or
 * its module's exports (generateImageMetadata giving one entry per id).
 */
async function levelFiles(level, params, load) {
  const entries = [];
  for (const { kind, file, href: pattern, isStatic } of level.metadataFiles || []) {
    const href = interpolatePattern(pattern, params)?.path;
    if (!href) continue;
    const mod = await load(file);
    if (kind === "manifest") entries.push({ kind, href, info: {} });
    else if (isStatic) entries.push({ kind, href, info: mod.info });
    else if (typeof mod.generateImageMetadata === "function") {
      for (const image of (await mod.generateImageMetadata({ params: Promise.resolve(params) })) || []) {
        entries.push({ kind, href: `${href}/${image.id}`, info: imageInfo(image, mod) });
      }
    } else entries.push({ kind, href, info: imageInfo(mod, mod) });
  }
  return fileMetadata(entries);
}

function imageInfo(source, mod) {
  const size = source.size || mod.size;
  return { contentType: source.contentType || mod.contentType || "image/png", width: size?.width, height: size?.height, alt: source.alt ?? mod.alt };
}

/**
 * Head elements for the route levels 0..last and the leaf module (a page or
 * a not-found boundary). `noindex` adds the robots tag a not-found page gets.
 */
export async function renderHead(levels, last, leafMod, { params, props, origin, load, noindex = false }) {
  const segments = await Promise.all(
    levels.slice(0, last + 1).map(async (level) => ({ mod: await load(level.layout), files: await levelFiles(level, params, load) })),
  );
  if (leafMod) segments.push({ mod: leafMod });
  const metadata = await resolveMetadata(segments, props, { origin });
  const viewport = await resolveViewport(
    segments.map((s) => s.mod),
    props,
  );
  const tags = [["meta", { charSet: "utf-8" }], ...(noindex ? [["meta", { name: "robots", content: "noindex" }]] : []), ...viewportTags(viewport), ...metadataTags(metadata)];
  return createElement(
    Fragment,
    null,
    tags.map(([tag, attrs, text], i) => createElement(tag, { key: i, ...attrs }, text)),
  );
}
