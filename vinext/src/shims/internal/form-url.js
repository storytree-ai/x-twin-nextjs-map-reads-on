/**
 * The URL a next/form GET submission navigates to, or null when the browser
 * should submit natively. `submitter` holds the submit button's formAction,
 * formMethod and formTarget attributes (undefined when absent); `fields` are
 * the form's entries, the submitter's included.
 */
export function formSubmitUrl({ action, method, target, submitter, fields, base }) {
  const button = submitter || {};
  if ((button.formMethod ?? method ?? "get").toLowerCase() !== "get") return null;
  const formTarget = button.formTarget ?? target;
  if (formTarget && formTarget !== "_self") return null;
  const url = new URL(button.formAction ?? action ?? "", base);
  if (url.origin !== new URL(base).origin) return null;
  const params = new URLSearchParams();
  for (const [key, value] of fields) {
    if (typeof value !== "string") return null;
    params.append(key, value);
  }
  url.search = params.toString();
  return url.pathname + url.search + url.hash;
}
