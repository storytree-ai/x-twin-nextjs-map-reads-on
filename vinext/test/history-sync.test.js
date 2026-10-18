import { test } from "node:test";
import assert from "node:assert/strict";
import { installHistorySync } from "../src/client/history-sync.js";

function fakeHistory() {
  const entries = [{ state: null, url: "http://localhost/start" }];
  let index = 0;
  const history = {
    get state() {
      return entries[index].state;
    },
    get length() {
      return entries.length;
    },
    pushState(state, _title, url) {
      entries.splice(index + 1, Infinity, { state, url: new URL(url, entries[index].url).href });
      index++;
    },
    replaceState(state, _title, url) {
      entries[index] = { state, url: new URL(url ?? entries[index].url, entries[index].url).href };
    },
  };
  return { history, current: () => entries[index] };
}

test("the app's pushState and replaceState report the new URL; the router's own calls do not", () => {
  const { history, current } = fakeHistory();
  const seen = [];
  const sync = installHistorySync(history, (url) => seen.push(url));
  history.pushState(null, "", "/start?filter=active");
  assert.equal(current().url, "http://localhost/start?filter=active");
  assert.equal(history.length, 2);
  history.replaceState(null, "", "/start?sort=name");
  assert.equal(history.length, 2);
  assert.deepEqual(seen, ["/start?filter=active", "/start?sort=name"]);

  sync.pushState({ __vinext: true }, "/next");
  sync.replaceState({ __vinext: true }, "/next?x=1");
  assert.equal(current().url, "http://localhost/next?x=1");
  assert.equal(seen.length, 2);

  history.pushState({ mine: 1 }, "", "/other");
  assert.deepEqual(current().state, { mine: 1 });

  sync.restore();
  history.pushState(null, "", "/after");
  assert.equal(seen.length, 3);
});

test("restoring leaves a wrapper installed after ours in place", () => {
  const { history } = fakeHistory();
  const sync = installHistorySync(history, () => {});
  const theirs = function theirs() {};
  history.pushState = theirs;
  sync.restore();
  assert.equal(history.pushState, theirs);
});

test("a relative URL resolves against the page it was pushed from", () => {
  const { history, current } = fakeHistory();
  const saved = globalThis.location;
  globalThis.location = { get href() { return current().url; } };
  try {
    history.replaceState(null, "", "/a/b/");
    const seen = [];
    const sync = installHistorySync(history, (url) => seen.push(url));
    history.pushState(null, "", "../c");
    assert.equal(current().url, "http://localhost/a/c");
    assert.deepEqual(seen, ["/a/c"]);
    sync.restore();
  } finally {
    globalThis.location = saved;
  }
});
