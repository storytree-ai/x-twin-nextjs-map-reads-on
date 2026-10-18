/**
 * The "use cache" directive for server code: a function whose body starts
 * with "use cache", and each function a "use cache" file exports, has its
 * body run through the data cache, keyed by the function and its arguments:
 *
 *   async function f(a) { "use cache"; BODY }
 *   async function f(a) { "use cache"; return __vinext_useCache(ID, async () => { BODY }, arguments); }
 *
 * An arrow function, which has no `arguments`, takes its arguments as
 * `...__vinext_args` and passes them to an inner arrow with its parameters.
 * The transform edits text after a scan that knows strings, comments,
 * templates and regular expressions.
 */

const DIRECTIVE_RE = /^use cache(?::\s*[\w-]+)?$/;
const NOT_FUNCTION_HEADS = new Set(["if", "for", "while", "switch", "catch", "with"]);
const REGEX_AFTER_WORDS = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await",
]);

/** Tokens of `code`: { type: "name"|"punct"|"string"|"other", value, start, end }. */
export function tokenize(code) {
  const tokens = [];
  const stack = []; // "{" for braces, "`" for template substitutions
  let i = 0;
  const n = code.length;
  const push = (type, start, end, value = code.slice(start, end)) => tokens.push({ type, value, start, end });

  const scanTemplate = (start) => {
    // i is just past "`" or the "}" closing a substitution.
    while (i < n) {
      const c = code[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        push("other", start, i);
        return;
      }
      if (c === "$" && code[i + 1] === "{") {
        i += 2;
        push("other", start, i);
        stack.push("`");
        return;
      }
      i++;
    }
    push("other", start, n);
  };

  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "name") return REGEX_AFTER_WORDS.has(prev.value);
    if (prev.type === "punct") return !/^[)\]}]$/.test(prev.value);
    return false;
  };

  while (i < n) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      let value = "";
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
        } else value += code[i++];
      }
      i++;
      push("string", start, i, value);
      continue;
    }
    if (c === "`") {
      i++;
      scanTemplate(start);
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      while (i < n && /[\w$\u0080-￿]/.test(code[i])) i++;
      push("name", start, i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] || ""))) {
      while (i < n && /[\w.]/.test(code[i])) i++;
      push("other", start, i);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const ch = code[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i])) i++;
      push("other", start, i);
      continue;
    }
    if (c === "{") {
      stack.push("{");
      i++;
      push("punct", start, i);
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      i++;
      if (top === "`") {
        scanTemplate(start);
        continue;
      }
      push("punct", start, i);
      continue;
    }
    if (c === "=" && code[i + 1] === ">") {
      i += 2;
      push("punct", start, i);
      continue;
    }
    if (c === "." && code[i + 1] === "." && code[i + 2] === ".") {
      i += 3;
      push("punct", start, i);
      continue;
    }
    i++;
    push("punct", start, i);
  }
  return tokens;
}

/** Index of the token closing the bracket opened at `open`. */
function matchForward(tokens, open) {
  const o = tokens[open].value;
  const close = o === "{" ? "}" : o === "(" ? ")" : "]";
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === o) depth++;
    else if (t.value === close && --depth === 0) return k;
  }
  return -1;
}

/** Index of the token opening the bracket closed at `close`. */
function matchBackward(tokens, close) {
  const c = tokens[close].value;
  const open = c === ")" ? "(" : c === "]" ? "[" : "{";
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === c) depth++;
    else if (t.value === open && --depth === 0) return k;
  }
  return -1;
}

/**
 * The function whose body opens at token `brace`: { kind: "function" } (its
 * arguments are `arguments`), { kind: "arrow", open, close } (the tokens
 * around its parameters), { kind: "arrow-name", name }, or null when the
 * brace opens no function body.
 */
function functionShape(tokens, brace) {
  const prev = tokens[brace - 1];
  if (!prev || prev.type !== "punct") return null;
  if (prev.value === "=>") {
    const before = tokens[brace - 2];
    if (!before) return null;
    if (before.type === "name") return { kind: "arrow-name", name: before.value };
    if (before.value !== ")") return null;
    const open = matchBackward(tokens, brace - 2);
    return open < 0 ? null : { kind: "arrow", open, close: brace - 2 };
  }
  if (prev.value !== ")") return null;
  const open = matchBackward(tokens, brace - 1);
  if (open <= 0) return null;
  const head = tokens[open - 1];
  if (head.type === "name" && NOT_FUNCTION_HEADS.has(head.value)) return null;
  return { kind: "function" };
}

function hash(text) {
  let h = 5381;
  for (let k = 0; k < text.length; k++) h = ((h * 33) ^ text.charCodeAt(k)) >>> 0;
  return h.toString(36);
}

const isDirective = (t) => t && t.type === "string" && DIRECTIVE_RE.test(t.value);

/** The token index after a directive at `k` and its optional semicolon. */
function afterStatement(tokens, k) {
  return tokens[k + 1]?.value === ";" ? k + 1 : k;
}

/** The body brace of a function expression or declaration starting at token `j`, or -1. */
function functionBodyAt(tokens, j) {
  if (tokens[j]?.value === "async") j++;
  if (tokens[j]?.value === "function") {
    j++;
    if (tokens[j]?.value === "*") j++;
    if (tokens[j]?.type === "name") j++;
    if (tokens[j]?.value !== "(") return -1;
    j = matchForward(tokens, j) + 1;
  } else if (tokens[j]?.value === "(") {
    j = matchForward(tokens, j) + 1;
    if (tokens[j]?.value !== "=>") return -1;
    j++;
  } else if (tokens[j]?.type === "name" && tokens[j + 1]?.value === "=>") {
    j += 2;
  } else return -1;
  return j > 0 && tokens[j]?.value === "{" ? j : -1;
}

