// News for the News card, from whatever the manifest points at (same as Tequila, LaunchCat
// and Homecoming's launcher).
//
//   <launch ... motd="https://.../motd.txt">  a message of the day (plain text: Thunderspy)
//   <webpage>https://...</webpage>            the page Tequila shows; when it's an RSS or Atom
//                                             feed, or names one (<link rel="alternate">), its
//                                             posts; otherwise its headings and first paragraphs
//   a feed they added themselves (News Feed in Settings)
//   a JSON news feed like newsfeed.homecomingservers.com/live: posts with headline, headlinelink,
//   dateline and content (strings and styled text bits)
//
// It's all text: No web pages inside the launcher and no scripts. Links open in the browser.
'use strict';

const { parse, child, all } = require('./xml');

const UA = { 'user-agent': 'IncarnateLauncher/0.2 (+news)' };
const MAX = 512 * 1024;
const text = (el) => (el ? el.text.trim() : '');

async function get(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.text()).slice(0, MAX);
    return { body, type: r.headers.get('content-type') || '', url: r.url || url };
  } finally { clearTimeout(t); }
}

// HTML to plain text: Strip tags, decode entities, squash whitespace
function strip(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trim()}...` : s);
const http = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

function absolute(u, base) { try { return new URL(u, base).toString(); } catch { return ''; } }

// RSS 2.0 or Atom, up to 8 posts
function readFeed(xml, base) {
  let root;
  try { root = parse(xml); } catch { return null; }
  const rss = child(root, 'rss');
  const feed = child(root, 'feed');
  if (rss) {
    const ch = child(rss, 'channel');
    return {
      title: text(child(ch, 'title')),
      items: all(ch, 'item').slice(0, 8).map((it) => ({
        title: strip(text(child(it, 'title'))), link: http(absolute(text(child(it, 'link')), base)),
        date: text(child(it, 'pubDate')), summary: short(strip(text(child(it, 'description'))), 300),
      })),
    };
  }
  if (feed) {
    return {
      title: text(child(feed, 'title')),
      items: all(feed, 'entry').slice(0, 8).map((e) => {
        const l = all(e, 'link').find((x) => !x.attrs.rel || x.attrs.rel === 'alternate');
        return { title: strip(text(child(e, 'title'))), link: http(absolute(l ? l.attrs.href : '', base)),
          date: text(child(e, 'updated')) || text(child(e, 'published')),
          summary: short(strip(text(child(e, 'summary')) || text(child(e, 'content'))), 300) };
      }),
    };
  }
  return null;
}

// A web page: Use its feed if it links one, otherwise its title, headings and first paragraphs
async function readPage(url) {
  const r = await get(url);
  const looksXml = /xml|rss|atom/i.test(r.type) || /^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(r.body.slice(0, 400));
  if (looksXml) {
    const f = readFeed(r.body, r.url);
    if (f) return { kind: 'feed', url: r.url, ...f };
  }
  const link = r.body.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/i);
  const href = link && (link[0].match(/href=["']([^"']+)["']/i) || [])[1];
  if (href) {
    try {
      const f2 = await get(absolute(href, r.url));
      const f = readFeed(f2.body, f2.url);
      if (f) return { kind: 'feed', url: r.url, ...f };
    } catch { /* just use the page then */ }
  }
  if (/text\/plain/i.test(r.type)) return { kind: 'text', url: r.url, text: short(r.body.trim(), 2000) };
  const title = strip((r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const blocks = [];
  const re = /<(h[1-3]|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(r.body)) && blocks.length < 10) {
    const t = strip(m[2]);
    if (t.length > 2) blocks.push({ heading: /^h/i.test(m[1]), text: short(t, 300) });
  }
  return { kind: 'page', url: r.url, title, blocks };
}

// JSON news feed (Homecoming's format): Headline, link, date and the text in order with the
// styling dropped. Up to 8 posts
async function readJsonNews(url) {
  const r = await get(url);
  let j;
  try { j = JSON.parse(r.body); } catch { throw new Error('not JSON'); }
  if (!Array.isArray(j)) throw new Error('not a list of posts');
  const textOf = (c) => {
    if (typeof c === 'string') return c;
    if (!c || typeof c !== 'object') return '';
    return [typeof c.text === 'string' ? c.text : '', ...(Array.isArray(c.list) ? c.list.map(textOf) : [])].filter(Boolean).join('\n');
  };
  const items = j.filter((x) => x && typeof x.headline === 'string').slice(0, 8).map((x) => ({
    title: strip(x.headline), link: http(x.headlinelink || ''), date: typeof x.dateline === 'string' ? x.dateline.replace(/\s+/g, ' ').trim() : '',
    summary: short((Array.isArray(x.content) ? x.content.map(textOf) : []).map((t) => t.trim()).filter(Boolean).join('\n'), 600),
  }));
  return { kind: 'feed', url: r.url, title: 'News', items };
}

// News for one server: { motd, sections: [...], errors: [...] }
async function fetchNews({ manifest, profile, feed, newsJson }) {
  const out = { motd: '', sections: [], errors: [], at: Date.now() };
  const jobs = [];
  if (profile && http(profile.motd)) {
    jobs.push(get(profile.motd).then((r) => { out.motd = short(/html/i.test(r.type) ? strip(r.body) : r.body.trim(), 2000); })
      .catch((e) => out.errors.push(`Message of the day: ${e.message}`)));
  }
  if (http(newsJson)) {
    jobs.push(readJsonNews(newsJson).then((sec) => out.sections.unshift(sec)).catch((e) => out.errors.push(`${new URL(newsJson).host}: ${e.message}`)));
  }
  const pages = [...new Set([http(feed), http(manifest && manifest.webpage)].filter(Boolean))];
  for (const u of pages) {
    jobs.push(readPage(u).then((s) => out.sections.push(s)).catch((e) => out.errors.push(`${new URL(u).host}: ${e.message}`)));
  }
  await Promise.all(jobs);
  return out;
}

module.exports = { fetchNews, readFeed, readJsonNews, strip };
