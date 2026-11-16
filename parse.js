// parse.js — fast drop-in replacement for marked 18.1.3 (default options:
// gfm true, breaks false, pedantic false, async false).
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Target: byte-identical HTML to marked.parse() on every input, faster.
//
// Structure: single-pass block parser over lines, single-pass inline
// scanner with a delimiter stack for emphasis/del, recursive link labels.
// marked is used only as a behavioral reference; no marked code is copied.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_RE_NOENC = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);)/g;

// Escape HTML. encode=true escapes every & < > " '.
// encode=false escapes < > " ' and & only when it does not start a valid
// entity reference (&#123; / &#x1F; / &name;).
function esc(str, encode) {
  const re = encode ? ESC_RE : ESC_RE_NOENC;
  re.lastIndex = 0;
  if (!re.test(str)) return str;
  re.lastIndex = 0;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(str)) !== null) {
    parts.push(str.slice(last, m.index), ESC_MAP[m[0][0]]);
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

// Decode numeric character references only (marked's Ie): &#42; -> *, &#38;
// -> "&amp;", &#0; / >0x10FFFF / surrogate -> U+FFFD. Named entities are
// NOT decoded here; the renderer keeps them via esc(..., false).
const NUMREF_RE = /&(?:#(\d{1,7})|#[Xx]([A-Fa-f0-9]{1,6}));/g;
function decodeEntities(str) {
  if (str.indexOf('&#') === -1) return str;
  NUMREF_RE.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = NUMREF_RE.exec(str)) !== null) {
    const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
    let rep;
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) rep = '\uFFFD';
    else if (cp === 38) rep = '&amp;';
    else rep = String.fromCodePoint(cp);
    out += str.slice(last, m.index) + rep;
    last = m.index + m[0].length;
  }
  return last === 0 ? str : out + str.slice(last);
}

// marked's he(): encodeURI with %25 folded back to %; null on lone surrogate.
function encodeHref(href) {
  try { const h = encodeURI(href); return h.indexOf('%') === -1 ? h : h.replace(/%25/g, '%'); } catch (e) { return null; }
}

// Reference label normalization (marked's F()): trim, collapse whitespace,
// case-fold through lower->upper->lower.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Unescape backslash + punctuation/symbol (marked's anyPunctuation).
const UNESC_RE = /\\([\p{P}\p{S}])/gu;
function unescPunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(UNESC_RE, '$1');
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
const ALNUM_RE = /[A-Za-z0-9]/;
// ASCII punctuation table (CommonMark punctuation = ASCII punct + Unicode
// P/S). Fast path for the overwhelmingly common ASCII neighbours.
const ASCII_PUNCT = new Uint8Array(128);
for (let c = 33; c <= 47; c++) ASCII_PUNCT[c] = 1;
for (let c = 58; c <= 64; c++) ASCII_PUNCT[c] = 1;
for (let c = 91; c <= 96; c++) ASCII_PUNCT[c] = 1;
for (let c = 123; c <= 126; c++) ASCII_PUNCT[c] = 1;
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_PUNCT[c] === 1 : PUNCT_RE.test(ch);
}
// For del (~): punctuation excludes ~ itself.
function isPunctNoTilde(ch) {
  if (ch === '~') return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_PUNCT[c] === 1 : PUNCT_RE.test(ch);
}
function isWsCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return WS_RE.test(ch);
}

// Flanking of a delimiter run [i, i+n) inside s. Missing neighbours count
// as whitespace (start/end of the inline source).
function flank(s, i, n, tilde) {
  const before = i > 0 ? s[i - 1] : '\n';
  const after = i + n < s.length ? s[i + n] : '\n';
  const bWs = isWsCh(before);
  const bPu = tilde ? isPunctNoTilde(before) : isPunct(before);
  const aWs = isWsCh(after);
  const aPu = tilde ? isPunctNoTilde(after) : isPunct(after);
  return {
    left: !aWs && (!aPu || bWs || bPu),
    right: !bWs && (!bPu || aWs || aPu),
    bWs, bPu, aWs, aPu,
  };
}

// Is ch an ASCII punctuation character (for backslash escapes)?
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\f' || ch === '\v';
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Column width of leading whitespace (tab = next multiple of 4).
function leadWidth(line) {
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4 - (w % 4);
    else break;
  }
  return w;
}
// Index of the first non-space/tab char.
function firstNonWs(line) {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i;
}
// Expand tabs in a line to spaces (tab stops every 4 columns).
function expandTabs(line) {
  if (line.indexOf('\t') === -1) return line;
  let out = '', col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
// Trim trailing blank lines per marked's ge(): keep the raw as-is if at most
// one trailing blank line, else drop all trailing blank lines.
function trimTrailingBlankLines(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && lines[t].trim() === '') t--;
  if (lines.length - t <= 2) return text;
  return lines.slice(0, t + 1).join('\n');
}


// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Node kinds: 0 text (escaped html), 1 raw html tag, 2 code span (escaped
// inner), 3 <br>, 4 link/image, 5 em/strong/del, 6 delimiter run placeholder.
// A delimiter run renders as its literal chars when unmatched.
const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));
const INLINE_EXCLUDE_TAGS = new Set(('a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img').split('|'));
const RAW_TAGS = new Set(['pre', 'code', 'kbd', 'script']);

function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isWordChar(ch) {
  return isAlnum(ch) || ch === '_' || ch === '-';
}
// Email local-part chars (for extended autolink detection).
function isEmailLocal(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return isAlnum(ch) || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 45 || c === 46 || c === 47 || c === 61 ||
    c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;
}

// --- backpedal (extended autolink trailing-junk removal) --------------------
// Hand-rolled equivalent of the CommonMark autolink backpedal: repeatedly
// drop a trailing run of punctuation, a trailing unmatched ')', or a trailing
// &word; entity (word = [A-Za-z0-9]+, never a numeric &#...; reference).
const BP_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', "'", '"', '~', ')']);
function backpedalOnce(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '(') {
      const j = s.indexOf(')', i + 1);
      if (j === -1) break;
      i = j + 1;
    } else if (ch === '&') {
      // entity at end? scan [A-Za-z0-9]+ then ';' at the very end
      let j = i + 1;
      while (j < n && isAlnum(s[j])) j++;
      if (j > i + 1 && j === n - 1 && s[j] === ';') break; // trailing entity: stop here
      i++;
    } else if (BP_PUNCT.has(ch)) {
      // run of punct; it must not reach the end of the string
      let j = i;
      while (j < n && BP_PUNCT.has(s[j])) j++;
      if (j === n) j--; // back off one so the run does not end at the string end
      if (j === i) break;
      i = j;
    } else if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '*' || ch === '_' || ch === "'" || ch === '"' || ch === '~' || ch === ')') {
      break;
    } else {
      // safe char run
      while (i < n) {
        const c = s[i];
        if (c === '(' || c === '&' || BP_PUNCT.has(c)) break;
        i++;
      }
    }
  }
  return s.slice(0, i);
}
function backpedal(s) {
  let prev;
  do { prev = s; s = backpedalOnce(s); } while (s !== prev);
  return s;
}

// --- inline tag scanner -----------------------------------------------------
// Returns the matched tag text starting at src[i] (i points at '<'), or ''.
// Grammar: open tag, close tag, comment, processing instruction, declaration,
// CDATA section. Mirrors the CommonMark inline-tag rules.
function isAsciiLetterCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAsciiAlnumCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isTagNameCode(c) { return isAsciiAlnumCode(c) || c === 45; } // [A-Za-z0-9-]
function isAttrNameStartCode(c) { return isAsciiLetterCode(c) || c === 95 || c === 58; } // [A-Za-z_:]
function isAttrNameCode(c) { return isAsciiAlnumCode(c) || c === 95 || c === 46 || c === 58 || c === 45; } // [\w.:-]

function scanTag(src, i) {
  const n = src.length;
  if (src[i] !== '<' || i + 1 >= n) return '';
  let j = i + 1;
  const c = src[j];
  if (c === '!') {
    // comment <!-- ... --> (no -- inside), declaration <!A ...>, CDATA <![CDATA[ ... ]]>
    if (src.startsWith('<!--', i)) {
      // <!--> <!---> are valid comments; otherwise the first --> closes it
      if (src[i + 4] === '>') return src.slice(i, i + 5);
      if (src[i + 4] === '-' && src[i + 5] === '>') return src.slice(i, i + 6);
      const k = src.indexOf('-->', i + 4);
      if (k === -1) return '';
      return src.slice(i, k + 3);
    }
    if (src.startsWith('<![CDATA[', i)) {
      const k = src.indexOf(']]>', i + 9);
      if (k === -1) return '';
      return src.slice(i, k + 3);
    }
    // declaration: <! + letters, then whitespace, then anything to >
    const c1 = src.charCodeAt(j + 1);
    if (isAsciiLetterCode(c1)) {
      let k = j + 1;
      while (k < n && isAsciiLetterCode(src.charCodeAt(k))) k++;
      if (k === j + 1) return '';
      if (k >= n || !isSpace(src[k])) return '';
      const gt = src.indexOf('>', k);
      if (gt === -1) return '';
      return src.slice(i, gt + 1);
    }
    return '';
  }
  if (c === '?') {
    // processing instruction: <? ... ?> with at least one char before ?>
    const k = src.indexOf('?>', i + 2);
    if (k === -1 || k === i + 2) return '';
    return src.slice(i, k + 2);
  }
  if (c === '/') {
    // close tag: </name\s*>  (name = letter followed by letters/digits/-)
    let k = j + 1;
    if (k >= n || !isAsciiLetterCode(src.charCodeAt(k))) return '';
    while (k < n && isTagNameCode(src.charCodeAt(k))) k++;
    while (k < n && isSpace(src[k])) k++;
    if (k >= n || src[k] !== '>') return '';
    return src.slice(i, k + 1);
  }
  if (isAsciiLetterCode(c.charCodeAt(0))) {
    // open tag: <name (attr)* \s* /?>
    let k = j;
    while (k < n && isTagNameCode(src.charCodeAt(k))) k++;
    while (true) {
      // skip whitespace
      let w = k;
      while (w < n && isSpace(src[w])) w++;
      if (w >= n) return '';
      if (src[w] === '>') return src.slice(i, w + 1);
      if (src[w] === '/' && src[w + 1] === '>') return src.slice(i, w + 2);
      if (w === k) return ''; // no whitespace before attribute: not a tag
      // attribute: name
      k = w;
      if (!isAttrNameStartCode(src.charCodeAt(k))) return '';
      while (k < n && isAttrNameCode(src.charCodeAt(k))) k++;
      if (k === w) return '';
      const nameEnd = k;
      // optional = value
      let v = k;
      while (v < n && isSpace(src[v])) v++;
      if (v < n && src[v] === '=') {
        v++;
        while (v < n && isSpace(src[v])) v++;
        if (v >= n) return '';
        const q = src[v];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, v + 1);
          if (end === -1) return '';
          v = end + 1;
        } else {
          // unquoted value: no whitespace, " ' = < > `
          let u = v;
          while (u < n) {
            const cc = src[u];
            if (isSpace(cc) || cc === '"' || cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
            u++;
          }
          if (u === v) return '';
          v = u;
        }
        // after a value the next char must be whitespace, >, or /
        if (v < n && !isSpace(src[v]) && src[v] !== '>' && src[v] !== '/') return '';
        k = v;
      } else {
        // no value: leave k at the end of the name so the next loop
        // iteration skips the whitespace itself
        k = nameEnd;
      }
      if (k === w) return '';
    }
  }
  return '';
}

