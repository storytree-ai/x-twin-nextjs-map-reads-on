import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMetadata, resolveViewport, metadataTags, viewportTags, fileMetadata } from "../src/server/app-router/metadata-resolve.js";

const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };
const seg = (mod, files) => ({ mod, files });

/** The rendered tags as "tag attr=value ..." strings, for readable assertions. */
function lines(tags) {
  return tags.map(([tag, attrs, text]) => {
    const parts = Object.entries(attrs).map(([k, v]) => `${k}=${v}`);
    return [tag, ...parts].join(" ") + (text !== undefined ? ` :: ${text}` : "");
  });
}

const tagsOf = async (segments, opts) => lines(metadataTags(await resolveMetadata(segments, props, opts)));

test("a layout's title template applies to titles below it, absolute skips it", async () => {
  const layout = { metadata: { title: { template: "%s | Layout", default: "Default" }, description: "layout" } };
  assert.deepEqual((await resolveMetadata([seg(layout), seg({ metadata: { title: "Page" } })], props)).title.absolute, "Page | Layout");
  assert.deepEqual((await resolveMetadata([seg(layout), seg({})], props)).title.absolute, "Default");
  const abs = await resolveMetadata([seg(layout), seg({ metadata: { title: { absolute: "Alone" } } })], props);
  assert.equal(abs.title.absolute, "Alone");
  assert.equal(abs.description, "layout");
});

test("generateMetadata gets params, searchParams and the parent's resolved metadata", async () => {
  const layout = { generateMetadata: async () => ({ openGraph: { images: ["/base.jpg"] } }) };
  const page = {
    async generateMetadata({ params, searchParams }, parent) {
      const { slug } = await params;
      const { q } = await searchParams;
      const previous = (await parent).openGraph?.images ?? [];
      return { title: `${slug} ${q}`, openGraph: { images: ["/new.jpg", ...previous] } };
    },
  };
  const md = await resolveMetadata([seg(layout), seg(page)], { params: Promise.resolve({ slug: "a" }), searchParams: Promise.resolve({ q: "b" }) }, { origin: "http://x.test" });
  assert.equal(md.title.absolute, "a b");
  const out = lines(metadataTags(md));
  assert.deepEqual(out.filter((l) => l.includes("og:image")), [
    "meta property=og:image content=http://x.test/new.jpg",
    "meta property=og:image content=http://x.test/base.jpg",
  ]);
});

test("basic fields render as Next.js renders them", async () => {
  const out = await tagsOf([
    seg({
      metadata: {
        title: "T",
        description: "D",
        generator: "next.js",
        applicationName: "test",
        referrer: "origin-when-cross-origin",
        keywords: ["next.js", "react", "javascript"],
        authors: [{ name: "huozhi" }, { name: "tree", url: "https://tree.com" }],
        creator: "shu",
        publisher: "vercel",
        robots: "index, follow",
        formatDetection: { email: false, address: false, telephone: false },
      },
    }),
  ]);
  assert.deepEqual(out, [
    "title :: T",
    "meta name=description content=D",
    "meta name=application-name content=test",
    "meta name=author content=huozhi",
    "link rel=author href=https://tree.com",
    "meta name=author content=tree",
    "meta name=generator content=next.js",
    "meta name=keywords content=next.js,react,javascript",
    "meta name=referrer content=origin-when-cross-origin",
    "meta name=creator content=shu",
    "meta name=publisher content=vercel",
    "meta name=robots content=index, follow",
    "meta name=format-detection content=telephone=no, address=no, email=no",
  ]);
});

test("robots objects become directives; googleBot its own tag", async () => {
  const out = await tagsOf([seg({ metadata: { robots: { index: false, follow: true, nocache: true, googleBot: { index: true, follow: false, noimageindex: true } } } })]);
  assert.deepEqual(out, ["meta name=robots content=noindex, follow, nocache", "meta name=googlebot content=index, nofollow, noimageindex"]);
});

test("openGraph renders og tags and fills twitter's", async () => {
  const out = await tagsOf(
    [
      seg({
        metadata: {
          openGraph: {
            title: "OG",
            description: "OGD",
            url: "https://example.com",
            siteName: "Site",
            locale: "en-US",
            images: [{ url: "https://example.com/image.png", width: 800, height: 600, alt: "Alt" }],
            type: "website",
          },
        },
      }),
    ],
    { origin: "http://x.test" },
  );
  assert.deepEqual(out, [
    "meta property=og:title content=OG",
    "meta property=og:description content=OGD",
    "meta property=og:url content=https://example.com",
    "meta property=og:site_name content=Site",
    "meta property=og:locale content=en-US",
    "meta property=og:image content=https://example.com/image.png",
    "meta property=og:image:width content=800",
    "meta property=og:image:height content=600",
    "meta property=og:image:alt content=Alt",
    "meta property=og:type content=website",
    "meta name=twitter:card content=summary_large_image",
    "meta name=twitter:title content=OG",
    "meta name=twitter:description content=OGD",
    "meta name=twitter:image content=https://example.com/image.png",
    "meta name=twitter:image:width content=800",
    "meta name=twitter:image:height content=600",
    "meta name=twitter:image:alt content=Alt",
  ]);
});