/** Body braces of the functions a module exports, by declaration or by name. */
function exportedFunctionBodies(tokens) {
  const bodies = [];
  const names = new Set();
  const isName = (t, value) => t?.type === "name" && t.value === value;
  for (let k = 0; k < tokens.length; k++) {
    if (!isName(tokens[k], "export") || tokens[k - 1]?.value === ".") continue;
    let j = k + 1;
    if (tokens[j]?.value === "{") {
      // export { a, b as c } (not a re-export from another module)
      const close = matchForward(tokens, j);
      if (close < 0 || isName(tokens[close + 1], "from")) continue;
      for (let m = j + 1; m < close; m++) {
        if (tokens[m].type === "name" && tokens[m - 1].value !== "as") names.add(tokens[m].value);
      }
      continue;
    }
    if (isName(tokens[j], "default")) {
      j++;
      const t = tokens[j];
      if (t?.type === "name" && !["async", "function", "class"].includes(t.value) && tokens[j + 1]?.value !== "=>") {
        names.add(t.value);
        continue;
      }
    }
    if (["const", "let", "var"].includes(tokens[j]?.value)) {
      j += 2; // binding name
      if (tokens[j]?.value !== "=") continue;
      j++;
    }
    const brace = functionBodyAt(tokens, j);
    if (brace >= 0) bodies.push(brace);
  }
  if (names.size === 0) return bodies;
  // Local functions exported by name: function NAME(…) {…} and const NAME = <function>.
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "name" || tokens[k - 1]?.value === ".") continue;
    let brace = -1;
    if (t.value === "function" && names.has(tokens[k + 1]?.value)) {
      brace = functionBodyAt(tokens, isName(tokens[k - 1], "async") ? k - 1 : k);
    } else if (["const", "let", "var"].includes(t.value) && names.has(tokens[k + 1]?.value) && tokens[k + 2]?.value === "=") {
      brace = functionBodyAt(tokens, k + 3);
    }
    if (brace >= 0) bodies.push(brace);
  }
  return bodies;
}

/**
 * The module with its "use cache" functions wrapped, or null when it has
 * none. `id` names the module in cache keys; `runtime` is the module
 * exporting useCache().
 */
export function transformUseCache(code, id, { runtime = "vinext/use-cache-runtime" } = {}) {
  if (!code.includes("use cache")) return null;
  const tokens = tokenize(code);
  // The directive prologue: leading string statements.
  let prologueEnd = -1;
  let fileLevel = false;
  for (let k = 0; k < tokens.length && tokens[k].type === "string"; ) {
    const next = tokens[k + 1];
    if (next && next.value !== ";" && next.type !== "string" && next.start <= code.indexOf("\n", tokens[k].end)) break;
    if (isDirective(tokens[k])) fileLevel = true;
    prologueEnd = afterStatement(tokens, k);
    k = prologueEnd + 1;
  }

  // [brace token index, index of the last token before the body's code]
  const bodies = new Map();
  for (let k = 1; k < tokens.length; k++) {
    if (!isDirective(tokens[k]) || tokens[k - 1].value !== "{" || tokens[k - 1].type !== "punct") continue;
    if (functionShape(tokens, k - 1) === null) continue;
    bodies.set(k - 1, afterStatement(tokens, k));
  }
  if (fileLevel) {
    for (const brace of exportedFunctionBodies(tokens)) if (!bodies.has(brace)) bodies.set(brace, brace);
  }
  if (bodies.size === 0) return null;

  // Edits: insert `text` at `at`, replacing up to `end` when given.
  const edits = [];
  let index = 0;
  for (const [brace, lead] of [...bodies].sort((a, b) => a[0] - b[0])) {
    const close = matchForward(tokens, brace);
    const shape = functionShape(tokens, brace);
    if (close < 0 || shape === null) continue;
    const bodyStart = tokens[lead].end;
    const bodyEnd = tokens[close].start;
    const call = `__vinext_useCache(${JSON.stringify(`${id}#${index++}:${hash(code.slice(bodyStart, bodyEnd))}`)}`;
    if (shape.kind === "arrow") {
      // An arrow has no `arguments`: it takes them as a rest parameter and
      // hands them to an inner arrow with its own parameter list.
      const paramsStart = tokens[shape.open].end;
      const paramsEnd = tokens[shape.close].start;
      edits.push({ at: paramsStart, end: paramsEnd, text: "...__vinext_args" });
      edits.push({ at: bodyStart, text: ` return ${call}, async (${code.slice(paramsStart, paramsEnd)}) => {` });
      edits.push({ at: bodyEnd, text: "}, __vinext_args); " });
    } else {
      edits.push({ at: bodyStart, text: ` return ${call}, async () => {` });
      edits.push({ at: bodyEnd, text: `}, ${shape.kind === "function" ? "arguments" : `[${shape.name}]`}); ` });
    }
  }
  if (edits.length === 0) return null;
  const importAt = prologueEnd >= 0 ? tokens[prologueEnd].end : 0;
  edits.push({ at: importAt, text: `${importAt ? "\n" : ""}import { useCache as __vinext_useCache } from ${JSON.stringify(runtime)};\n` });
  // Stable sort keeps a closing insert before a later opening at the same offset.
  edits.sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  for (const { at, end, text } of edits) {
    if (at < last) continue; // inside a replaced parameter list
    out += code.slice(last, at) + text;
    last = end ?? at;
  }
  return out + code.slice(last);
}