// --- autolink <...> ---------------------------------------------------------
const AUTOLINK_SCHEME_RE = /[A-Za-z][A-Za-z0-9+.-]{1,31}:/y;
const AUTOLINK_EMAIL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_])/y;
function scanAutolink(src, i) {
  // src[i] === '<'; returns {text, href} or null
  const n = src.length;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  AUTOLINK_SCHEME_RE.lastIndex = i + 1;
  const sm = AUTOLINK_SCHEME_RE.exec(src);
  if (sm) {
    let j = i + 1 + sm[0].length;
    while (j < n) {
      const c = src[j];
      if (c === '>' ) break;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c.charCodeAt(0) < 32) return null;
      j++;
    }
    if (j >= n || src[j] !== '>') return null;
    const text = src.slice(i + 1, j);
    return { text, href: text, end: j + 1 };
  }
  AUTOLINK_EMAIL_RE.lastIndex = i + 1;
  const em = AUTOLINK_EMAIL_RE.exec(src);
  if (em) {
    const end = i + 1 + em[0].length;
    if (end < n && src[end] === '>') {
      return { text: em[0], href: 'mailto:' + em[0], end: end + 1 };
    }
  }
  return null;
}

// --- extended autolink (GFM) ------------------------------------------------
const BARE_EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
// same, without the trailing lookahead (for emails inside __...__ where the
// closing delimiter run follows the domain)
const BARE_EMAIL_RE_NL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/y;
const SCHEME_RE = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\./y;
const XMPP_RES_RE = /\/[A-Za-z0-9@.]+/y;
function scanUrl(src, i, inLink) {
  if (inLink) return null;
  // mailto: / xmpp: + email
  let proto = null;
  if (src.startsWith('mailto:', i)) proto = 'mailto:';
  else if (src.startsWith('xmpp:', i)) proto = 'xmpp:';
  if (proto) {
    BARE_EMAIL_RE.lastIndex = i + proto.length;
    const em = BARE_EMAIL_RE.exec(src);
    if (!em || em.index !== i + proto.length) return null;
    let text = proto + em[0];
    if (proto === 'xmpp:') {
      XMPP_RES_RE.lastIndex = i + proto.length + em[0].length;
      const rm = XMPP_RES_RE.exec(src);
      if (rm && rm.index === i + proto.length + em[0].length) text += rm[0];
    }
    return { text, href: text, end: i + text.length };
  }
  // scheme:// or www.
  SCHEME_RE.lastIndex = i;
  const sm = SCHEME_RE.exec(src);
  if (sm && sm.index === i) {
    const isWww = sm[0].toLowerCase() === 'www.';
    if (isWww) {
      // www. needs a preceding boundary: start, whitespace, *, _, ~, (, ]
      if (i > 0) {
        const p = src[i - 1];
        if (!(p === ' ' || p === '\t' || p === '\n' || p === '*' || p === '_' || p === '~' || p === '(' || p === ']')) return null;
      }
    }
    // domain labels: (?:[a-zA-Z0-9\-]+\.?)+ then [^\s<]*
    let j = i + sm[0].length;
    let labels = 0;
    while (j < src.length) {
      const start = j;
      let cc = src.charCodeAt(j);
      while (j < src.length && (isAsciiAlnumCode(cc) || cc === 45)) { j++; cc = src.charCodeAt(j); }
      if (j === start) break;
      labels++;
      if (j < src.length && src[j] === '.') { j++; continue; }
      break;
    }
    if (labels === 0) return null;
    while (j < src.length && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '<') j++;
    let text = src.slice(i, j);
    text = backpedal(text);
    if (!text) return null;
    return { text, href: isWww ? 'http://' + text : text, end: i + text.length };
  }
  return null;
}

// --- label scanning for links ------------------------------------------------
// Finds the closing ']' of a label starting at src[i] === '['.
// Skips code spans, backslash escapes and one level of nested [...].
// Returns the index of the closing ']' or -1. Label may span one \n, not \n\n.
function scanLabelEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  let depth = 1;
  let nl = 0;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      // code span (marked's label regex `+[^`]*?`+): the closer is the
      // NEXT backtick run of ANY length (content holds no backtick, so a
      // ] inside is skipped). If there is no later run, the label can only
      // close when this run sits immediately before ] (alternative ``+])
      // — otherwise the label is unclosable.
      let run = 0;
      while (j + run < n && src[j + run] === '`') run++;
      // a run of 2+ immediately before ] is the label's own end (``+(?=]))
      if (run >= 2 && src[j + run] === ']') return j + run;
      let k = j + run;
      let found = -1;
      let seenBracket = false;
      while (k < n) {
        if (src[k] === '`') {
          let r2 = 0;
          while (k + r2 < n && src[k + r2] === '`') r2++;
          found = k + r2;
          break;
        }
        if (src[k] === ']') {
          // a ] may sit inside the code span (closer comes later), but a
          // second ] with no backtick run between means the span is
          // unclosed and the first ] was the label's end
          if (seenBracket) return -1;
          seenBracket = true;
        }
        if (src[k] === '\n') {
          nl++;
          if (nl >= 2) return -1;
        }
        k++;
      }
      if (found === -1) {
        // no closer run: only a run of 2+ immediately before ] lets the
        // label close (marked's ``+(?=]) alternative); a lone backtick fails
        if (run >= 2 && src[j + run] === ']') return j + run;
        return -1;
      }
      j = found;
      continue;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    if (c === '\n') {
      nl++;
      if (nl >= 2) return -1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Does the label (raw text src[ls, le]) contain a '<' that starts a tag or
// autolink extending past the label end? (marked's Be)
function labelHasRunawayTag(src, ls, le) {
  if (src.indexOf('<', ls) === -1 || src.indexOf('<', ls) >= le) return false;
  let s = ls;
  while (s < le) {
    const c = src[s];
    if (c === '\\') { s += 2; continue; }
    if (c === '`') {
      let run = 0;
      while (s + run < le && src[s + run] === '`') run++;
      let k = s + run;
      let found = -1;
      while (k < le) {
        if (src[k] === '`') {
          let r2 = 0;
          while (k + r2 < le && src[k + r2] === '`') r2++;
          if (r2 === run) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found === -1) { s += run; continue; }
      s = found + run;
      continue;
    }
    if (c !== '<') { s++; continue; }
    const tag = scanTag(src, s);
    const al = tag ? null : scanAutolink(src, s);
    const o = tag ? { end: s + tag.length } : al;
    if (o) {
      if (o.end > le) return true;
      s = o.end;
      continue;
    }
    s++;
  }
  return false;
}

// Paren balance helper (marked's ke): -1 balanced/none, -2 unclosed '(',
// otherwise the index of an unmatched ')'.
function parenCheck(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let t = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === '\\') { n++; continue; }
    if (s[n] === '(') t++;
    else if (s[n] === ')') { t--; if (t < 0) return n; }
  }
  return t > 0 ? -2 : -1;
}

