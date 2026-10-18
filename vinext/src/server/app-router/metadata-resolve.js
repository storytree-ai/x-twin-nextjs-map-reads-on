/**
 * The Metadata API, resolved as Next.js resolves it: each segment's
 * `metadata`/`generateMetadata` (root layout first, page last) replaces its
 * parent's per key, title templates carry down, file-convention icons and
 * images join in per segment, and the result becomes head tags. Pure: the
 * tags are [tag, attributes, text?] for the React renderer in metadata.js.
 */

const ROBOTS_KEYS = [
  "noarchive",
  "nosnippet",
  "noimageindex",
  "nocache",
  "notranslate",
  "indexifembedded",
  "nositelinkssearchbox",
  "unavailable_after",
  "max-video-preview",
  "max-image-preview",
  "max-snippet",
];
const FORMAT_DETECTION_KEYS = ["telephone", "date", "address", "email", "url"];
const VIEWPORT_KEYS = {
  width: "width",
  height: "height",
  initialScale: "initial-scale",
  minimumScale: "minimum-scale",
  maximumScale: "maximum-scale",
  viewportFit: "viewport-fit",
  userScalable: "user-scalable",
  interactiveWidget: "interactive-widget",
};
const TWITTER_APPS = ["iphone", "ipad", "googleplay"];
const APP_LINK_PLATFORMS = ["ios", "iphone", "ipad", "android", "windows_phone", "windows", "windows_universal", "web"];
const OG_TYPE_FIELDS = {
  article: [
    ["publishedTime", "article:published_time"],
    ["modifiedTime", "article:modified_time"],
    ["expirationTime", "article:expiration_time"],
    ["authors", "article:author"],
    ["section", "article:section"],
    ["tags", "article:tag"],
  ],
  book: [
    ["isbn", "book:isbn"],
    ["releaseDate", "book:release_date"],
    ["authors", "book:author"],
    ["tags", "book:tag"],
  ],
  profile: [
    ["firstName", "profile:first_name"],
    ["lastName", "profile:last_name"],
    ["username", "profile:username"],
    ["gender", "profile:gender"],
  ],
};

const arrayOf = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function resolveUrl(url, base) {
  if (url === undefined || url === null) return null;
  if (url instanceof URL) return url.href;
  const str = String(url);
  if (!base || /^[a-z][a-z\d+.-]*:/i.test(str) || str.startsWith("//")) return str;
  try {
    return new URL(str, base).href;
  } catch {
    return str;
  }
}

function applyTemplate(template, title) {
  return typeof template === "string" ? template.replace("%s", title) : title;
}

/** { absolute, template } for a title value under the template stashed above it. */
function resolveTitle(title, stashed) {
  if (typeof title === "string") return { absolute: applyTemplate(stashed, title), template: null };
  if (!title || typeof title !== "object") return { absolute: "", template: null };
  let absolute = "";
  if (typeof title.default === "string") absolute = applyTemplate(stashed, title.default);
  if (typeof title.absolute === "string" && title.absolute) absolute = title.absolute;
  return { absolute, template: typeof title.template === "string" ? title.template : null };
}

function resolveImages(images, base) {
  return arrayOf(images)
    .map((image) => (typeof image === "string" || image instanceof URL ? { url: image } : image))
    .filter((image) => image && image.url !== undefined)
    .map((image) => ({ ...image, url: resolveUrl(image.url, base) }));
}

function resolveOpenGraph(og, base, stashedTemplate) {
  if (!og || typeof og !== "object") return og ?? null;
  const out = { ...og };
  if (og.title !== undefined) out.title = resolveTitle(og.title, stashedTemplate);
  if (og.url !== undefined) out.url = resolveUrl(og.url, base.explicit);
  for (const key of ["images", "videos", "audio"]) if (og[key] !== undefined) out[key] = resolveImages(og[key], base.images);
  return out;
}

function resolveTwitter(tw, base, stashedTemplate) {
  if (!tw || typeof tw !== "object") return tw ?? null;
  const out = { ...tw };
  if (tw.title !== undefined) out.title = resolveTitle(tw.title, stashedTemplate);
  if (tw.images !== undefined) out.images = resolveImages(tw.images, base.images);
  return out;
}

