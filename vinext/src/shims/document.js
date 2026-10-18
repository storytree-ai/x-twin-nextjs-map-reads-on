import { Component, createElement, useContext } from "react";
import { DocumentContext } from "./internal/contexts.js";

/** Markers the server replaces after rendering the document. */
export const MAIN_MARKER = "<!--__VINEXT_MAIN__-->";
export const HEAD_ID = "__VINEXT_HEAD__";
export const SCRIPTS_ID = "__VINEXT_SCRIPTS__";

export function Html(props) {
  return createElement("html", props);
}

export function Head({ children, ...rest }) {
  return createElement(
    "head",
    rest,
    createElement("meta", { charSet: "utf-8" }),
    children,
    createElement("noscript", { id: HEAD_ID }),
  );
}

export function Main() {
  return createElement("div", { id: "__next", dangerouslySetInnerHTML: { __html: MAIN_MARKER } });
}

export function NextScript() {
  return createElement("script", { id: SCRIPTS_ID });
}

export default class Document extends Component {
  static async getInitialProps(ctx) {
    return ctx.defaultGetInitialProps(ctx);
  }

  render() {
    return createElement(
      Html,
      null,
      createElement(Head),
      createElement("body", null, createElement(Main), createElement(NextScript)),
    );
  }
}

export function useDocumentContext() {
  return useContext(DocumentContext);
}
export { DocumentContext };
