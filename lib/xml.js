// Tiny XML reader for manifests: Elements, attributes, text, CDATA, comments and the standard
// entities. Enough for the manifest format, no dependencies. Returns { name, attrs, children, text }.
'use strict';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parse(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { top().text += decode(xml.slice(i)); break; }
    if (lt > i) top().text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt); top().text += xml.slice(lt + 9, e < 0 ? xml.length : e); i = e < 0 ? xml.length : e + 3; continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') { const e = xml.indexOf('>', lt); i = e < 0 ? xml.length : e + 1; continue; }
    const gt = findTagEnd(xml, lt);
    if (gt < 0) throw new Error(`unclosed tag at ${lt}`);
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      // Close up to the matching tag, so small mistakes in hand-written manifests don't break it
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const el = { name: m[1], attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(body.slice(m[1].length)))) el.attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
    top().children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

function findTagEnd(xml, from) {
  let q = null;
  for (let k = from + 1; k < xml.length; k++) {
    const c = xml[k];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return k;
  }
  return -1;
}

// Helpers: First child by name (case-insensitive), all children by name
const child = (el, name) => el && el.children.find((c) => c.name.toLowerCase() === name.toLowerCase());
const all = (el, name) => (el ? el.children.filter((c) => c.name.toLowerCase() === name.toLowerCase()) : []);

module.exports = { parse, child, all };
