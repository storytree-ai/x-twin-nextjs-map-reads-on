"use server";

import { redirect } from "next/navigation";

/** Redirects back to this route, marking it done. */
export async function redirectHere(): Promise<void> {
  redirect("/action-redirect-layout-state?done=1");
}