// Parse an inline link destination+title starting at src[i] === '('.
// Returns {dest, title, end} (end = index after the closing ')') or null.
// The separator between destination and title holds at most one \n;
// a \n\n anywhere would already have split the paragraph, so it cannot
// occur inside one inline source.
function parseLinkParens(src, i) {
  const n = src.length;
  let j = i + 1;
  // skip [ \t\n]* before the destination
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  let isAngle = false;
  let destEnd = -1; // index just past the destination
  if (src[j] === '<') {
    // angle destination: <(?:\\.|[^\n<>\\])+>
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '\n' || c === '<' || c === '>') break;
      k++;
    }
    if (k < n && src[k] === '>') ok = true;
    if (!ok) return null;
    // odd number of backslashes before the closing > => fail
    let bs = 0;
    for (let q = k - 1; q > j && src[q] === '\\'; q--) bs++;
    if (bs % 2 === 1) return null;
    dest = src.slice(j + 1, k);
    isAngle = true;
    destEnd = k + 1;
  } else {
    // bare destination: [^ \t\n\x00-\x1f]+, balanced parens, backslash-aware.
    // It ends at whitespace, at the closing ')' (depth 0), or at end of input.
    let k = j;
    let depth = 0;
    let closeAt = -1;
    let stoppedAtWs = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) { stoppedAtWs = true; break; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) { closeAt = k; break; }
        depth--;
      }
      k++;
    }
    if (closeAt !== -1) {
      dest = src.slice(j, closeAt);
      destEnd = closeAt; // the ')' itself; no title possible
      // the closing ')' must not be escaped
      let bs = 0;
      for (let q = closeAt - 1; q >= j && src[q] === '\\'; q--) bs++;
      if (bs % 2 === 1) return null;
      return { dest, title: '', end: closeAt + 1 };
    }
    if (!stoppedAtWs) return null; // ran off the end without a closer
    if (depth !== 0) return null; // unclosed '(' in the destination
    dest = src.slice(j, k);
    destEnd = k;
    if (dest.length === 0) return null;
  }
  // separator between destination and title: [ \t]+(\n[ \t]*)? or \n[ \t]*
  // (at least one space/tab or one newline is required for a title to follow)
  let k = destEnd;
  let title = '';
  // consume spaces/tabs, then at most one newline + spaces/tabs
  let sp = k;
  while (sp < n && (src[sp] === ' ' || src[sp] === '\t')) sp++;
  if (sp < n && src[sp] === '\n') {
    sp++;
    while (sp < n && (src[sp] === ' ' || src[sp] === '\t')) sp++;
  }
  if (sp > k && sp < n && (src[sp] === '"' || src[sp] === "'" || src[sp] === '(')) {
    const q = src[sp];
    const close = q === '(' ? ')' : q;
    let m = sp + 1;
    let ok = false;
    while (m < n) {
      const c = src[m];
      if (c === '\\') { m += 2; continue; }
      if (c === close) { ok = true; break; }
      m++;
    }
    if (!ok) return null;
    title = src.slice(sp + 1, m);
    k = m + 1;
    // only [ \t\n]* then ')'
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  } else {
    k = sp;
    // only [ \t\n]* then ')'
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  }
  if (k >= n || src[k] !== ')') return null;
  // the closing ')' must not be escaped
  let bs = 0;
  for (let q = k - 1; q >= i && src[q] === '\\'; q--) bs++;
  if (bs % 2 === 1) return null;
  // bare-dest paren check: an unmatched ')' inside truncates the dest
  if (!isAngle) {
    const pc = parenCheck(dest);
    if (pc === -2) return null;
    if (pc > -1) {
      dest = dest.slice(0, pc);
      title = '';
      return { dest, title, end: j + pc + 1 };
    }
  }
  return { dest, title, end: k + 1 };
}

