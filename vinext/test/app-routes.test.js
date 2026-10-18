import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppRoutes, matchAppRoute } from "../src/routing/app-routes.js";

const files = [
  "layout.tsx",
  "page.tsx",
  "template.tsx",
  "not-found.tsx",
  "global-error.tsx",
  "about/page.tsx",
  "blog/[slug]/layout.tsx",
  "blog/[slug]/page.tsx",
  "blog/featured/page.tsx",
  "dashboard/layout.tsx",
  "dashboard/page.tsx",
  "dashboard/loading.tsx",
  "dashboard/error.tsx",
  "dashboard/settings/page.tsx",
  "dashboard/@team/page.tsx",
  "dashboard/segment-display.tsx",
  "(marketing)/layout.tsx",
  "(marketing)/features/page.tsx",
  "docs/[...slug]/page.tsx",
  "optional/[[...path]]/page.tsx",
  "api/hello/route.ts",
  "_private/page.tsx",
  "%5Fsites/[subdomain]/page.tsx",
  "feed/@modal/(...)photos/[id]/page.tsx",
  "components/counter.tsx",
];

test("pages and route handlers become routes; slots, private folders and plain modules do not", () => {
  const { routes } = buildAppRoutes(files);
  assert.deepEqual(routes.map((r) => r.pattern).sort(), [
    "/",
    "/_sites/[subdomain]",
    "/about",
    "/api/hello",
    "/blog/[slug]",
    "/blog/featured",
    "/dashboard",
    "/dashboard/settings",
    "/docs/[...slug]",
    "/features",
    "/optional/[[...path]]",
  ]);
  const api = routes.find((r) => r.pattern === "/api/hello");
  assert.equal(api.type, "route");
  assert.equal(api.file, "api/hello/route.ts");
  assert.equal(routes.find((r) => r.pattern === "/about").type, "page");
});

test("the layout chain runs root to leaf, route groups adding a level but no URL segment", () => {
  const { routes } = buildAppRoutes(files);
  const settings = routes.find((r) => r.pattern === "/dashboard/settings");
  assert.deepEqual(
    settings.levels.map((l) => l.segment),
    ["", "dashboard", "settings"],
  );
  assert.deepEqual(
    settings.levels.map((l) => l.layout),
    ["layout.tsx", "dashboard/layout.tsx", null],
  );
  assert.equal(settings.levels[0].template, "template.tsx");
  assert.equal(settings.levels[0].notFound, "not-found.tsx");
  assert.equal(settings.levels[1].loading, "dashboard/loading.tsx");
  assert.equal(settings.levels[1].error, "dashboard/error.tsx");
  assert.equal(settings.file, "dashboard/settings/page.tsx");

  const features = routes.find((r) => r.pattern === "/features");
  assert.deepEqual(
    features.levels.map((l) => [l.segment, l.layout]),
    [
      ["", "layout.tsx"],
      ["(marketing)", "(marketing)/layout.tsx"],
      ["features", null],
    ],
  );
});

test("root boundaries are exposed for unmatched URLs", () => {
  const { root } = buildAppRoutes(files);
  assert.equal(root.layout, "layout.tsx");
  assert.equal(root.notFound, "not-found.tsx");
  assert.equal(root.globalError, "global-error.tsx");
});

test("matching takes static before dynamic before catch-all, decoding params", () => {
  const { routes } = buildAppRoutes(files);
  assert.equal(matchAppRoute(routes, "/blog/featured").route.pattern, "/blog/featured");
  const blog = matchAppRoute(routes, "/blog/hello%20world");
  assert.equal(blog.route.pattern, "/blog/[slug]");
  assert.deepEqual(blog.params, { slug: "hello world" });
  assert.deepEqual(matchAppRoute(routes, "/docs/a/b").params, { slug: ["a", "b"] });
  assert.equal(matchAppRoute(routes, "/docs"), null);
  assert.deepEqual(matchAppRoute(routes, "/optional").params, {});
  assert.deepEqual(matchAppRoute(routes, "/optional/x").params, { path: ["x"] });
  assert.equal(matchAppRoute(routes, "/_sites/acme").route.pattern, "/_sites/[subdomain]");
  assert.equal(matchAppRoute(routes, "/dashboard/team"), null);
  assert.equal(matchAppRoute(routes, "/nope"), null);
});

test("each level records the params its dynamic segment binds", () => {
  const { routes } = buildAppRoutes(files);
  const blog = routes.find((r) => r.pattern === "/blog/[slug]");
  assert.deepEqual(
    blog.levels.map((l) => l.paramName),
    [null, null, "slug"],
  );
});
