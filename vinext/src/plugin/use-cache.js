/**
 * The "use cache" directive for server code: a function whose body starts
 * with "use cache", and each function a "use cache" file exports, has its
 * body run through the data cache, keyed by the function and its arguments:
 *
 *   async function f(a) { "use cache"; BODY }
 *   async function f(a) { "use cache"; return __vinext_useCache(ID, async () => { BODY }, arguments); }
 *
 * The transform only inserts text, after a scan that knows strings,
 * comments, templates and regular expressions, so code it does not touch
 * keeps its positions.
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
 * How the function whose body opens at token `brace` gets its arguments
 * (an expression), or null when the brace opens no function body.
 */
function functionArgs(code, tokens, brace) {
  const prev = tokens[brace - 1];
  if (!prev || prev.type !== "punct") return null;
  if (prev.value === "=>") {
    const before = tokens[brace - 2];
    if (!before) return null;
    if (before.type === "name") return `[${before.value}]`;
    if (before.value !== ")") return null;
    const open = matchBackward(tokens, brace - 2);
    if (open < 0) return null;
    return `[${arrowParamNames(code.slice(tokens[open].end, before.start)).join(", ")}]`;
  }
  if (prev.value !== ")") return null;
  const open = matchBackward(tokens, brace - 1);
  if (open <= 0) return null;
  const head = tokens[open - 1];
  if (head.type === "name" && NOT_FUNCTION_HEADS.has(head.value)) return null;
  return "arguments";
}

/** The values an arrow function's parameter list binds, as expressions (simple names and rest only). */
function arrowParamNames(params) {
  const out = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const m = /^\s*(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(?:=[\s\S]*)?$/.exec(current);
    if (m) out.push(`${m[1] || ""}${m[2]}`);
    current = "";
  };
  for (const ch of params) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else current += ch;
  }
  if (current.trim()) flush();
  return out;
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

/** Body braces of the functions a module exports by declaration. */
function exportedFunctionBodies(tokens) {
  const bodies = [];
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type !== "name" || tokens[k].value !== "export") continue;
    let j = k + 1;
    if (tokens[j]?.value === "default") j++;
    if (["const", "let", "var"].includes(tokens[j]?.value)) {
      j += 2; // binding name
      if (tokens[j]?.value !== "=") continue;
      j++;
    }
    if (tokens[j]?.value === "async") j++;
    if (tokens[j]?.value === "function") {
      j++;
      if (tokens[j]?.value === "*") j++;
      if (tokens[j]?.type === "name") j++;
      if (tokens[j]?.value !== "(") continue;
      j = matchForward(tokens, j) + 1;
    } else if (tokens[j]?.value === "(") {
      j = matchForward(tokens, j) + 1;
      if (tokens[j]?.value !== "=>") continue;
      j++;
    } else if (tokens[j]?.type === "name" && tokens[j + 1]?.value === "=>") {
      j += 2;
    } else continue;
    if (j > 0 && tokens[j]?.value === "{") bodies.push(j);
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
    if (functionArgs(code, tokens, k - 1) === null) continue;
    bodies.set(k - 1, afterStatement(tokens, k));
  }
  if (fileLevel) {
    for (const brace of exportedFunctionBodies(tokens)) if (!bodies.has(brace)) bodies.set(brace, brace);
  }
  if (bodies.size === 0) return null;

  const inserts = [];
  let index = 0;
  for (const [brace, lead] of [...bodies].sort((a, b) => a[0] - b[0])) {
    const close = matchForward(tokens, brace);
    if (close < 0) continue;
    const args = functionArgs(code, tokens, brace);
    if (args === null) continue;
    const bodyStart = tokens[lead].end;
    const bodyEnd = tokens[close].start;
    const fnId = `${id}#${index++}:${hash(code.slice(bodyStart, bodyEnd))}`;
    inserts.push({ at: bodyStart, text: ` return __vinext_useCache(${JSON.stringify(fnId)}, async () => {` });
    inserts.push({ at: bodyEnd, text: `}, ${args}); ` });
  }
  if (inserts.length === 0) return null;
  const importAt = prologueEnd >= 0 ? tokens[prologueEnd].end : 0;
  inserts.push({ at: importAt, text: `${importAt ? "\n" : ""}import { useCache as __vinext_useCache } from ${JSON.stringify(runtime)};\n` });
  // Stable sort keeps a closing insert before a later opening at the same offset.
  inserts.sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  for (const { at, text } of inserts) {
    out += code.slice(last, at) + text;
    last = at;
  }
  return out + code.slice(last);
}