// Next inline token starter, for skipping plain-text stretches in
// inlineNodes without a per-char loop: backslash, backtick, [, !, <,
// delimiter runs, newline, @, or a URL start (http/https/ftp scheme,
// www., mailto:, xmpp: — same case rules as scanUrl/SCHEME_RE).
const NEXT_TRIG = /\\|`|\[|!|<|[*_~\n@]|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:/g;

// --- marked's #n masking (length-preserving) ---------------------------
// emStrong/del scan a masked copy of the inline source, so delimiter runs
// inside link-like spans or masked by blockSkip never participate in
// emphasis. Only the blockSkip + anyPunctuationOutsideCode steps are ported
// here (reflinkSearch needs the link-definition map and is handled by
// tryLink's own label scan).
const MASK_ANYPUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskedSource(src) {
  let t = src;
  MASK_ANYPUNCT.lastIndex = 0;
  t = t.replace(MASK_ANYPUNCT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  MASK_BLOCKSKIP.lastIndex = 0;
  t = t.replace(MASK_BLOCKSKIP, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  MASK_BLOCKSKIP.lastIndex = 0;
  return t;
}

function inlineNodes(src, links, inLink, inRaw) {
  const n = src.length;
  const nodes = [];
  const stack = []; // delimiter nodes (kind 6), in order
  let hasLink = false;
  let hasMdLink = false;
  let i = 0;
  let textStart = 0;
  let raw = inRaw;
  // masked copy for emphasis gating (marked #n): a delimiter run whose
  // characters were masked (replaced by a/+ ) never forms emphasis.
  // Computed lazily, and only when the source holds both a delimiter run
  // and a mask trigger (` [ < \); otherwise the mask is the identity.
  const maskTriggers = /[*_~]/.test(src) && /[`\[<\\]/.test(src);
  let masked = null;

  function flushText(to) {
    if (to <= textStart) return;
    const s = src.slice(textStart, to);
    // no & < > " ' : entity-decode + escape are the identity
    if (raw || !/[&<>"']/.test(s)) nodes.push({ k: 0, s });
    else nodes.push({ k: 0, s: esc(decodeEntities(s), false) });
    textStart = to;
  }
  function pushText(s) { // already-escaped or raw literal text
    nodes.push({ k: 0, s });
  }

  // Resolve a closer delimiter node: look back for a matching opener.
  // Loops so a leftover closer (e.g. ***foo*** -> strong then em) keeps matching.
  // Index of a node scanning backwards from `from`: the opener/closer are
  // always near the end of the node list, so this beats indexOf's scan
  // from the front on long documents.
  function nodeIndexBack(node, from) {
    for (let q = from; q >= 0; q--) if (nodes[q] === node) return q;
    return -1;
  }

  function processCloser(closer) {
    if (!closer.close) return;
    while (closer.n > 0) {
      let matched = false;
      const ci = nodeIndexBack(closer, nodes.length - 1);
      // candidate check (ignoring length preference)
      const valid = (opener) => {
        if (opener === closer) return false;
        if (opener.ch !== closer.ch || !opener.open) return false;
        if (closer.ch === '~') {
          if (opener.n !== closer.n) return false;
        } else {
          // rule of 3: both can open+close and (sum % 3 === 0) and not both % 3 === 0
          if (opener.open && opener.close && closer.open && closer.close) {
            const sum = opener.n + closer.n;
            if (sum % 3 === 0 && (opener.n % 3 !== 0 || closer.n % 3 !== 0)) return false;
          }
        }
        const oi = nodeIndexBack(opener, ci - 1);
        if (oi === -1 || ci === -1 || ci <= oi) return false;
        // Lookahead (marked emStrong / lastPossibleCloser): a shorter closer
        // must not consume a longer opener when a later run of the same char
        // with length >= opener.n can close it instead. The shorter closer
        // stays literal (or matches a nearer opener) and the later run
        // closes the strong. e.g. **a *b*c* d** -> the * after c does not
        // eat the ** opener; the final ** does.
        if (closer.ch !== '~' && opener.n > closer.n && closer.pos !== undefined) {
          let j = closer.pos + closer.n;
          while (j < n) {
            if (src[j] === closer.ch) {
              let run = 0;
              while (j + run < n && src[j + run] === closer.ch) run++;
              if (run >= opener.n) {
                const f2 = flank(src, j, run, false);
                const canClose2 = closer.ch === '_' ? (f2.right && (!f2.left || f2.aPu)) : f2.right;
                if (canClose2) return false;
              }
              j += run;
            } else j++;
          }
        }
        // Narrow marked lookahead rule: an outer opener cannot match this
        // closer when a strong/em element sits strictly between them whose
        // closer run is a "both" delimiter (can open and close) blocked by
        // the rule of three against this opener, and the closer cannot cover
        // the opener plus that element's opener run. (e.g. *a **b**c* stays
        // literal while *a **b** c* forms em.)
        if (closer.ch !== '~') {
          for (let q = oi + 1; q < ci; q++) {
            const nd = nodes[q];
            if (nd.k === 5 && nd.emCh === closer.ch && nd.closeBoth && !nd.openBoth &&
                nd.openPos !== undefined && opener.pos !== undefined &&
                nd.openPos > opener.pos + (opener.runLen || opener.n)) {
              const y = opener.n;
              if (y % 3 !== 0 && (y + nd.closeRun) % 3 === 0 &&
                  y + nd.openRun > closer.n && opener.n < nd.openRun) return false;
            }
          }
        }
        return true;
      };
      // pass 1: nearest opener with equal length (for a closer that can
      // also open, an even-length opener it can consume also counts).
      // pass 2 (closers that cannot open only): nearest opener, any length.
      let si = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        const opener = stack[k];
        if (!valid(opener)) continue;
        if (opener.n === closer.n) { si = k; break; }
        if (closer.open && closer.ch !== '~' && opener.n % 2 === 0 && closer.n >= opener.n) { si = k; break; }
      }
      if (si === -1 && !closer.open) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (valid(stack[k])) { si = k; break; }
        }
      }
      if (si !== -1) {
        const opener = stack[si];
        // match: use 2 if both have >= 2 (strong/del), else 1 (em/del)
        let use = 1;
        if (opener.n >= 2 && closer.n >= 2) use = 2;
        const oi = nodeIndexBack(opener, ci - 1);
        const kids = nodes.slice(oi + 1, ci);
        const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        // record the delimiter runs for the marked-style lookahead debt
        // (an opener/closer already consumed still counts in later matches)
        const el = { k: 5, tag, kids, openRun: opener.n, closeRun: closer.n, closeBoth: !!(closer.open && closer.close), emCh: closer.ch, openPos: opener.pos, openRunLen: opener.runLen, openBoth: !!(opener.open && opener.close) };
        // replace opener..closer with the element
        nodes.splice(oi, ci - oi + 1, el);
        opener.n -= use;
        closer.n -= use;
        if (opener.n > 0) {
          // leftover opener stays as a delimiter node before the element
          nodes.splice(oi, 0, opener);
        } else {
          stack.splice(si, 1);
        }
        if (closer.n > 0) {
          // leftover closer: normally stays after the element, BUT when the
          // run is attached to the preceding word (no space before it) and
          // the element already contains an em/strong kid, the leftover
          // star is content inside the element (marked emStrong debt:
          // **a *b*c*** -> <strong>a <em>b</em>c*</strong>, while
          // **foo*** -> <strong>foo</strong>* and **a *b* c*** -> ...*</p>).
          const attached = closer.pos !== undefined && closer.pos > 0 &&
            src[closer.pos - 1] !== ' ' && src[closer.pos - 1] !== '\t' && src[closer.pos - 1] !== '\n';
          const hasInnerEm = kids.some(nd => nd.k === 5);
          // the leftover star is content only when the text after the inner
          // em is contiguous (no space between the em and the closer run):
          // **a *b*c*** -> inside, **a *b* c*** -> outside (space after em)
          const lastKid = kids.length ? kids[kids.length - 1] : null;
          const contiguous = lastKid && (lastKid.k === 5 ||
            (lastKid.k === 0 && typeof lastKid.s === 'string' && lastKid.s.length > 0 && lastKid.s[0] !== ' ' && lastKid.s[0] !== '\t' && lastKid.s[0] !== '\n'));
          // ...and no unmatched opener of the same char is still on the
          // stack waiting for this star (it would close an outer em:
          // *url <strong>old</strong>* -> the * closes the outer <em>).
          const stackHasOpener = stack.some(d => d !== closer && d.ch === closer.ch && d.open);
          if (attached && hasInnerEm && contiguous && closer.n === 1 && !stackHasOpener && tag === 'strong') {
            // consume the leftover: it becomes literal text inside the
            // element (a fresh text node, not the shared delimiter node);
            // remove it from the delimiter stack so it cannot match again,
            // and zero it so the while loop stops.
            const csi2 = stack.indexOf(closer);
            if (csi2 !== -1) stack.splice(csi2, 1);
            el.kids.push({ k: 0, s: closer.ch });
            closer.n = 0;
          } else {
            // leftover closer stays in the node list after the element
            // (el is at oi, or at oi+1 if the opener was re-inserted)
            nodes.splice(oi + (opener.n > 0 ? 2 : 1), 0, closer);
          }
        } else {
          const csi = stack.indexOf(closer);
          if (csi !== -1) stack.splice(csi, 1);
        }
        matched = true;
      }
      if (!matched) break;
    }
  }

  // Try to form a link/image at src[i] ('[' or '!['). Returns the index just
  // past the link, or -1 if no link forms.
  function tryLink(i0) {
    const isImg = src[i0] === '!';
    const lb = isImg ? i0 + 1 : i0;
    if (src[lb] !== '[') return -1;
    const le = scanLabelEnd(src, lb);
    if (le === -1) return -1;
    const label = src.slice(lb + 1, le);
    if (labelHasRunawayTag(src, lb + 1, le)) return -1;
    let href = null, title = null, end = -1;
    // inline link: ]( ...
    if (src[le + 1] === '(') {
      const lp = parseLinkParens(src, le + 1);
      if (lp) {
        href = lp.dest;
        title = lp.title;
        end = lp.end;
      } else {
        // inline (...) failed: fall back to the shortcut reference [text]
        // (marked tries reflink/nolink after link fails)
        const def = links.get(normLabel(label));
        if (!def) return -1;
        href = def.href;
        title = def.title;
        end = le + 1;
      }
    } else if (src[le + 1] === '[') {
      // full reference [text][ref]  (ref may be empty => collapsed)
      const re2 = scanLabelEnd(src, le + 1);
      if (re2 === -1) return -1;
      const refRaw = src.slice(le + 2, re2);
      const ref = refRaw === '' ? label : refRaw;
      const def = links.get(normLabel(ref));
      if (!def) return -1;
      href = def.href;
      title = def.title;
      end = re2 + 1;
    } else {
      // shortcut reference [text]
      const def = links.get(normLabel(label));
      if (!def) return -1;
      href = def.href;
      title = def.title;
      end = le + 1;
    }
    // parse the label content recursively (inLink=true for links); a label
    // with no markup starter and no hard break is one escaped text node
    const cleanLabel = label.indexOf('\\') === -1 ? label : label.replace(/\\([\[\]])/g, '$1');
    let inner;
    if (!PLAIN_CHECK_RE.test(cleanLabel)) {
      inner = { nodes: [{ k: 0, s: raw ? cleanLabel : esc(decodeEntities(cleanLabel), false) }], hasLink: false, hasMdLink: false, inLink: true };
    } else {
      inner = inlineNodes(cleanLabel, links, true, raw);
    }
    if (!isImg && inner.hasMdLink) return -1; // a markdown link cannot contain a markdown link
    if (!isImg) { hasLink = true; hasMdLink = true; }
    const he = encodeHref(unescPunct(href));
    if (isImg) {
      const alt = renderText(inner.nodes);
      if (he === null) {
        pushText(esc(alt, false));
      } else {
        nodes.push({ k: 4, img: true, href: esc(he, false), title: title ? esc(unescPunct(title), false) : null, alt: esc(alt, false) });
      }
    } else {
      if (he === null) {
        // renders as its inner text only
        for (const nd of inner.nodes) nodes.push(nd);
      } else {
        nodes.push({ k: 4, img: false, href: esc(he, false), title: title ? esc(unescPunct(title), false) : null, kids: inner.nodes });
      }
    }
    return end;
  }

  while (i < n) {
    const c = src[i];
    // --- escape / hard break ------------------------------------------------
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        // hard break, unless only whitespace follows to the end
        let k = i + 2;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k < n && src[k] !== '\n' && !(k === n)) {
          // not only whitespace to the end: check the rest is not all ws
          let allWs = true;
          for (let q = k; q < n; q++) { if (!isSpace(src[q])) { allWs = false; break; } }
          if (!allWs) {
            flushText(i);
            nodes.push({ k: 3 });
            i += 2;
            while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
            textStart = i;
            continue;
          }
        }
        i += 2;
        continue;
      }
      if (d !== undefined && isAsciiPunct(d)) {
        flushText(i);
        pushText(esc(d, false));
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- hard break: 2+ spaces + newline ------------------------------------
    if (c === ' ' || c === '\t') {
      let j = i;
      let spaces = 0;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) { j++; spaces++; }
      if (j < n && src[j] === '\n' && spaces >= 2) {
        let allWs = true;
        for (let q = j + 1; q < n; q++) { if (!isSpace(src[q])) { allWs = false; break; } }
        if (!allWs) {
          flushText(i);
          nodes.push({ k: 3 });
          i = j + 1;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // --- newline: hard break if 2+ spaces/tabs immediately before --------
    // (the space-run branch below only runs when the scan lands on a space;
    // the text-run jump at the bottom skips spaces, so check the lookback
    // here too — same flush/br/skip as the space branch)
    if (c === '\n') {
      let k = i - 1, spaces = 0;
      while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) { k--; spaces++; }
      if (spaces >= 2) {
        let allWs = true;
        for (let q = i + 1; q < n; q++) { if (!isSpace(src[q])) { allWs = false; break; } }
        if (!allWs) {
          flushText(k + 1);
          nodes.push({ k: 3 });
          i = i + 1;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // --- code span -----------------------------------------------------------
    if (c === '`') {
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      // find a matching run of exactly `run` backticks
      let k = i + run;
      let found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let r2 = 0;
          while (k + r2 < n && src[k + r2] === '`') r2++;
          if (r2 === run) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found === -1 || found === i + run) {
        i += run;
        continue; // unmatched backticks are literal text
      }
      let content = src.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText(i);
      nodes.push({ k: 2, s: esc(content, true) });
      i = found + run;
      textStart = i;
      continue;
    }
    // --- link / image ---------------------------------------------------------
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      flushText(i);
      const end = tryLink(i);
      if (end !== -1) {
        i = end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- autolink / tag -------------------------------------------------------
    if (c === '<') {
      const al = scanAutolink(src, i);
      if (al) {
        flushText(i);
        const he = encodeHref(al.href);
        if (he === null) {
          pushText(esc(al.text, true));
        } else {
          nodes.push({ k: 4, img: false, autolink: true, href: esc(he, true), kids: [{ k: 0, s: esc(al.text, true) }] });
          hasLink = true;
        }
        i = al.end;
        textStart = i;
        continue;
      }
      const tag = scanTag(src, i);
      if (tag) {
        flushText(i);
        nodes.push({ k: 1, s: tag });
        // inLink state: <a ...> opens, </a> closes
        if (/^<a\s/i.test(tag)) inLink = true;
        else if (/^<\/a>/i.test(tag)) inLink = false;
        // raw mode: <pre|code|kbd|script (\s|>) opens; </...> closes
        const om = /^<(pre|code|kbd|script)(\s|>)/i.exec(tag);
        if (!raw && om) raw = true;
        else if (raw && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) raw = false;
        i += tag.length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- emphasis / del delimiter runs ----------------------------------------
    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (i + run < n && src[i + run] === c) run++;
      if (c === '~' && run >= 3) { i += run; continue; } // cannot form del
      // masked by #n (blockSkip / anyPunct): never an emphasis delimiter
      // (allocation-free: compare the run chars in place instead of slicing)
      if (maskTriggers) {
        if (masked === null) masked = maskedSource(src);
        let mOk = true;
        for (let q = 0; q < run; q++) if (masked[i + q] !== c) { mOk = false; break; }
        if (!mOk) { i += run; continue; }
      }
      const f = flank(src, i, run, c === '~');
      let canOpen, canClose;
      if (c === '_') {
        canOpen = f.left && (!f.right || f.bPu);
        canClose = f.right && (!f.left || f.aPu);
      } else {
        canOpen = f.left;
        canClose = f.right;
      }
      if (!canOpen && !canClose) { i += run; continue; }
      flushText(i);
      const node = { k: 6, ch: c, n: run, open: canOpen, close: canClose, pos: i, runLen: run };
      nodes.push(node);
      stack.push(node);
      if (canClose) processCloser(node);
      i += run;
      textStart = i;
      continue;
    }
    // --- extended autolink (GFM): scheme://, www., mailto:, xmpp: -------------
    // (scheme letters are case-insensitive: Https://, FTP://, WWW. all link)
    if (!inLink && (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'W' || c === 'm' || c === 'M' || c === 'x' || c === 'X')) {
      const u = scanUrl(src, i, inLink);
      if (u) {
        flushText(i);
        const he = encodeHref(u.href);
        if (he === null) {
          pushText(esc(u.text, true));
        } else {
          nodes.push({ k: 4, img: false, autolink: true, href: esc(he, true), kids: [{ k: 0, s: esc(u.text, true) }] });
          hasLink = true;
        }
        i = u.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- '@': possible bare email starting earlier in this text run ----------
    if (!inLink && c === '@') {
      // look back over email-local chars for the start of the local part
      let s = i;
      while (s > textStart && isEmailLocal(src[s - 1])) s--;
      BARE_EMAIL_RE.lastIndex = s;
      let em = BARE_EMAIL_RE.exec(src);
      // the lookahead may have cut the domain short because a '_' delimiter
      // run follows (email inside _..._ or __...__): retry without the
      // lookahead, but only when the longer match ends right before a '_'
      // run that has a matching opener on the delimiter stack
      BARE_EMAIL_RE_NL.lastIndex = s;
      const em2 = BARE_EMAIL_RE_NL.exec(src);
      if (em2 && s + em2[0].length > i &&
          (!em || em2[0].length > em[0].length)) {
        const after = s + em2[0].length;
        let run = 0;
        while (after + run < n && src[after + run] === '_') run++;
        if (run >= 1 && stack.some(d => d.ch === '_' && d.open && d.n >= run)) {
          em = em2;
        }
      }
      if (em && s + em[0].length > i) {
        flushText(s);
        const he = encodeHref('mailto:' + em[0]);
        if (he === null) pushText(esc(em[0], true));
        else {
          nodes.push({ k: 4, img: false, autolink: true, href: esc(he, true), kids: [{ k: 0, s: esc(em[0], true) }] });
          hasLink = true;
        }
        i = s + em[0].length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // plain char (or a trigger whose branch declined): skip ahead to the
    // next possible token starter instead of walking char by char.
    NEXT_TRIG.lastIndex = i + 1;
    const tm = NEXT_TRIG.exec(src);
    i = tm ? tm.index : n;
  }
  flushText(n);
  return { nodes, hasLink, hasMdLink, inLink };
}

// Render an inline node list to HTML, appending to a shared parts array
// so nested em/strong/link renders do not build intermediate strings.
function renderInline(nodes, parts) {
  parts = parts || [];
  for (const nd of nodes) {
    if (nd.k === 0 || nd.k === 1) parts.push(nd.s);
    else if (nd.k === 2) parts.push('<code>', nd.s, '</code>');
    else if (nd.k === 3) parts.push('<br>');
    else if (nd.k === 4) {
      if (nd.img) {
        parts.push('<img src="', nd.href, '" alt="', nd.alt, '"', nd.title ? ' title="' + nd.title + '"' : '', '>');
      } else {
        parts.push('<a href="', nd.href, '"', nd.title ? ' title="' + nd.title + '"' : '', '>');
        renderInline(nd.kids, parts);
        parts.push('</a>');
      }
    } else if (nd.k === 5) {
      parts.push('<', nd.tag, '>');
      renderInline(nd.kids, parts);
      parts.push('</', nd.tag, '>');
    } else if (nd.k === 6) {
      parts.push(nd.ch.repeat(nd.n));
    }
  }
  return parts;
}

// Render an inline node list as plain text (for image alt text).
function renderText(nodes) {
  const parts = [];
  for (const nd of nodes) {
    if (nd.k === 0) parts.push(nd.s);
    else if (nd.k === 1) parts.push(esc(nd.s, false));
    else if (nd.k === 2) parts.push(nd.s);
    else if (nd.k === 3) parts.push('');
    else if (nd.k === 4) {
      if (nd.img) parts.push(nd.alt);
      else parts.push(renderText(nd.kids));
    } else if (nd.k === 5) parts.push(renderText(nd.kids));
    else if (nd.k === 6) parts.push(nd.ch.repeat(nd.n));
  }
  return parts.join('');
}

// Chars that can start inline markup, plus URL starts (scanUrl) — if none
// of these occur and no hard break (2+ spaces/tabs before a newline) can
// occur, the paragraph is plain text: entity-decode + escape, verbatim.
const PLAIN_CHECK_RE = /[*_~`\[<\\@]|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:|[ \t]{2,}\n/i;

function parseInline(src, links, docState) {
  // marked's inline lexer state is shared across the whole document: an
  // unclosed <a ...> tag (startATag) disables extended autolinks in later
  // paragraphs until a </a> closes it. Thread docState.inLink through.
  // Fast path: no markup starter, no hard break, no tag (so inLink cannot
  // change) — the slow scan would flush the whole source as one text chunk.
  if (!PLAIN_CHECK_RE.test(src)) {
    return esc(decodeEntities(src), false);
  }
  const r = inlineNodes(src, links, docState ? docState.inLink : false, false);
  if (docState) docState.inLink = r.inLink;
  return renderInline(r.nodes, []).join('');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Block parsing (two passes: pass 1 builds the node tree and registers link
// reference definitions; pass 2 renders inline content, so a definition
// anywhere in the document applies to content anywhere else).
// ---------------------------------------------------------------------------
// Lines are used raw; indent is a tab-aware column count (tab = next multiple
// of 4). A block node is one of:
//   {t:'p', src}                 paragraph (inline source)
//   {t:'h', depth, src}          heading
//   {t:'code', lang, text}       fenced / indented code
//   {t:'hr'}                     horizontal rule
//   {t:'quote', nodes}           blockquote (inner nodes)
//   {t:'list', ordered, start, loose, items:[{nodes, task, checked}]}
//   {t:'html', html}             raw html block
//   {t:'table', header, aligns, rows}

function lineIndent(line) { return leadWidth(line); }
function lineContent(line) { return line.slice(firstNonWs(line)); }

// Remove up to `n` columns of leading whitespace. The leading tabs are
// expanded to spaces first (as marked does: leadingSpaceTab -> J), then
// `n` columns are cut; never cuts into non-whitespace content.
function stripColumns(line, n) {
  let i = 0, col = 0, out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (col <= n) return line.slice(i);
  return out.slice(n) + line.slice(i);
}
// Remove up to `n` columns of leading whitespace, like marked's
// codeRemoveIndent: a tab straddling the cut becomes spaces, but tabs
// after the cut stay tabs (fenced/indented code content keeps its tabs).
function stripIndentKeep(line, n) {
  let i = 0, col = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// --- block-start matchers (maxInd = max allowed indent, default 3) -----------
function matchFence(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return null;
  const k = firstNonWs(line);
  const ch0 = line[k];
  if (ch0 !== '`' && ch0 !== '~') return null;
  let len = 0;
  while (k + len < line.length && line[k + len] === ch0) len++;
  if (len < 3) return null;
  if (ch0 === '`' && line.indexOf('`', k + len) !== -1) return null;
  // indentLen = character length of the leading whitespace run (marked's
  // Dt removes min(leadingWsChars, fenceIndentChars) characters, not columns)
  let indentLen = 0;
  while (indentLen < line.length && (line[indentLen] === ' ' || line[indentLen] === '\t')) indentLen++;
  return { ch: ch0, len, info: line.slice(k + len), indent: ind, indentLen };
}
function matchATX(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return null;
  const k = firstNonWs(line);
  if (line[k] !== '#') return null;
  let d = 0;
  while (k + d < line.length && line[k + d] === '#') d++;
  if (d > 6) return null;
  if (k + d < line.length && line[k + d] !== ' ' && line[k + d] !== '\t') return null;
  let text = line.slice(k + d).trim();
  if (text.endsWith('#')) {
    let t = text.length;
    while (t > 0 && text[t - 1] === '#') t--;
    const before = text.slice(0, t);
    if (before === '' || before.endsWith(' ') || before.endsWith('\t')) text = before.trim();
  }
  return { depth: d, text };
}
function matchHR(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return null;
  const k = firstNonWs(line);
  const ch = line[k];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (let i = k; i < line.length; i++) {
    const x = line[i];
    if (x === ch) count++;
    else if (x !== ' ' && x !== '\t') return false;
  }
  return count >= 3;
}
function matchSetext(line) {
  const ind = lineIndent(line);
  if (ind > 3) return 0;
  const k = firstNonWs(line);
  if (k >= line.length) return 0;
  const ch = line[k];
  if (ch !== '=' && ch !== '-') return 0;
  let i = k + 1;
  while (i < line.length && line[i] === ch) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}
function matchBlockquote(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return null;
  const fk = firstNonWs(line);
  if (line[fk] !== '>') return null;
  let rest = line.slice(fk + 1);
  // expand the whitespace run after '>' (tabs to the next multiple of 4
  // from the '>' column), then drop one space
  let k = 0;
  let col = ind + 1;
  let ws = '';
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === '\t') { const s = 4 - (col % 4); ws += ' '.repeat(s); col += s; }
    else { ws += ' '; col++; }
    k++;
  }
  rest = ws + rest.slice(k);
  if (rest[0] === ' ') rest = rest.slice(1);
  return rest;
}
function matchListStart(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return null;
  const k = firstNonWs(line);
  const ch = line[k];
  if (ch === '*' || ch === '+' || ch === '-') {
    if (k + 1 < line.length && line[k + 1] !== ' ' && line[k + 1] !== '\t') return null;
    return { ordered: false, marker: ch, start: 0, markerLen: ind + 1, rest: line.slice(k + 1) };
  }
  if (ch >= '0' && ch <= '9') {
    let j = k;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j === k || j - k > 9) return null;
    if (j < line.length && (line[j] === '.' || line[j] === ')')) {
      const after = line[j + 1];
      if (after !== undefined && after !== ' ' && after !== '\t') return null;
      return { ordered: true, marker: line.slice(k, j + 1), start: parseInt(line.slice(k, j), 10), markerLen: ind + (j - k) + 1, rest: line.slice(j + 1) };
    }
  }
  return null;
}
function listInterruptsParagraph(line, inList) {
  // marked's We: marker + spaces/tabs + a non-space char. A bare marker
  // ('*', '1.') or one followed only by spaces does NOT interrupt.
  // An ordered list interrupts a paragraph only when it starts with 1,
  // EXCEPT inside a list item (where the paragraph is a text token and
  // any start number interrupts).
  const m = matchListStart(line);
  if (!m) return false;
  if (m.ordered && m.start !== 1 && !inList) return false;
  const r = m.rest;
  if (r === '') return false;
  if (r[0] !== ' ' && r[0] !== '\t') return false;
  let k = 0;
  while (k < r.length && (r[k] === ' ' || r[k] === '\t')) k++;
  return k < r.length;
}

// --- html block --------------------------------------------------------------
function tryHtmlBlock(lines, i) {
  const line = lines[i];
  const ind = lineIndent(line);
  if (ind > 3) return null;
  const c = lineContent(line);
  if (c[0] !== '<') return null;
  const n = lines.length;
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(c);
  if (m1) {
    const tag = m1[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '>', 'i');
    let j = i;
    for (; j < n; j++) {
      if (closeRe.test(lines[j])) { j++; break; }
    }
    return { type: 1, html: lines.slice(i, j).join('\n') + ((j < n && (j === n - 1 || lines[j] !== '')) ? '\n' : ''), consumed: j - i };
  }
  if (c.startsWith('<!--')) {
    let j = i;
    for (; j < n; j++) {
      if (lines[j].indexOf('-->') !== -1) { j++; break; }
    }
    return { type: 2, html: lines.slice(i, j).join('\n') + ((j < n && (j === n - 1 || lines[j] !== '')) ? '\n' : ''), consumed: j - i };
  }
  if (c.startsWith('<?')) {
    let j = i;
    for (; j < n; j++) {
      if (lines[j].indexOf('?>') !== -1) { j++; break; }
    }
    return { type: 3, html: lines.slice(i, j).join('\n') + ((j < n && (j === n - 1 || lines[j] !== '')) ? '\n' : ''), consumed: j - i };
  }
  if (c.startsWith('<!') && c.length > 2 && /[A-Za-z]/.test(c[2])) {
    let j = i;
    for (; j < n; j++) {
      if (lines[j].indexOf('>') !== -1) { j++; break; }
    }
    return { type: 4, html: lines.slice(i, j).join('\n') + ((j < n && (j === n - 1 || lines[j] !== '')) ? '\n' : ''), consumed: j - i };
  }
  if (c.startsWith('<![CDATA[')) {
    let j = i;
    for (; j < n; j++) {
      if (lines[j].indexOf(']]>') !== -1) { j++; break; }
    }
    return { type: 5, html: lines.slice(i, j).join('\n') + ((j < n && (j === n - 1 || lines[j] !== '')) ? '\n' : ''), consumed: j - i };
  }
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)((?:[ \t]+|\/?>|$))/.exec(c);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    let j = i + 1;
    for (; j < n; j++) {
      if (isBlankLine(lines[j])) break;
    }
    // type 6 ends at a blank line: no trailing newline from the terminator;
    // only keep one when the block runs to the document's final empty line
    return { type: 6, html: lines.slice(i, j).join('\n') + ((j === n - 1) ? '\n' : ''), consumed: j - i };
  }
  // type 7: a complete open tag (not script/pre/style/textarea) or close
  // tag, alone on its line (marked's Ue; attribute grammar is strict:
  // name [a-zA-Z:_][\w.:-]*, optional = value, quoted or unquoted)
  const ATTR7 = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"]*"| *= *\'[^\']*\'| *= *[^\\s"\'=<>`]+)?';
  const m7o = new RegExp('^<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:' + ATTR7 + ')*? *\\/?>[ \\t]*$', 'i').exec(c);
  const m7c = /^<\/([a-z][a-z0-9-]*)\s*>[ \t]*$/i.exec(c);
  const m7 = m7o || m7c;
  if (m7) {
    const name = m7[1].toLowerCase();
    if (!BLOCK_TAGS.has(name)) {
      let j = i + 1;
      for (; j < n; j++) {
        if (isBlankLine(lines[j])) break;
      }
      return { type: 7, html: lines.slice(i, j).join('\n') + ((j === n - 1) ? '\n' : ''), consumed: j - i };
    }
  }
  return null;
}
function htmlInterruptsParagraph(line, maxInd) {
  const ind = lineIndent(line);
  if (ind > (maxInd === undefined ? 3 : maxInd)) return false;
  const k = firstNonWs(line);
  if (line[k] !== '<') return false;
  const c = line.slice(k);
  if (/^<(script|pre|style|textarea)(?:[\s>]|$)/i.test(c)) return true;
  if (c.startsWith('<!--')) return true;
  if (c.startsWith('<?')) return true;
  if (c.startsWith('<!') && c.length > 2 && /[A-Za-z]/.test(c[2])) return true;
  if (c.startsWith('<![CDATA[')) return true;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)((?:[ \t]+|\/?>|$))/.exec(c);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return true;
  return false;
}

