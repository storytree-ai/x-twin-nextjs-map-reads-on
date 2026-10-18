import { Component, createElement } from "react";

/** next/app's default App: renders the page with its props. */
export default class App extends Component {
  static async getInitialProps({ Component: Page, ctx }) {
    const pageProps = Page && Page.getInitialProps ? await Page.getInitialProps(ctx) : {};
    return { pageProps };
  }

  render() {
    const { Component: Page, pageProps } = this.props;
    return createElement(Page, pageProps);
  }
}
