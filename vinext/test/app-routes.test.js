import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppRoutes, matchAppRoute, matchIntercept, nextErrorBoundary } from "../src/routing/app-routes.js";

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

test("a render error goes to the nearest error.tsx above where it was thrown, then global-error", () => {
  const { routes, root } = buildAppRoutes([
    "layout.tsx",
    "global-error.tsx",
    "a/error.tsx",
    "a/layout.tsx",
    "a/b/c/error.tsx",
    "a/b/c/page.tsx",
  ]);
  const { levels } = matchAppRoute(routes, "/a/b/c").route;
  const hasGlobal = Boolean(root.globalError);
  // The page threw: the error.tsx beside it catches.
  assert.equal(nextErrorBoundary(levels, Infinity, hasGlobal), 3);
  // That boundary's layout threw too: the next error.tsx up, skipping b/.
  assert.equal(nextErrorBoundary(levels, 3, hasGlobal), 1);
  // a/layout threw: only global-error is left.
  assert.equal(nextErrorBoundary(levels, 1, hasGlobal), -1);
  // The root layout threw under global-error, or there is no global-error.
  assert.equal(nextErrorBoundary(levels, -1, hasGlobal), null);
  assert.equal(nextErrorBoundary(levels, 1, false), null);
});

const slotFiles = [
  "layout.tsx",
  "page.tsx",
  "dashboard/layout.tsx",
  "dashboard/page.tsx",
  "dashboard/default.tsx",
  "dashboard/settings/page.tsx",
  "dashboard/@team/layout.tsx",
  "dashboard/@team/page.tsx",
  "dashboard/@team/default.tsx",
  "dashboard/@team/members/page.tsx",
  "dashboard/@analytics/page.tsx",
  "dashboard/@analytics/default.tsx",
  "feed/layout.tsx",
  "feed/page.tsx",
  "feed/@modal/default.tsx",
  "feed/@modal/(...)photos/[id]/page.tsx",
  "photos/[id]/page.tsx",
  "shop/(group)/items/page.tsx",
  "shop/(group)/items/(.)detail/[id]/page.tsx",
  "shop/(group)/items/(..)cart/page.tsx",
];

test("a layout's slots render the slot's page for the same URL, else its default", () => {
  const { routes } = buildAppRoutes(slotFiles);
  const dashboard = matchAppRoute(routes, "/dashboard").route;
  assert.deepEqual(Object.keys(dashboard.levels[1].slots).sort(), ["analytics", "team"]);
  const team = dashboard.levels[1].slots.team;
  assert.equal(team.file, "dashboard/@team/page.tsx");
  assert.deepEqual(team.levels.map((l) => [l.segment, l.layout]), [["@team", "dashboard/@team/layout.tsx"]]);
  assert.equal(dashboard.levels[1].slots.analytics.file, "dashboard/@analytics/page.tsx");
  assert.deepEqual(dashboard.levels[0].slots, {});

  const settings = matchAppRoute(routes, "/dashboard/settings").route;
  assert.equal(settings.levels[1].slots.team.file, "dashboard/@team/default.tsx");
  assert.equal(settings.levels[1].slots.team.levels[0].layout, "dashboard/@team/layout.tsx");
  assert.equal(settings.levels[1].slots.analytics.file, "dashboard/@analytics/default.tsx");
});

test("a page only under a slot answers its URL with the slot parent's default.tsx as children", () => {
  const { routes } = buildAppRoutes(slotFiles);
  assert.equal(matchAppRoute(routes, "/dashboard/team"), null);
  const members = matchAppRoute(routes, "/dashboard/members").route;
  assert.equal(members.file, "dashboard/default.tsx");
  assert.deepEqual(members.levels.map((l) => l.segment), ["", "dashboard"]);
  assert.equal(members.levels[1].slots.team.file, "dashboard/@team/members/page.tsx");
  assert.equal(members.levels[1].slots.analytics.file, "dashboard/@analytics/default.tsx");
  // Without a default.tsx beside the slot, the URL is not a route.
  const { routes: bare } = buildAppRoutes(["layout.tsx", "a/layout.tsx", "a/page.tsx", "a/@x/b/page.tsx"]);
  assert.equal(matchAppRoute(bare, "/a/b"), null);
});

test("intercepting pages are not routes; they map to the URL they intercept", () => {
  const { routes, intercepts } = buildAppRoutes(slotFiles);
  assert.equal(matchAppRoute(routes, "/photos/1").route.file, "photos/[id]/page.tsx");
  const feed = matchAppRoute(routes, "/feed").route;
  assert.equal(feed.levels[1].slots.modal.file, "feed/@modal/default.tsx");
  const byFile = Object.fromEntries(intercepts.map((i) => [i.file, i]));
  const photo = byFile["feed/@modal/(...)photos/[id]/page.tsx"];
  assert.equal(photo.pattern, "/photos/[id]");
  assert.equal(photo.owner, "feed");
  assert.equal(photo.slot, "modal");
  assert.deepEqual(photo.levels.map((l) => l.segment), ["@modal", "(...)photos", "[id]"]);
  assert.equal(byFile["shop/(group)/items/(.)detail/[id]/page.tsx"].pattern, "/shop/items/detail/[id]");
  assert.equal(byFile["shop/(group)/items/(.)detail/[id]/page.tsx"].slot, "children");
  assert.equal(byFile["shop/(group)/items/(.)detail/[id]/page.tsx"].owner, "shop/(group)/items");
  assert.equal(byFile["shop/(group)/items/(..)cart/page.tsx"].pattern, "/shop/cart");
});

test("an intercept applies only when navigating from under the intercepting layout", () => {
  const { routes, intercepts } = buildAppRoutes(slotFiles);
  const hit = matchIntercept(intercepts, routes, "/photos/7", "/feed");
  assert.equal(hit.route.pattern, "/feed");
  assert.equal(hit.intercept.file, "feed/@modal/(...)photos/[id]/page.tsx");
  assert.deepEqual(hit.params, { id: "7" });
  assert.equal(hit.ownerIndex, 1);
  assert.equal(matchIntercept(intercepts, routes, "/photos/7", "/dashboard"), null);
  assert.equal(matchIntercept(intercepts, routes, "/photos/7", null), null);
  assert.equal(matchIntercept(intercepts, routes, "/feed", "/feed"), null);
});