// --- link reference definition ------------------------------------------------
function scanDefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') return j + 1;
    if (c === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= n || src[k] === '\n') return -1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}
function tryDef(lines, i, links) {
  const line = lines[i];
  if (lineIndent(line) > 3) return null;
  const c = lineContent(line);
  if (c[0] !== '[') return null;
  // join up to 8 non-blank lines (a def's title may span lines; a blank
  // line ends it). `consumed` is computed from the final position.
  let src = c;
  let k = i + 1;
  while (k < lines.length && k < i + 8 && !isBlankLine(lines[k])) { src += '\n' + lines[k]; k++; }
  const le = scanDefLabel(src, 0);
  if (le === -1) return null;
  const label = src.slice(1, le - 1);
  if (label.trim() === '') return null;
  let j = le;
  if (src[j] !== ':') return null;
  j++;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] === '\n') {
    j++;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  }
  if (j >= src.length) return null;
  let dest = '';
  if (src[j] === '<') {
    const gt = src.indexOf('>', j + 1);
    if (gt === -1) return null;
    if (src.slice(j + 1, gt).indexOf('\n') !== -1) return null;
    dest = src.slice(j + 1, gt);
    if (parenCheck(dest) !== -1) return null;
    j = gt + 1;
  } else {
    let m = j;
    while (m < src.length && src[m] !== ' ' && src[m] !== '\t' && src[m] !== '\n') m++;
    if (m === j) return null;
    dest = src.slice(j, m);
    j = m;
  }
  const destEnd = j;
  // try a title (marked's Fe: separator required before the title; the
  // title may span lines for '...' but not for "..."). If the title is
  // malformed or followed by garbage, fall back to no title and end the
  // def right after the dest (regex backtracking).
  let title = null;
  let end = -1;
  {
    let sp = j;
    let hadSep = false;
    // separator: spaces (optionally + newline + spaces) or newline + spaces
    let spc = 0;
    while (sp < src.length && (src[sp] === ' ' || src[sp] === '\t')) { sp++; spc++; }
    if (src[sp] === '\n') {
      sp++;
      while (sp < src.length && (src[sp] === ' ' || src[sp] === '\t')) sp++;
      hadSep = true;
    } else if (spc > 0) {
      hadSep = true;
    }
    if (hadSep && sp < src.length && (src[sp] === '"' || src[sp] === "'" || src[sp] === '(')) {
      const q = src[sp];
      const close = q === '(' ? ')' : q;
      let m = sp + 1;
      let ok = false;
      while (m < src.length) {
        const ch = src[m];
        if (ch === '\\') { m += 2; continue; }
        if (ch === '\n' && q === '"') break; // "..." may not span lines
        if (ch === '\n') {
          // '...' and (...) may span one \n but not \n\n
          if (src[m + 1] === '\n') break;
        }
        if (ch === close) { ok = true; break; }
        m++;
      }
      if (ok) {
        let e = m + 1;
        while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
        if (e >= src.length || src[e] === '\n') {
          title = src.slice(sp + 1, m);
          end = e;
        }
      }
    }
  }
  if (end === -1) {
    // no (valid) title: end right after the dest
    let e = destEnd;
    while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
    if (e < src.length && src[e] !== '\n') return null;
    end = e;
  }
  const consumed = src.slice(0, end).split('\n').length;
  const norm = normLabel(label);
  if (!links.has(norm)) {
    links.set(norm, { href: unescPunct(dest), title: title === null ? null : unescPunct(title) });
  }
  return { consumed };
}

