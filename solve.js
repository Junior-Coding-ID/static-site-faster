// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written fresh from the kit's README.md and the reference's stated rules; dependency-free, Node 22.
// `run(input)` returns exactly makefun-site 1.0.0's answer for one case's input.
// Speed comes from: bulk HTML escaping, allocation-free word counting, a per-run slug cache,
// fused Markdown lex+render with a range-based inline scanner, and templates compiled to
// plain JavaScript functions (loop bindings are real locals, so "__proto__" can never leak
// into a prototype; every cache is created fresh inside run(), so nothing leaks between cases).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (a single regex pass; unchanged when nothing matches). */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let base = dir;
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    if (j > i) {
      const seg = rel.slice(i, j);
      if (seg === '..') {
        if (base === '') return null;
        const k = base.lastIndexOf('/');
        base = k === -1 ? '' : base.slice(0, k);
      } else if (seg !== '.') {
        base = base === '' ? seg : base + '/' + seg;
      }
    }
    i = j + 1;
  }
  return base;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Slug cache, created fresh for every run() so nothing leaks from one case to the next. */
let slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters
 * other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at
 * the cut dropped), and "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const lowered = plain.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let out = dashed.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is whitespace in JavaScript's \s sense (no /u flag). */
function isWS(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace (no allocation, no call per character). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c <= 32
      ? c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32
      : c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A template value, written escaped: textOf, then the HTML escape (numbers and booleans need none). */
function escText(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return escapeHtml(textOf(v));
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Lines are walked with indexOf, never split: the body is the slice
 * after the closing line, which is exactly the reference's lines.slice(close + 1).join('\n').
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing line: a line exactly '---'. Search for '\n---' and check what follows it.
  let closeStart = -1;
  let closeEnd = -1;
  let probe = text.indexOf('\n---', 3);
  while (probe !== -1) {
    const after = probe + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = probe + 1;
      closeEnd = after;
      break;
    }
    probe = text.indexOf('\n---', probe + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = firstEnd + 1; // start of the first front-matter line
  let lineNo = 1; // the opening '---' is line 1
  while (p < closeStart) {
    let e = text.indexOf('\n', p);
    if (e === -1 || e > closeStart) e = closeStart;
    const line = text.slice(p, e);
    lineNo++;
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct: backslash, backtick, * and [. */
const INLINE_SPECIAL = /[\\`*\[]/g;

/**
 * The range [a, b) of `s` rendered inline into `out`; `env.link(target)` is a link's href.
 * A regex jump lands on the next markup character (the plain text between jumps is flushed
 * in bulk, one escape pass per run); strong / emphasis / link bodies recurse on ranges,
 * never on substrings. The regex's lastIndex is set before every exec, so the nested
 * calls cannot disturb the outer scan.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  let plain = a;
  while (i < b) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null || m.index >= b ? -1 : m.index;
    if (j === -1) break;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      const d = s[j + 1];
      if (j + 1 < b && ESCAPABLE.has(d)) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push(escapeHtml(d));
        i = j + 2;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 96) { // backtick: code span
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<em>');
        inlineRange(s, j + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    // [ : link
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
      m2 = s.indexOf(')', k + 2);
      if (m2 === -1 || m2 >= b) m2 = -1;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, j + 1, k, env, out);
      out.push('</a>');
      i = m2 + 1;
      plain = i;
      continue;
    }
    i = j + 1;
  }
  if (b > plain) out.push(escapeHtml(s.slice(plain, b)));
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Lexing and rendering are fused in one pass over the
 * lines; no token array is ever built.
 */
function renderMarkdown(src, env) {
  const len = src.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;

  const isBlank = (s, e) => {
    for (let i = s; i < e; i++) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  const trimSlice = (s, e) => {
    let a = s;
    let b = e;
    while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
    while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
    return src.slice(a, b);
  };
  // Fence open at [s, e): the language, or null ('' when there is none).
  const fenceLang = (s, e) => {
    if (e - s < 3 || src[s] !== '`' || src[s + 1] !== '`' || src[s + 2] !== '`') return null;
    let i = s + 3;
    const langStart = i;
    while (i < e) {
      const c = src.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
      i++;
    }
    const lang = src.slice(langStart, i);
    while (i < e) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return null;
      i++;
    }
    return lang;
  };
  const isFenceClose = (s, e) => {
    if (e - s < 3 || src[s] !== '`' || src[s + 1] !== '`' || src[s + 2] !== '`') return false;
    for (let i = s + 3; i < e; i++) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  // A heading line's level and text range, or null (a heading's text is never empty).
  const headingOf = (s, e) => {
    let i = s;
    let depth = 0;
    while (i < e && src[i] === '#' && depth < 7) { depth++; i++; }
    if (depth === 0 || depth > 6) return null;
    if (i >= e || (src[i] !== ' ' && src[i] !== '\t')) return null;
    let tStart = i;
    while (tStart < e && (src[tStart] === ' ' || src[tStart] === '\t')) tStart++;
    let tEnd = e;
    while (tEnd > tStart && (src[tEnd - 1] === ' ' || src[tEnd - 1] === '\t')) tEnd--;
    if (tStart >= tEnd) return null;
    return { depth, s: tStart, e: tEnd };
  };
  const isHr = (s, e) => {
    if (e - s < 3) return false;
    const a = src[s];
    const b = src[s + 1];
    const c = src[s + 2];
    if (!((a === '-' && b === '-' && c === '-') || (a === '*' && b === '*' && c === '*'))) return false;
    for (let i = s + 3; i < e; i++) {
      const ch = src.charCodeAt(i);
      if (ch !== 32 && ch !== 9) return false;
    }
    return true;
  };
  // Whether the line at [s, e) ends a paragraph: blank, fence, heading or thematic break.
  const endsParagraph = (s, e) => isBlank(s, e) || fenceLang(s, e) !== null || headingOf(s, e) !== null || isHr(s, e);
  // A bullet item's text start, or -1.
  const bulletAt = (s, e) => {
    if (e - s < 2) return -1;
    const c = src.charCodeAt(s);
    if ((c === 45 || c === 42) && src.charCodeAt(s + 1) === 32) return s + 2;
    return -1;
  };
  // An ordered item's number and text start, or null (at most 9 digits).
  const orderedAt = (s, e) => {
    let i = s;
    let n = 0;
    while (i < e && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57 && n < 10) { n++; i++; }
    if (n === 0 || n > 9) return null;
    if (i + 1 >= e || src[i] !== '.' || src[i + 1] !== ' ') return null;
    return { num: Number(src.slice(s, i)), text: i + 2 };
  };
  // A list continuation: two or more spaces, then a non-space.
  const continuedAt = (s, e) => s + 2 < e && src[s] === ' ' && src[s + 1] === ' ' && !isWS(src.charCodeAt(s + 2));

  let pos = 0;
  while (pos < len) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const next = nl === -1 ? len : nl + 1;
    if (isBlank(pos, end)) { pos = next; continue; }
    const lang = fenceLang(pos, end);
    if (lang !== null) {
      const body = [];
      pos = next;
      let closed = false;
      while (pos < len) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? len : nl2;
        if (isFenceClose(pos, end2)) { pos = nl2 === -1 ? len : nl2 + 1; closed = true; break; }
        body.push(src.slice(pos, end2));
        pos = nl2 === -1 ? len : nl2 + 1;
      }
      // An unclosed fence at the end of a source that ends in "\n": the reference's
      // split('\n') leaves one last empty line, which is a body line like any other.
      if (!closed && len > 0 && src[len - 1] === '\n') body.push('');
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(pos, end);
    if (heading !== null) {
      const text = src.slice(heading.s, heading.e);
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      pos = next;
      continue;
    }
    if (isHr(pos, end)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (src[pos] === '>') {
      const lines = [];
      while (pos < len) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? len : nl2;
        if (src[pos] !== '>') break;
        let st = pos + 1;
        if (st < end2 && src[st] === ' ') st++;
        const t = trimSlice(st, end2);
        if (t !== '') lines.push(t);
        pos = nl2 === -1 ? len : nl2 + 1;
      }
      if (lines.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push(`<blockquote>\n<p>${inline(lines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bAt = bulletAt(pos, end);
    const oAt = bAt === -1 ? orderedAt(pos, end) : null;
    if (bAt !== -1 || oAt !== null) {
      const isOrdered = oAt !== null;
      const items = [];
      let cur = null;
      let start = isOrdered ? oAt.num : 1;
      while (pos < len) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? len : nl2;
        const nxt = nl2 === -1 ? len : nl2 + 1;
        const b2 = bulletAt(pos, end2);
        const o2 = isOrdered ? orderedAt(pos, end2) : null;
        const matched = isOrdered ? o2 !== null : b2 !== -1;
        if (matched) {
          cur = [trimSlice(isOrdered ? o2.text : b2, end2)];
          items.push(cur);
          pos = nxt;
        } else if (cur !== null && continuedAt(pos, end2)) {
          cur.push(trimSlice(pos, end2));
          pos = nxt;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const item of items) list += `<li>${inline(item.join('\n'), env)}</li>\n`;
      list += `</${tag}>`;
      blocks.push(list);
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const parts = [trimSlice(pos, end)];
    pos = next;
    while (pos < len) {
      const nl2 = src.indexOf('\n', pos);
      const end2 = nl2 === -1 ? len : nl2;
      if (endsParagraph(pos, end2)) break;
      parts.push(trimSlice(pos, end2));
      pos = nl2 === -1 ? len : nl2 + 1;
    }
    const html = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Compile a template's node tree into a plain function (V, T, D, B, E, H, X, Y):
 * V is the root vars, T the compiled templates, D the include depth, B the loop bindings
 * an enclosing include passed down (or null), E escText (a value written escaped), H
 * Object.hasOwn, X textOf, Y truthy.
 *
 * A for loop's element and its `loop` object become real locals ($vN / $lN), never properties
 * of a scope object — so a loop variable named "__proto__" is an ordinary binding, and a
 * `loop` binding always wins over an element of the same name, exactly as the reference's
 * `{ [name]: x, loop: {...} }` scope object does. An include inside a loop passes its
 * bindings on in a fresh object built with computed keys (`{...B, ["name"]: $vN, ...}`),
 * which keeps "__proto__" an own property instead of a prototype write.
 */
const ROOT_VARS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

function compileTemplate(nodes) {
  const L = ['let o=[];'];
  let tmp = 0;
  let fcnt = 0;
  const stack = []; // {name, local}, push order; searched from the end (innermost wins)

  // An expression for the value at `path`; chained segments go through a temp variable.
  function emitPath(path) {
    const first = path[0];
    let base;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === first) { base = stack[k].local; break; }
    }
    if (base === undefined) {
      if (ROOT_VARS.has(first)) base = 'V.' + first;
      else {
        const q = JSON.stringify(first);
        base = `((B!==null&&H(B,${q}))?B[${q}]:(H(V,${q})?V[${q}]:undefined))`;
      }
    }
    if (path.length === 1) return base;
    const t = '$t' + (tmp++);
    L.push(`let ${t}=${base};`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      L.push(`if(${t}===null||typeof ${t}!=='object'||!H(${t},${seg}))${t}=undefined;else ${t}=${t}[${seg}];`);
    }
    return t;
  }

  function emitNodes(list) {
    for (const n of list) {
      if (n.kind === 'text') {
        L.push(`o.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var') {
        const e = emitPath(n.path);
        L.push(`o.push(E(${e}));`);
      } else if (n.kind === 'raw') {
        const e = emitPath(n.path);
        L.push(`o.push(X(${e}));`);
      } else if (n.kind === 'if') {
        const e = emitPath(n.path);
        L.push(`if(Y(${e})!==${n.not}){`);
        emitNodes(n.then);
        if (n.else !== null) {
          L.push('}else{');
          emitNodes(n.else);
        }
        L.push('}');
      } else if (n.kind === 'for') {
        const e = emitPath(n.path);
        const vn = '$v' + fcnt;
        const ln = '$l' + fcnt;
        fcnt++;
        L.push(`{const _xs=${e};if(Array.isArray(_xs)){for(let _k=0;_k<_xs.length;_k++){const ${vn}=_xs[_k];const ${ln}={index:_k+1,first:_k===0,last:_k===_xs.length-1,length:_xs.length};`);
        stack.push({ name: n.name, local: vn });
        stack.push({ name: 'loop', local: ln });
        emitNodes(n.body);
        stack.pop();
        stack.pop();
        L.push('}}}');
      } else if (n.kind === 'include') {
        let bexpr = 'B';
        if (stack.length > 0) {
          const parts = stack.map((s) => `[${JSON.stringify(s.name)}]:${s.local}`).join(',');
          bexpr = `{...B,${parts}}`;
        }
        L.push(`if(D<8){const _f=T.get(${JSON.stringify(n.name)});if(_f!==undefined)o.push(_f(V,T,D+1,${bexpr},E,H,X,Y));}`);
      }
    }
  }

  emitNodes(nodes);
  L.push("return o.join('');");
  return new Function('V', 'T', 'D', 'B', 'E', 'H', 'X', 'Y', L.join('\n'));
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn({ site, tags: allTags, recent, ...vars }, templates, 0, null, escText, Object.hasOwn, textOf, truthy);
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
