import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildAppRoutes, matchAppRoute, isAppFile } from "../src/routing/app-routes.js";
import { resolveRobots, resolveSitemap, metadataRouteResponse, staticFileInfo } from "../src/server/app-router/metadata-routes.js";
import { ImageResponse } from "../src/shims/og.js";

const files = [
  "layout.tsx",
  "page.tsx",
  "robots.ts",
  "sitemap.ts",
  "manifest.ts",
  "favicon.ico",
  "icon.png",
  "icon.tsx",
  "apple-icon.png",
  "about/page.tsx",
  "about/opengraph-image.png",
  "(shop)/products/sitemap.ts",
  "blog/[slug]/page.tsx",
  "blog/[slug]/opengraph-image.tsx",
  "@modal/icon.png",
];

test("metadata files are app files; other assets are not", () => {
  for (const f of ["favicon.ico", "icon.png", "about/opengraph-image.png", "robots.txt", "sitemap.xml", "manifest.json", "x/twitter-image.jpg", "icon1.svg"]) {
    assert.ok(isAppFile(f), f);
  }
  for (const f of ["logo.png", "about/styles.css", "data.json", "nested/favicon.ico.bak"]) assert.ok(!isAppFile(f), f);
});

test("metadata files become routes at their Next.js URLs", () => {
  const { routes } = buildAppRoutes(files);
  const at = (pathname) => {
    const m = matchAppRoute(routes, pathname);
    return m && m.route.type === "metadata" ? [m.route.file, m.route.metadata.kind, m.params] : m && m.route.type;
  };
  assert.deepEqual(at("/robots.txt"), ["robots.ts", "robots", {}]);
  assert.deepEqual(at("/sitemap.xml"), ["sitemap.ts", "sitemap", {}]);
  assert.deepEqual(at("/products/sitemap.xml"), ["(shop)/products/sitemap.ts", "sitemap", {}]);
  assert.deepEqual(at("/products/sitemap/1.xml"), ["(shop)/products/sitemap.ts", "sitemap", { __metadata_id__: "1.xml" }]);
  assert.deepEqual(at("/manifest.webmanifest"), ["manifest.ts", "manifest", {}]);
  assert.deepEqual(at("/favicon.ico"), ["favicon.ico", "favicon", {}]);
  assert.deepEqual(at("/icon.png"), ["icon.png", "icon", {}]);
  assert.deepEqual(at("/icon"), ["icon.tsx", "icon", {}]);
  assert.deepEqual(at("/apple-icon.png"), ["apple-icon.png", "apple", {}]);
  assert.deepEqual(at("/about/opengraph-image.png"), ["about/opengraph-image.png", "openGraph", {}]);
  assert.deepEqual(at("/blog/hello/opengraph-image"), ["blog/[slug]/opengraph-image.tsx", "openGraph", { slug: "hello" }]);
  assert.equal(at("/blog/hello"), "page");
  assert.equal(at("/modal/icon.png"), null);
});

test("each level lists the metadata files its pages get in head", () => {
  const { routes } = buildAppRoutes(files);
  const blog = routes.find((r) => r.pattern === "/blog/[slug]");
  assert.deepEqual(
    blog.levels[0].metadataFiles.map((f) => [f.kind, f.file, f.href]),
    [
      ["favicon", "favicon.ico", "/favicon.ico"],
      ["icon", "icon.png", "/icon.png"],
      ["icon", "icon.tsx", "/icon"],
      ["apple", "apple-icon.png", "/apple-icon.png"],
      ["manifest", "manifest.ts", "/manifest.webmanifest"],
    ],
  );
  assert.deepEqual(blog.levels[2].metadataFiles.map((f) => [f.kind, f.href]), [["openGraph", "/blog/[slug]/opengraph-image"]]);
});

test("robots text as Next.js writes it", () => {
  assert.equal(
    resolveRobots({ rules: { userAgent: "*", allow: "/", disallow: ["/private/", "/tmp/"] }, sitemap: "https://e.com/sitemap.xml", host: "https://e.com" }),
    "User-Agent: *\nAllow: /\nDisallow: /private/\nDisallow: /tmp/\n\nHost: https://e.com\nSitemap: https://e.com/sitemap.xml\n",
  );
  assert.equal(resolveRobots({ rules: [{ userAgent: ["a", "b"], disallow: "/", crawlDelay: 2 }] }), "User-Agent: a\nUser-Agent: b\nDisallow: /\nCrawl-delay: 2\n\n");
});