function resolveIcons(icons) {
  if (!icons) return null;
  const normalize = (list) => arrayOf(list).map((icon) => (typeof icon === "string" || icon instanceof URL ? { url: String(icon) } : icon));
  if (typeof icons === "string" || icons instanceof URL || Array.isArray(icons)) return { icon: normalize(icons), apple: [], shortcut: [], other: [] };
  return { icon: normalize(icons.icon), apple: normalize(icons.apple), shortcut: normalize(icons.shortcut), other: normalize(icons.other) };
}

/**
 * The file-convention metadata of one segment, from its files:
 * [{ kind: favicon|icon|apple|openGraph|twitter|manifest, href, info }],
 * `info` holding contentType, width, height, hash and alt as known.
 */
export function fileMetadata(entries) {
  const out = { icon: [], apple: [], openGraph: [], twitter: [], manifest: null };
  // favicon.ico keeps its bare URL, as browsers ask for it.
  const asIcon = ({ kind, href, info = {} }) => {
    const icon = { url: info.hash && kind !== "favicon" ? `${href}?${info.hash}` : href };
    if (info.contentType) icon.type = info.contentType;
    if (info.width && info.height) icon.sizes = `${info.width}x${info.height}`;
    else if (info.sizes) icon.sizes = info.sizes;
    return icon;
  };
  const asImage = ({ href, info = {} }) => {
    const image = { url: info.hash ? `${href}?${info.hash}` : href };
    if (info.contentType) image.type = info.contentType;
    if (info.width) image.width = info.width;
    if (info.height) image.height = info.height;
    if (info.alt) image.alt = info.alt;
    return image;
  };
  for (const entry of entries) {
    if (entry.kind === "manifest") out.manifest = entry.href;
    else if (entry.kind === "favicon") out.icon.unshift(asIcon(entry));
    else if (entry.kind === "icon" || entry.kind === "apple") out[entry.kind].push(asIcon(entry));
    else if (entry.kind === "openGraph" || entry.kind === "twitter") out[entry.kind].push(asImage(entry));
  }
  return out;
}

const isPlainObject = (value) => value !== null && typeof value === "object";

/**
 * Merge the metadata of `segments` ([{ mod, files }], root layout first,
 * page last). generateMetadata(props, parent) gets a promise of what the
 * segments above resolved to. `origin` stands in for metadataBase when
 * Open Graph and Twitter images are relative.
 */
export async function resolveMetadata(segments, props, { origin } = {}) {
  const resolved = { title: null, metadataBase: null };
  let templates = { title: null, openGraph: null, twitter: null };
  for (const { mod, files } of segments) {
    let md = mod?.metadata;
    if (mod && typeof mod.generateMetadata === "function") md = await mod.generateMetadata(props, Promise.resolve(snapshot(resolved)));
    const base = () => {
      const explicit = resolved.metadataBase;
      return { explicit, images: explicit || origin };
    };
    const next = { title: templates.title, openGraph: templates.openGraph, twitter: templates.twitter };
    if (isPlainObject(md)) {
      if (md.metadataBase !== undefined) resolved.metadataBase = md.metadataBase ? resolveUrl(md.metadataBase) : null;
      for (const [key, value] of Object.entries(md)) {
        if (key === "metadataBase") continue;
        if (key === "title") {
          resolved.title = resolveTitle(value, templates.title);
          next.title = resolved.title.template ?? templates.title;
        } else if (key === "openGraph") {
          resolved.openGraph = resolveOpenGraph(value, base(), templates.openGraph);
          next.openGraph = resolved.openGraph?.title?.template ?? templates.openGraph;
        } else if (key === "twitter") {
          resolved.twitter = resolveTwitter(value, base(), templates.twitter);
          next.twitter = resolved.twitter?.title?.template ?? templates.twitter;
        } else if (key === "icons") resolved.icons = resolveIcons(value);
        else if (key === "keywords") resolved.keywords = typeof value === "string" ? value.split(",").map((k) => k.trim()) : arrayOf(value);
        else if (key === "authors") resolved.authors = arrayOf(value);
        else resolved[key] = value;
      }
    }
    if (files) applyFiles(resolved, md, files, base());
    templates = next;
  }
  return postProcess(resolved);
}