// --- table --------------------------------------------------------------------
// marked's de(): a '|' preceded by an odd run of backslashes is an escaped
// pipe (kept, no split); otherwise it is a delimiter. Cells are trimmed
// and '\|' is unescaped to '|' (even inside code spans).
function splitTableRow(row, count) {
  // split on unescaped '|' (a '|' preceded by an odd run of backslashes
  // is escaped and stays, via the \\| -> | replace below); collect cell
  // boundaries by slicing instead of rebuilding the row char by char.
  const cells = [];
  const n = row.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    if (row[i] === '|') {
      let bs = 0, p = i - 1;
      while (p >= 0 && row[p] === '\\') { bs++; p--; }
      if (bs % 2 === 0) { cells.push(row.slice(start, i)); start = i + 1; }
    }
    i++;
  }
  cells.push(row.slice(start));
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    while (cells.length < count) cells.push('');
    if (cells.length > count) cells.length = count;
  }
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k].trim();
    cells[k] = cell.indexOf('\\|') === -1 ? cell : cell.replace(/\\\|/g, '|');
  }
  return cells;
}
function tryTable(lines, i) {
  const header = lines[i];
  if (isBlankLine(header)) return null;
  if (i + 1 >= lines.length) return null;
  const delim = lines[i + 1];
  if (lineIndent(delim) > 3) return null;
  // a delimiter row's first cell starts with |, : or - (cells are :?-+:?)
  const dk = firstNonWs(delim);
  const dc = delim[dk];
  if (dc !== '|' && dc !== ':' && dc !== '-') return null;
  const d = lineContent(delim);
  if (d.indexOf(':') === -1 && d.indexOf('|') === -1) return null;
  const hCells = splitTableRow(lineContent(header).trim());
  const dCells = splitTableRow(d);
  if (hCells.length !== dCells.length) return null;
  for (const cell of dCells) {
    if (!/^:?-+:?$/.test(cell)) return null;
  }
  const aligns = dCells.map(cell => {
    if (/^:.*:$/.test(cell)) return 'center';
    if (/^.*:$/.test(cell)) return 'right';
    if (/^:/.test(cell)) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln === '') break; // a truly empty line ends the table
    if (isBlankLine(ln)) {
      // a whitespace-only line holding a tab is an empty table row (the
      // tab expands to content); a spaces-only line ends the table
      if (ln.indexOf('\t') === -1) break;
      rows.push(splitTableRow('', hCells.length));
      j++;
      continue;
    }
    if (matchATX(ln) || matchFence(ln) || matchHR(ln) || matchBlockquote(ln) || matchListStart(ln) || htmlInterruptsParagraph(ln)) break;
    if (lineIndent(ln) >= 4) break;
    rows.push(splitTableRow(lineContent(ln).trim(), hCells.length));
    j++;
  }
  return { header: hCells, aligns, rows, consumed: j - i };
}