test("sitemap XML with alternates, images and videos", () => {
  const xml = resolveSitemap([
    {
      url: "https://e.com",
      lastModified: new Date("2025-01-01"),
      changeFrequency: "yearly",
      priority: 1,
      alternates: { languages: { fr: "https://e.com/fr" } },
      images: ["https://e.com/i.jpg"],
      videos: [{ title: "V", thumbnail_loc: "https://e.com/t.jpg", description: "D" }],
    },
    { url: "https://e.com/a&b" },
  ]);
  assert.equal(
    xml,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      "<url>",
      "<loc>https://e.com</loc>",
      '<xhtml:link rel="alternate" hreflang="fr" href="https://e.com/fr" />',
      "<image:image>",
      "<image:loc>https://e.com/i.jpg</image:loc>",
      "</image:image>",
      "<video:video>",
      "<video:title>V</video:title>",
      "<video:thumbnail_loc>https://e.com/t.jpg</video:thumbnail_loc>",
      "<video:description>D</video:description>",
      "</video:video>",
      "<lastmod>2025-01-01T00:00:00.000Z</lastmod>",
      "<changefreq>yearly</changefreq>",
      "<priority>1</priority>",
      "</url>",
      "<url>",
      "<loc>https://e.com/a&amp;b</loc>",
      "</url>",
      "</urlset>",
      "",
    ].join("\n"),
  );
});

const routeFor = (pathname, list = files) => matchAppRoute(buildAppRoutes(list).routes, pathname);

test("robots, sitemap and manifest modules answer with their content types", async () => {
  const robots = await metadataRouteResponse({ default: () => ({ rules: { userAgent: "*" } }) }, routeFor("/robots.txt"));
  assert.equal(robots.headers.get("content-type"), "text/plain");
  assert.equal(await robots.text(), "User-Agent: *\n\n");
  const manifest = await metadataRouteResponse({ default: () => ({ name: "App" }) }, routeFor("/manifest.webmanifest"));
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  assert.deepEqual(await manifest.json(), { name: "App" });
  const sitemap = await metadataRouteResponse({ default: async () => [{ url: "https://e.com" }] }, routeFor("/sitemap.xml"));
  assert.equal(sitemap.headers.get("content-type"), "application/xml");
  assert.match(await sitemap.text(), /<urlset[^>]*>\n<url>\n<loc>https:\/\/e.com<\/loc>/);
});

test("generateSitemaps: one sitemap per id; the bare sitemap.xml is not found", async () => {
  const mod = {
    generateSitemaps: () => [{ id: 0 }, { id: "featured" }],
    default: async ({ id }) => [{ url: `https://e.com/${await id}/${id}` }],
  };
  const one = await metadataRouteResponse(mod, routeFor("/products/sitemap/featured.xml"));
  assert.equal(one.status, 200);
  assert.match(await one.text(), /<loc>https:\/\/e.com\/featured\/featured<\/loc>/);
  assert.equal((await metadataRouteResponse(mod, routeFor("/products/sitemap/9.xml"))).status, 404);
  assert.equal((await metadataRouteResponse(mod, routeFor("/products/sitemap.xml"))).status, 404);
  assert.equal((await metadataRouteResponse({ default: () => [] }, routeFor("/products/sitemap/0.xml"))).status, 404);
});

test("generated images get params and answer with what they return", async () => {
  const mod = { default: async ({ params }) => new Response(`og:${(await params).slug}`, { headers: { "Content-Type": "image/png" } }) };
  const res = await metadataRouteResponse(mod, routeFor("/blog/hello/opengraph-image"));
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "og:hello");
});

test("static metadata files answer with their bytes and type", async () => {
  const png = new ImageResponse({ type: "div", props: { style: { background: "#fff" } } }, { width: 3, height: 2 });
  const bytes = Buffer.from(await png.arrayBuffer());
  const info = staticFileInfo("icon.png", bytes);
  assert.deepEqual([info.contentType, info.width, info.height, info.hash.length], ["image/png", 3, 2, 16]);
  const res = await metadataRouteResponse({ data: bytes.toString("base64"), info }, routeFor("/icon.png"));
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal(staticFileInfo("favicon.ico", Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])).width, 16);
});

test("ImageResponse is a PNG of the requested size, filled with the root's background", async () => {
  const res = new ImageResponse({ type: "div", props: { style: { backgroundColor: "#0070f3" } } }, { width: 32, height: 16 });
  assert.ok(res instanceof Response);
  assert.equal(res.headers.get("content-type"), "image/png");
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 16);
  const idat = png.indexOf("IDAT");
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.deepEqual([...raw.subarray(1, 5)], [0x00, 0x70, 0xf3, 0xff]);
  const gradient = new ImageResponse({ type: "div", props: { style: { background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" } } });
  const big = Buffer.from(await gradient.arrayBuffer());
  assert.deepEqual([big.readUInt32BE(16), big.readUInt32BE(20)], [1200, 630]);
});
