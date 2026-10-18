"use client";

import { redirectHere } from "./actions";

export default function RedirectHereForm() {
  return (
    <form action={redirectHere}>
      <button type="submit" data-testid="redirect-here-btn">
        Redirect here
      </button>
    </form>
  );
}
