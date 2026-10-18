import { test, expect } from "@playwright/test";

import { waitForHydration } from "../helpers";

const BASE = process.env.APP_BASE_URL || "http://localhost:4174";

test.describe("Per-segment redirect boundaries", () => {
  test("server action redirect to the current route keeps layout client state", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(`${BASE}/action-redirect-layout-state`);
    await waitForHydration(page);
    await expect(page.getByTestId("done")).toHaveText("not done");

    const counter = page.getByTestId("layout-count");
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("Layout count: 2");

    await page.getByTestId("redirect-here-btn").click();
    await expect(page).toHaveURL(/\/action-redirect-layout-state\?done=1$/);
    await expect(page.getByTestId("done")).toHaveText("done");
    await expect(counter).toHaveText("Layout count: 2");

    expect(errors.filter((e) => e.includes("NEXT_REDIRECT"))).toEqual([]);
  });
});