/** A segment's icon files replace the icons above; its images, unless its metadata names its own. */
function applyFiles(resolved, md, files, base) {
  if (files.icon.length || files.apple.length) {
    resolved.icons = { icon: files.icon, apple: files.apple, shortcut: [], other: [] };
  }
  if (files.manifest) resolved.manifest = files.manifest;
  const own = (key) => isPlainObject(md?.[key]) && md[key].images !== undefined;
  if (files.openGraph.length && !own("openGraph")) {
    resolved.openGraph = { ...(resolved.openGraph || {}), images: resolveImages(files.openGraph, base.images) };
  }
  if (files.twitter.length && !own("twitter")) {
    resolved.twitter = { ...(resolved.twitter || {}), images: resolveImages(files.twitter, base.images) };
  }
}

/** Twitter fields an Open Graph sets and twitter leaves out are filled from it. */
function postProcess(md) {
  const { openGraph, twitter } = md;
  if (!openGraph) return md;
  const fill = {};
  if (!twitter?.title?.absolute && openGraph.title?.absolute) fill.title = openGraph.title;
  if (!twitter?.description && openGraph.description) fill.description = openGraph.description;
  if (!(twitter && Object.prototype.hasOwnProperty.call(twitter, "images") && twitter.images) && openGraph.images) fill.images = openGraph.images;
  if (Object.keys(fill).length === 0) return md;
  return { ...md, twitter: { ...(twitter || {}), ...fill } };
}

/** The resolved metadata a child's generateMetadata sees as `parent`. */
function snapshot(resolved) {
  return {
    ...resolved,
    title: resolved.title ?? { absolute: "", template: null },
    metadataBase: resolved.metadataBase ? new URL(resolved.metadataBase) : null,
  };
}

/** Merge `viewport`/`generateViewport` of modules ordered root first. */
export async function resolveViewport(mods, props) {
  const viewport = { width: "device-width", initialScale: 1 };
  for (const mod of mods) {
    let vp = mod?.viewport;
    if (mod && typeof mod.generateViewport === "function") vp = await mod.generateViewport(props);
    if (isPlainObject(vp)) Object.assign(viewport, vp);
  }
  return viewport;
}

const meta = (name, content) => (content === undefined || content === null || content === "" ? null : ["meta", { name, content: String(content) }]);
const prop = (property, content) => (content === undefined || content === null || content === "" ? null : ["meta", { property, content: String(content) }]);