// --- the block parser (pass 1) --------------------------------------------------
// Does the last node of a node list end in a paragraph, recursing into
// nested blockquotes and lists? (marked's blockquote() re-parses trailing
// lines into the last blockquote/list token.)
function lastEndsInParagraph(nodes) {
  if (nodes.length === 0) return false;
  const last = nodes[nodes.length - 1];
  if (last.t === 'p') return true;
  if (last.t === 'quote') return lastEndsInParagraph(last.nodes);
  if (last.t === 'list') {
    if (last.items.length === 0) return false;
    return lastEndsInParagraph(last.items[last.items.length - 1].nodes);
  }
  return false;
}

// `nested` = inside a list item or blockquote (marked's state.top == false
// for list items; blockquotes re-parse lazy lines as separate chunks).
// In nested context a paragraph continuation line indented >= 4 is an
// indented code block that merges into the paragraph with 4 columns
// stripped; at the top level the spaces are kept.
function blockNodes(lines, links, nested, inList) {
  const nodes = [];
  let hadBlank = false;
  let seenBlock = false;
  let pendingBlank = false;
  const n = lines.length;
  let i = 0;

  function emit(node) {
    if (pendingBlank && seenBlock) hadBlank = true;
    pendingBlank = false;
    seenBlock = true;
    nodes.push(node);
  }
  function interruptsParagraph(line) {
    const ik = firstNonWs(line);
    const ich = line[ik];
    if (ich !== '`' && ich !== '~' && ich !== '#' && ich !== '-' && ich !== '_' && ich !== '*' && ich !== '>' && ich !== '+' && ich !== '<' && !(ich >= '0' && ich <= '9')) return false;
    if (matchATX(line) || matchFence(line) || matchHR(line) || matchBlockquote(line)) return true;
    if (listInterruptsParagraph(line, inList)) return true;
    if (htmlInterruptsParagraph(line)) return true;
    return false;
  }

  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { pendingBlank = true; i++; continue; }
    const ind = lineIndent(line);
    // first-char dispatch: each block matcher can only match a line whose
    // first non-ws char is in its own set; skip the ones that cannot match
    const fk = firstNonWs(line);
    const ch0 = line[fk];

    const fence = (ch0 === '`' || ch0 === '~') ? matchFence(line) : null;
    if (fence) {
      let j = i + 1;
      const content = [];
      for (; j < n; j++) {
        const l2 = lines[j];
        const ind2 = lineIndent(l2);
        const c2 = lineContent(l2);
        if (ind2 <= 3 && c2[0] === fence.ch) {
          let len2 = 0;
          while (len2 < c2.length && c2[len2] === fence.ch) len2++;
          if (len2 >= fence.len) {
            let ok = true;
            for (let q = len2; q < c2.length; q++) {
              if (c2[q] !== ' ' && c2[q] !== '\t') { ok = false; break; }
            }
            if (ok) break;
          }
        }
        // marked's Dt (indentCodeCompensation matches only ```, so this
        // dedent applies to backtick fences only; ~~~ fences keep content
        // verbatim): remove min(leading whitespace chars, fence indent
        // chars) from the start of each content line (character count, so
        // a leading tab is removed whole when the fence is indented)
        if (fence.ch === '`') {
          let ws = 0;
          while (ws < l2.length && (l2[ws] === ' ' || l2[ws] === '\t')) ws++;
          content.push(l2.slice(Math.min(ws, fence.indentLen)));
        } else {
          content.push(l2);
        }
      }
      const lang = fence.info.trim() ? unescPunct(fence.info.trim()).split(/\s+/)[0] : '';
      let text = content.join('\n');
      text = text === '' ? '' : text.replace(/\n$/, '') + '\n';
      emit({ t: 'code', lang, text });
      i = j + (j < n ? 1 : 0);
      continue;
    }

    const atx = ch0 === '#' ? matchATX(line) : null;
    if (atx) {
      emit({ t: 'h', depth: atx.depth, src: atx.text });
      i++;
      continue;
    }

    if ((ch0 === '-' || ch0 === '_' || ch0 === '*') && matchHR(line)) {
      emit({ t: 'hr' });
      i++;
      continue;
    }

    if (ch0 === '>' && matchBlockquote(line) !== null) {
      const qLines = [];
      let j = i;
      let prevEmptyQuote = false;
      // The ends-in-paragraph re-parse is only needed after a '>' line
      // pushed new content: a lazy line appended to a quote that ends in
      // a paragraph keeps it a paragraph (it becomes paragraph text, or a
      // setext line pushed indented so it cannot close the paragraph).
      let needRecheck = true;
      let lastEndsPara = false;
      while (j < n) {
        const l2 = lines[j];
        const stripped = matchBlockquote(l2);
        if (stripped !== null) {
          // an empty '>' line (blank content) breaks lazy continuation
          prevEmptyQuote = stripped.trim() === '';
          qLines.push(stripped);
          needRecheck = true;
          j++;
          continue;
        }
        if (isBlankLine(l2)) break; // a blank line with no '>' ends the quote
        if (prevEmptyQuote) break; // after an empty '>' a lazy line ends the quote
        // lazy continuation: the quote so far must end in a paragraph
        // (possibly inside a nested blockquote/list) and the line must be
        // a paragraph continuation
        if (needRecheck) {
          const sub = blockNodes(qLines, links, true, inList);
          lastEndsPara = lastEndsInParagraph(sub.nodes);
          needRecheck = false;
        }
        if (!lastEndsPara) break;
        if (interruptsParagraph(l2)) break;
        const st = matchSetext(l2);
        if (st) qLines.push('    ' + lineContent(l2).trim());
        else qLines.push(l2);
        j++;
      }
      // drop trailing empty lines; a trailing whitespace-only line is kept
      // when the quote runs to EOF (it is paragraph text, cm-241) — only
      // pop it when real (non-blank) content follows the quote
      while (qLines.length > 0 && qLines[qLines.length - 1] === '') qLines.pop();
      let hasMore = false;
      for (let q = j; q < n; q++) { if (!isBlankLine(lines[q])) { hasMore = true; break; } }
      if (hasMore) {
        while (qLines.length > 0 && isBlankLine(qLines[qLines.length - 1])) qLines.pop();
      }
      const inner = blockNodes(qLines, links, true, inList);
      emit({ t: 'quote', nodes: inner.nodes });
      i = j;
      continue;
    }

    if ((ch0 === '*' || ch0 === '+' || ch0 === '-' || (ch0 >= '0' && ch0 <= '9')) && matchListStart(line) && !matchHR(line)) {
      const res = parseList(lines, i, links);
      if (res) {
        emit(res.node);
        // a blank line consumed at the end of the list still counts as a
        // blank separator before the next block (loose detection)
        if (res.trailingBlank) pendingBlank = true;
        i += res.consumed;
        continue;
      }
    }

    const hb = ch0 === '<' ? tryHtmlBlock(lines, i) : null;
    if (hb) {
      emit({ t: 'html', html: hb.html });
      i += hb.consumed;
      continue;
    }

    const def = ch0 === '[' ? tryDef(lines, i, links) : null;
    if (def) {
      // a definition is a block (emits no node) but still counts as a
      // block boundary for blank-line / loose tracking
      if (pendingBlank && seenBlock) hadBlank = true;
      pendingBlank = false;
      seenBlock = true;
      i += def.consumed;
      continue;
    }

    const tbl = tryTable(lines, i);
    if (tbl) {
      emit({ t: 'table', header: tbl.header, aligns: tbl.aligns, rows: tbl.rows });
      i += tbl.consumed;
      continue;
    }

    if (ind >= 4) {
      const codeLines = [];
      let j = i;
      while (j < n) {
        const l2 = lines[j];
        if (isBlankLine(l2)) {
          let k = j + 1;
          while (k < n && isBlankLine(lines[k])) k++;
          if (k < n && lineIndent(lines[k]) >= 4) { codeLines.push(stripIndentKeep(l2, 4)); j++; continue; }
          break;
        }
        if (lineIndent(l2) >= 4) { codeLines.push(stripIndentKeep(l2, 4)); j++; continue; }
        break;
      }
      let text = trimTrailingBlankLines(codeLines.join('\n'));
      text = text === '' ? '' : text.replace(/\n$/, '') + '\n';
      emit({ t: 'code', lang: '', text });
      i = j;
      continue;
    }

    // paragraph
    const para = [line];
    let j = i + 1;
    let heading = null;
    while (j < n) {
      const l2 = lines[j];
      if (isBlankLine(l2)) {
        // a trailing whitespace-only line at the very end is paragraph
        // text (marked's ae: '[ \t]+\n' ends a paragraph, but at EOF the
        // spaces are kept, cm-241)
        if (l2.length > 0 && j === n - 1) { para.push(l2); j++; }
        break;
      }
      const st = matchSetext(l2);
      if (st) { heading = st; j++; break; }
      if (interruptsParagraph(l2)) break;
      if (nested && lineIndent(l2) >= 4) {
        const stripped = stripIndentKeep(l2, 4);
        // a setext underline produced by blockquoteSetextReplace ('    ===')
        // keeps its spaces (it is not an indented-code merge)
        // strip the 4 columns only when the line is inside a list item, or
        // when the stripped line starts a new block (e.g. a list item);
        // a plain-text continuation inside a (nested) blockquote keeps them
        const startsBlock = matchListStart(stripped) || matchATX(stripped) || matchFence(stripped) || matchHR(stripped) || matchBlockquote(stripped) !== null || htmlInterruptsParagraph(stripped);
        para.push(matchSetext(stripped) ? l2 : (inList || startsBlock ? stripped : l2));
      } else {
        para.push(l2);
      }
      j++;
    }
    if (heading) {
      emit({ t: 'h', depth: heading, src: para.join('\n').trim() });
    } else {
      emit({ t: 'p', src: para.join('\n') });
    }
    i = j;
  }
  return { nodes, hadBlank };
}

