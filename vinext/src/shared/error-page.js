import { createElement } from "react";

const styles = {
  wrap: {
    fontFamily: "system-ui, sans-serif",
    height: "100vh",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  h1: { display: "inline-block", margin: "0 20px 0 0", padding: "0 23px 0 0", fontSize: 24, fontWeight: 500 },
  h2: { fontSize: 14, fontWeight: 400, margin: 0 },
};

/** Built-in error page, used when the app has no pages/404 or pages/_error. */
export default function ErrorPage({ statusCode = 404, title }) {
  const text = title || (statusCode === 404 ? "This page could not be found." : "Internal Server Error.");
  return createElement(
    "div",
    { style: styles.wrap },
    createElement(
      "div",
      null,
      createElement("h1", { style: styles.h1 }, statusCode),
      createElement("div", { style: { display: "inline-block" } }, createElement("h2", { style: styles.h2 }, text)),
    ),
  );
}