test("twitter cards: summary, player and app", async () => {
  const basic = await tagsOf([seg({ metadata: { twitter: { card: "summary_large_image", title: "TT", description: "TD", siteId: "siteId", creator: "creator", creatorId: "creatorId", images: ["https://twitter.com/image.png"] } } })]);
  assert.deepEqual(basic, [
    "meta name=twitter:card content=summary_large_image",
    "meta name=twitter:site:id content=siteId",
    "meta name=twitter:creator content=creator",
    "meta name=twitter:creator:id content=creatorId",
    "meta name=twitter:title content=TT",
    "meta name=twitter:description content=TD",
    "meta name=twitter:image content=https://twitter.com/image.png",
  ]);
  const player = await tagsOf([seg({ metadata: { twitter: { card: "player", players: { playerUrl: "https://e.com/p", streamUrl: "https://e.com/s", width: 480, height: 360 } } } })]);
  assert.deepEqual(player.slice(1), [
    "meta name=twitter:player content=https://e.com/p",
    "meta name=twitter:player:stream content=https://e.com/s",
    "meta name=twitter:player:width content=480",
    "meta name=twitter:player:height content=360",
  ]);
  const app = await tagsOf([seg({ metadata: { twitter: { card: "app", app: { id: { iphone: "id1", googleplay: "com.x" }, url: { iphone: "https://e.com/i" }, name: "App" } } } })]);
  assert.deepEqual(app, [
    "meta name=twitter:card content=app",
    "meta name=twitter:app:name:iphone content=App",
    "meta name=twitter:app:id:iphone content=id1",
    "meta name=twitter:app:url:iphone content=https://e.com/i",
    "meta name=twitter:app:name:googleplay content=App",
    "meta name=twitter:app:id:googleplay content=com.x",
  ]);
});

test("alternates, itunes and appLinks", async () => {
  const out = await tagsOf([
    seg({
      metadata: {
        alternates: { canonical: "https://e.com/a", languages: { "en-US": "https://e.com/en", "de-DE": "https://e.com/de" } },
        itunes: { appId: "123", appArgument: "myapp://c/1" },
        appLinks: { ios: { url: "https://e.com/ios", app_store_id: "1" }, android: { package: "com.x", app_name: "A" }, web: { should_fallback: true } },
      },
    }),
  ]);
  assert.deepEqual(out, [
    "link rel=canonical href=https://e.com/a",
    "link rel=alternate href=https://e.com/en hrefLang=en-US",
    "link rel=alternate href=https://e.com/de hrefLang=de-DE",
    "meta name=apple-itunes-app content=app-id=123, app-argument=myapp://c/1",
    "meta property=al:ios:url content=https://e.com/ios",
    "meta property=al:ios:app_store_id content=1",
    "meta property=al:android:package content=com.x",
    "meta property=al:android:app_name content=A",
    "meta property=al:web:should_fallback content=true",
  ]);
});

test("viewport merges root to leaf and renders viewport, theme-color and color-scheme", async () => {
  const vp = await resolveViewport([{ viewport: { themeColor: "#000" } }, { viewport: { themeColor: "#0070f3", colorScheme: "light dark", maximumScale: 1 } }], props);
  assert.deepEqual(lines(viewportTags(vp)), [
    "meta name=viewport content=width=device-width, initial-scale=1, maximum-scale=1",
    "meta name=theme-color content=#0070f3",
    "meta name=color-scheme content=light dark",
  ]);
  const generated = await resolveViewport([{ generateViewport: async () => ({ themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#111" }] }) }], props);
  assert.deepEqual(lines(viewportTags(generated)).slice(1), ["meta name=theme-color content=#111 media=(prefers-color-scheme: dark)"]);
});

test("file-convention icons and Open Graph images; the nearest segment's images win", async () => {
  const rootFiles = fileMetadata([
    { kind: "favicon", href: "/favicon.ico", info: { contentType: "image/x-icon", width: 16, height: 16, hash: "fav" } },
    { kind: "icon", href: "/icon.png", info: { contentType: "image/png", width: 32, height: 32, hash: "abc" } },
    { kind: "apple", href: "/apple-icon.png", info: { contentType: "image/png", width: 180, height: 180, hash: "def" } },
    { kind: "manifest", href: "/manifest.webmanifest", info: {} },
    { kind: "openGraph", href: "/opengraph-image.png", info: { contentType: "image/png", width: 1200, height: 630, hash: "r" } },
  ]);
  const aboutFiles = fileMetadata([{ kind: "openGraph", href: "/about/opengraph-image.png", info: { contentType: "image/png", width: 10, height: 20, hash: "h", alt: "About" } }]);
  const out = await tagsOf([seg({ metadata: { title: "T" } }, rootFiles), seg({}, aboutFiles)], { origin: "http://x.test" });
  assert.deepEqual(out, [
    "title :: T",
    "link rel=manifest href=/manifest.webmanifest",
    "meta property=og:image content=http://x.test/about/opengraph-image.png?h",
    "meta property=og:image:type content=image/png",
    "meta property=og:image:width content=10",
    "meta property=og:image:height content=20",
    "meta property=og:image:alt content=About",
    "meta name=twitter:card content=summary_large_image",
    "meta name=twitter:image content=http://x.test/about/opengraph-image.png?h",
    "meta name=twitter:image:type content=image/png",
    "meta name=twitter:image:width content=10",
    "meta name=twitter:image:height content=20",
    "meta name=twitter:image:alt content=About",
    "link rel=icon href=/favicon.ico type=image/x-icon sizes=16x16",
    "link rel=icon href=/icon.png?abc type=image/png sizes=32x32",
    "link rel=apple-touch-icon href=/apple-icon.png?def type=image/png sizes=180x180",
  ]);
});

test("metadataBase resolves relative URLs", async () => {
  const out = await tagsOf([seg({ metadata: { metadataBase: new URL("https://base.com"), alternates: { canonical: "/c" }, openGraph: { images: "/i.png" } } })], { origin: "http://x.test" });
  assert.equal(out[0], "link rel=canonical href=https://base.com/c");
  assert.equal(out[1], "meta property=og:image content=https://base.com/i.png");
});