// --- lists (pass 1) --------------------------------------------------------------
const TASK_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_STRIP_RE = /^\[[ xX]\][ \t]+/;
function parseList(lines, start, links) {
  const first = matchListStart(lines[start]);
  if (!first) return null;
  const ordered = first.ordered;
  const delim = first.marker.slice(-1);
  const n = lines.length;
  const items = [];
  let i = start;

  while (i < n) {
    const line = lines[i];
    if (matchHR(line)) break;
    const m = matchListStart(line);
    if (!m || m.ordered !== ordered) break;
    if (ordered) {
      if (m.marker.slice(-1) !== delim) break;
    } else {
      if (m.marker !== first.marker) break;
    }
    const markerLen = m.markerLen;
    const rest = m.rest;
    // expand the leading whitespace of the rest relative to the marker end
    let mExp = rest;
    {
      let k = 0;
      while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
      if (k > 0) {
        let col = markerLen;
        let out = '';
        for (let q = 0; q < k; q++) {
          if (rest[q] === '\t') { const s = 4 - (col % 4); out += ' '.repeat(s); col += s; }
          else { out += ' '; col++; }
        }
        mExp = out + rest.slice(k);
      }
    }
    const empty = mExp.trim() === '';
    let R, d, origSp = 0;
    if (empty) {
      R = markerLen + 1;
      d = '';
    } else {
      let sp = 0;
      while (sp < mExp.length && mExp[sp] === ' ') sp++;
      origSp = sp;
      if (sp > 4) sp = 1;
      d = mExp.slice(sp);
      R = markerLen + sp;
    }
    i++;
    let u = false;
    if (empty && i < n && isBlankLine(lines[i])) { i++; u = true; }
    const contentLines = [];
    if (!u && !(empty && d === '')) contentLines.push(d);
    // an empty item that consumed a following blank line has a trailing
    // blank (counts for loose detection)
    let trailingBlank = u;
    if (!u) {
      // previous line's content leading-space count (first line: the
      // original count before the >4 cap); a lazy line ends the item if
      // that count is >= 4
      // marked's block-start checks inside a list item use D(R) =
      // clamp(R-1, 0, 3) as the max indent, not R.
      const maxInd = Math.max(0, Math.min(3, R - 1));
      let prevIndent = origSp;
      let prevBlank = false;
      while (i < n) {
        const l2 = lines[i];
        const ind2 = lineIndent(l2);
        const k2 = firstNonWs(l2);
        const ch2 = l2[k2];
        if ((ch2 === '`' || ch2 === '~' || ch2 === '#' || ch2 === '-' || ch2 === '_' || ch2 === '*' || ch2 === '>' || ch2 === '+' || ch2 === '<' || (ch2 >= '0' && ch2 <= '9')) &&
            (matchFence(l2, maxInd) || matchATX(l2, maxInd) || htmlInterruptsParagraph(l2, maxInd) ||
            matchBlockquote(l2, maxInd) || matchListStart(l2, maxInd) || matchHR(l2, maxInd))) break;
        if (ind2 >= R || isBlankLine(l2)) {
          const ded = stripColumns(l2, R);
          contentLines.push(ded);
          trailingBlank = isBlankLine(l2);
          prevBlank = isBlankLine(l2);
          let q = 0;
          while (q < ded.length && ded[q] === ' ') q++;
          prevIndent = q;
          i++;
          continue;
        }
        // less indent, not blank: lazy continuation or the item ends.
        // After a blank line a lazy line does NOT continue the item.
        // If the item's content ends with an (unclosed) fence opener, a
        // lazy line cannot be its content: the fence stays empty and the
        // lazy line starts a new block outside the item.
        if (empty || prevBlank || prevIndent >= 4) break;
        if (contentLines.length > 0 && matchFence(contentLines[contentLines.length - 1])) break;
        const st = matchSetext(l2);
        if (st) {
          const sub = blockNodes(contentLines, links, true, true);
          const last = sub.nodes[sub.nodes.length - 1];
          if (last && last.t === 'p') contentLines.push('    ' + lineContent(l2).trim());
          else break;
        } else {
          contentLines.push(l2);
        }
        // a lazy line is a paragraph continuation, not indented code: the
        // next lazy line must also continue (do not let its own indent
        // trip the prevIndent >= 4 break below)
        prevIndent = 0;
        prevBlank = false;
        trailingBlank = false;
        i++;
      }
    }
    while (contentLines.length > 0 && isBlankLine(contentLines[contentLines.length - 1])) contentLines.pop();
    items.push({ lines: contentLines, trailingBlank });
  }
  if (items.length === 0) return null;
  // task checkbox: strip it from the first content line before parsing
  const parsed = items.map(it => {
    let task = false, checked = false;
    if (it.lines.length > 0 && TASK_RE.test(it.lines[0])) {
      task = true;
      checked = /^\[[xX]\]/.test(it.lines[0]);
      it.lines[0] = it.lines[0].replace(TASK_STRIP_RE, '');
    }
    const sub = blockNodes(it.lines, links, true, true);
    return { nodes: sub.nodes, hadBlank: sub.hadBlank, trailingBlank: it.trailingBlank, task, checked };
  });
  let loose = false;
  for (let k = 0; k < parsed.length; k++) {
    if (parsed[k].hadBlank) loose = true;
    if (k < parsed.length - 1 && parsed[k].trailingBlank) loose = true;
  }
  const node = { t: 'list', ordered, start: first.start, loose, items: parsed };
  // whether the list consumed trailing blank lines (the last item's
  // trailing blank) — the caller needs it for loose/blank tracking
  const lastTrailing = parsed.length > 0 && items[items.length - 1].trailingBlank;
  return { node, consumed: i - start, trailingBlank: lastTrailing };
}

// --- rendering (pass 2) ------------------------------------------------------------
function renderBlockNodes(nodes, links, paraAsP, docState) {
  if (!docState) docState = { inLink: false };
  const parts = [];
  for (const nd of nodes) {
    if (nd.t === 'p') {
      const inner = parseInline(nd.src, links, docState);
      if (paraAsP) parts.push('<p>', inner, '</p>\n'); else parts.push(inner);
    } else if (nd.t === 'h') {
      parts.push('<h', nd.depth, '>', parseInline(nd.src, links, docState), '</h', nd.depth, '>\n');
    } else if (nd.t === 'code') {
      parts.push('<pre><code');
      if (nd.lang) parts.push(' class="language-', esc(nd.lang, false), '"');
      parts.push('>', esc(nd.text, true), '</code></pre>\n');
    } else if (nd.t === 'hr') {
      parts.push('<hr>\n');
    } else if (nd.t === 'quote') {
      parts.push('<blockquote>\n', renderBlockNodes(nd.nodes, links, true, docState), '</blockquote>\n');
    } else if (nd.t === 'html') {
      parts.push(nd.html);
    } else if (nd.t === 'table') {
      parts.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < nd.header.length; k++) {
        parts.push(nd.aligns[k] ? '<th align="' + nd.aligns[k] + '">' : '<th>');
        parts.push(parseInline(nd.header[k], links, docState), '</th>\n');
      }
      parts.push('</tr>\n</thead>\n');
      if (nd.rows.length > 0) {
        parts.push('<tbody>');
        for (const row of nd.rows) {
          parts.push('<tr>\n');
          for (let k = 0; k < row.length; k++) {
            parts.push(nd.aligns[k] ? '<td align="' + nd.aligns[k] + '">' : '<td>');
            parts.push(parseInline(row[k], links, docState), '</td>\n');
          }
          parts.push('</tr>\n');
        }
        parts.push('</tbody>');
      }
      parts.push('</table>\n');
    } else if (nd.t === 'list') {
      const cb = (checked) => '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      parts.push(nd.ordered ? '<ol' + (nd.start !== 1 ? ' start="' + nd.start + '"' : '') + '>\n' : '<ul>\n');
      for (const it of nd.items) {
        parts.push('<li>');
        if (it.task) {
          if (nd.loose) {
            if (it.nodes.length > 0 && it.nodes[0].t === 'p') {
              const first = it.nodes[0];
              parts.push(renderBlockNodes([{ t: 'p', src: cb(it.checked) + first.src }].concat(it.nodes.slice(1)), links, true, docState));
            } else {
              parts.push('<p>', cb(it.checked), '</p>\n', renderBlockNodes(it.nodes, links, true, docState));
            }
          } else {
            parts.push(cb(it.checked), renderBlockNodes(it.nodes, links, false, docState));
          }
        } else {
          parts.push(renderBlockNodes(it.nodes, links, nd.loose, docState));
        }
        parts.push('</li>\n');
      }
      parts.push(nd.ordered ? '</ol>\n' : '</ul>\n');
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(src) {
  if (src === '') return '';
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n|\r/g, '\n');
  const links = new Map();
  const lines = src.split('\n');
  const { nodes } = blockNodes(lines, links);
  return renderBlockNodes(nodes, links, true);
}

export default parse;
