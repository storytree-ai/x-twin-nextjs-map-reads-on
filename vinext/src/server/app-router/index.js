/**
 * App Router seam. The dev middleware calls this first when the app has an
 * `app/` directory; returning false hands the request to the Pages Router.
 * App Router rendering lands in its own increment.
 */
export async function handleAppRouterRequest(_server, _req, _res, _ctx) {
  return false;
}