export function viewportTags(viewport) {
  const parts = [];
  for (const [key, attr] of Object.entries(VIEWPORT_KEYS)) {
    let value = viewport[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") value = value ? "yes" : "no";
    parts.push(`${attr}=${value}`);
  }
  const tags = [];
  if (parts.length) tags.push(meta("viewport", parts.join(", ")));
  for (const color of arrayOf(viewport.themeColor)) {
    if (typeof color === "string") tags.push(meta("theme-color", color));
    else if (color?.color) tags.push(["meta", { name: "theme-color", content: color.color, ...(color.media ? { media: color.media } : {}) }]);
  }
  if (viewport.colorScheme) tags.push(meta("color-scheme", viewport.colorScheme));
  return tags.filter(Boolean);
}

function robotsValue(robots) {
  if (!robots) return null;
  if (typeof robots === "string") return robots;
  const values = [];
  if (robots.index) values.push("index");
  else if (typeof robots.index === "boolean") values.push("noindex");
  if (robots.follow) values.push("follow");
  else if (typeof robots.follow === "boolean") values.push("nofollow");
  for (const key of ROBOTS_KEYS) {
    const value = robots[key];
    if (value !== undefined && value !== false) values.push(typeof value === "boolean" ? key : `${key}:${value}`);
  }
  return values.join(", ");
}

function imageTags(images, tag, prefix) {
  const out = [];
  for (const image of images || []) {
    out.push(tag(prefix, image.url));
    if (image.secureUrl) out.push(tag(`${prefix}:secure_url`, resolveUrl(image.secureUrl)));
    if (image.type) out.push(tag(`${prefix}:type`, image.type));
    if (image.width) out.push(tag(`${prefix}:width`, image.width));
    if (image.height) out.push(tag(`${prefix}:height`, image.height));
    if (image.alt) out.push(tag(`${prefix}:alt`, image.alt));
  }
  return out;
}

function openGraphTags(og) {
  if (!og) return [];
  const tags = [
    prop("og:determiner", og.determiner),
    prop("og:title", og.title?.absolute),
    prop("og:description", og.description),
    prop("og:url", og.url),
    prop("og:site_name", og.siteName),
    prop("og:locale", og.locale),
    prop("og:country_name", og.countryName),
    prop("og:ttl", og.ttl),
    ...imageTags(og.images, prop, "og:image"),
    ...imageTags(og.videos, prop, "og:video"),
    ...imageTags(og.audio, prop, "og:audio"),
    ...arrayOf(og.emails).map((v) => prop("og:email", v)),
    ...arrayOf(og.phoneNumbers).map((v) => prop("og:phone_number", v)),
    ...arrayOf(og.faxNumbers).map((v) => prop("og:fax_number", v)),
    ...arrayOf(og.alternateLocale).map((v) => prop("og:locale:alternate", v)),
  ];
  if (og.type) {
    tags.push(prop("og:type", og.type));
    for (const [key, property] of OG_TYPE_FIELDS[og.type] || []) {
      for (const value of arrayOf(og[key])) tags.push(prop(property, value instanceof Date ? value.toISOString() : value));
    }
  }
  return tags;
}

function twitterTags(tw) {
  if (!tw) return [];
  const tags = [
    // An unset card is summary_large_image with images, else summary.
    meta("twitter:card", tw.card || (tw.images?.length ? "summary_large_image" : "summary")),
    meta("twitter:site", tw.site),
    meta("twitter:site:id", tw.siteId),
    meta("twitter:creator", tw.creator),
    meta("twitter:creator:id", tw.creatorId),
    meta("twitter:title", tw.title?.absolute),
    meta("twitter:description", tw.description),
    ...imageTags(tw.images, meta, "twitter:image"),
  ];
  if (tw.card === "player") {
    for (const player of arrayOf(tw.players)) {
      tags.push(
        meta("twitter:player", resolveUrl(player.playerUrl)),
        meta("twitter:player:stream", resolveUrl(player.streamUrl)),
        meta("twitter:player:width", player.width),
        meta("twitter:player:height", player.height),
      );
    }
  }
  if (tw.card === "app" && tw.app) {
    for (const platform of TWITTER_APPS) {
      if (!tw.app.id?.[platform]) continue;
      tags.push(
        meta(`twitter:app:name:${platform}`, tw.app.name),
        meta(`twitter:app:id:${platform}`, tw.app.id[platform]),
        meta(`twitter:app:url:${platform}`, tw.app.url?.[platform] !== undefined ? resolveUrl(tw.app.url[platform]) : null),
      );
    }
  }
  return tags;
}

function appLinksTags(appLinks) {
  if (!appLinks) return [];
  const tags = [];
  for (const platform of APP_LINK_PLATFORMS) {
    for (const entry of arrayOf(appLinks[platform])) {
      for (const [key, value] of Object.entries(entry)) tags.push(prop(`al:${platform}:${key}`, resolveUrl(value)));
    }
  }
  return tags;
}

function link(rel, href, extra = {}) {
  return href === undefined || href === null ? null : ["link", { rel, href: String(href), ...extra }];
}

function iconTags(icons) {
  if (!icons) return [];
  const attrs = (icon) => {
    const out = {};
    for (const key of ["type", "sizes", "media", "color", "fetchPriority"]) if (icon[key]) out[key] = String(icon[key]);
    return out;
  };
  return [
    ...icons.shortcut.map((i) => link("shortcut icon", i.url, attrs(i))),
    ...icons.icon.map((i) => link(i.rel || "icon", i.url, attrs(i))),
    ...icons.apple.map((i) => link("apple-touch-icon", i.url, attrs(i))),
    ...icons.other.map((i) => link(i.rel || "icon", i.url, attrs(i))),
  ];
}

function alternatesTags(alternates, base) {
  if (!alternates) return [];
  const href = (v) => resolveUrl(typeof v === "object" && v && !(v instanceof URL) ? v.url : v, base);
  const tags = [];
  if (alternates.canonical) tags.push(link("canonical", href(alternates.canonical)));
  for (const [lang, value] of Object.entries(alternates.languages || {})) {
    for (const v of arrayOf(value)) tags.push(link("alternate", href(v), { hrefLang: lang }));
  }
  for (const [media, value] of Object.entries(alternates.media || {})) {
    for (const v of arrayOf(value)) tags.push(link("alternate", href(v), { media }));
  }
  for (const [type, value] of Object.entries(alternates.types || {})) {
    for (const v of arrayOf(value)) tags.push(link("alternate", href(v), { type }));
  }
  return tags;
}

function formatDetectionTag(fd) {
  if (!fd) return null;
  const parts = FORMAT_DETECTION_KEYS.filter((key) => fd[key] === false).map((key) => `${key}=no`);
  return parts.length ? meta("format-detection", parts.join(", ")) : null;
}

function itunesTag(itunes) {
  if (!itunes?.appId) return null;
  return meta("apple-itunes-app", `app-id=${itunes.appId}${itunes.appArgument ? `, app-argument=${itunes.appArgument}` : ""}`);
}

function verificationTags(v) {
  if (!v) return [];
  const tags = [];
  for (const [key, name] of [["google", "google-site-verification"], ["yahoo", "y_key"], ["yandex", "yandex-verification"], ["me", "me"]]) {
    for (const value of arrayOf(v[key])) tags.push(meta(name, value));
  }
  for (const [name, value] of Object.entries(v.other || {})) for (const x of arrayOf(value)) tags.push(meta(name, x));
  return tags;
}

function appleWebAppTags(awa) {
  if (!awa) return [];
  const value = awa === true ? {} : awa;
  return [
    meta("mobile-web-app-capable", value.capable === false ? null : "yes"),
    meta("apple-mobile-web-app-title", value.title),
    ...arrayOf(value.startupImage).map((img) =>
      typeof img === "string" ? link("apple-touch-startup-image", img) : link("apple-touch-startup-image", img.url, img.media ? { media: img.media } : {}),
    ),
    meta("apple-mobile-web-app-status-bar-style", value.statusBarStyle),
  ];
}

/** The head tags for resolved metadata, in Next.js's order. */
export function metadataTags(md) {
  const base = md.metadataBase;
  const tags = [];
  if (md.title?.absolute) tags.push(["title", {}, md.title.absolute]);
  tags.push(meta("description", md.description));
  tags.push(meta("application-name", md.applicationName));
  for (const author of md.authors || []) {
    if (author?.url) tags.push(link("author", resolveUrl(author.url, base)));
    if (author?.name) tags.push(meta("author", author.name));
  }
  if (md.manifest) tags.push(link("manifest", resolveUrl(md.manifest, base)));
  tags.push(meta("generator", md.generator));
  if (md.keywords?.length) tags.push(meta("keywords", md.keywords.join(",")));
  tags.push(meta("referrer", md.referrer));
  tags.push(meta("creator", md.creator));
  tags.push(meta("publisher", md.publisher));
  tags.push(meta("robots", robotsValue(md.robots && typeof md.robots === "object" ? { ...md.robots, googleBot: undefined } : md.robots)));
  if (md.robots && typeof md.robots === "object") tags.push(meta("googlebot", robotsValue(md.robots.googleBot)));
  tags.push(meta("abstract", md.abstract));
  for (const href of arrayOf(md.archives)) tags.push(link("archives", href));
  for (const href of arrayOf(md.assets)) tags.push(link("assets", href));
  for (const href of arrayOf(md.bookmarks)) tags.push(link("bookmarks", href));
  if (md.pagination) {
    tags.push(link("prev", md.pagination.previous ?? null), link("next", md.pagination.next ?? null));
  }
  tags.push(meta("category", md.category));
  tags.push(meta("classification", md.classification));
  for (const [name, value] of Object.entries(md.other || {})) for (const v of arrayOf(value)) tags.push(meta(name, v));
  tags.push(...alternatesTags(md.alternates, base));
  tags.push(itunesTag(md.itunes));
  if (md.facebook) {
    tags.push(prop("fb:app_id", md.facebook.appId));
    for (const admin of arrayOf(md.facebook.admins)) tags.push(prop("fb:admins", admin));
  }
  if (md.pinterest?.richPin !== undefined) tags.push(prop("pinterest-rich-pin", String(md.pinterest.richPin)));
  tags.push(formatDetectionTag(md.formatDetection));
  tags.push(...verificationTags(md.verification));
  tags.push(...appleWebAppTags(md.appleWebApp));
  tags.push(...openGraphTags(md.openGraph));
  tags.push(...twitterTags(md.twitter));
  tags.push(...appLinksTags(md.appLinks));
  tags.push(...iconTags(md.icons));
  return tags.filter(Boolean);
}
