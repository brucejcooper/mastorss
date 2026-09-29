// Turns Mastodon status JSON into DOM. All remote HTML goes through an
// allowlist sanitiser before it is attached to the document.

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'CODE', 'PRE',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUB', 'SUP',
]);
const ALLOWED_CLASSES = new Set(['invisible', 'ellipsis', 'mention', 'hashtag', 'h-card', 'u-url', 'quote-inline']);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function safeUrl(href) {
  try {
    const u = new URL(href, location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function sanitise(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (src, dest) => {
    for (const child of src.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        dest.append(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          // Keep the text of unknown elements, drop scripts/styles entirely.
          if (!['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(child.tagName)) walk(child, dest);
          continue;
        }
        const copy = document.createElement(child.tagName);
        const cls = (child.getAttribute('class') || '').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
        if (cls.length) copy.className = cls.join(' ');
        if (child.tagName === 'A') {
          const href = safeUrl(child.getAttribute('href'));
          if (href) copy.href = href;
          copy.target = '_blank';
          copy.rel = 'noopener noreferrer';
        }
        walk(child, copy);
        dest.append(copy);
      }
    }
  };
  walk(doc.body, out);
  return out;
}

// Replace :shortcode: in text nodes with custom emoji images.
function emojify(root, emojis) {
  if (!emojis || !emojis.length) return root;
  const map = new Map(emojis.map((e) => [e.shortcode, e]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    const parts = t.textContent.split(/:([a-zA-Z0-9_]+):/);
    if (parts.length === 1) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      const e = i % 2 ? map.get(p) : null;
      if (e && safeUrl(e.url)) frag.append(el('img', { class: 'emoji', src: e.url, alt: `:${p}:`, title: `:${p}:`, loading: 'lazy' }));
      else frag.append(i % 2 ? `:${p}:` : p);
    });
    t.replaceWith(frag);
  }
  return root;
}

function richText(html, emojis) {
  const frag = sanitise(html);
  const wrap = document.createElement('div');
  wrap.append(frag);
  return emojify(wrap, emojis);
}

function plainWithEmoji(text, emojis) {
  const span = el('span', { text });
  return emojify(span, emojis);
}

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

// Links that open on the user's home instance, so following/replying happens
// in the normal Mastodon UI.
function homeLinks(instance) {
  return {
    account: (acct) => `https://${instance}/@${acct}`,
    status: (s) => `https://${instance}/@${s.account.acct}/${s.id}`,
    tag: (name) => `https://${instance}/tags/${encodeURIComponent(name)}`,
  };
}

function rewriteLinks(content, status, links) {
  for (const a of content.querySelectorAll('a')) {
    if (a.classList.contains('mention')) {
      const m = status.mentions.find((m) => m.url === a.href);
      if (m) a.href = links.account(m.acct);
    } else if (a.classList.contains('hashtag')) {
      const name = a.textContent.replace(/^#/, '');
      if (name) a.href = links.tag(name);
    }
  }
}

function media(attachments, sensitive) {
  if (!attachments.length) return null;
  const grid = el('div', { class: `media n${Math.min(attachments.length, 4)}${sensitive ? ' sensitive' : ''}` });
  for (const m of attachments) {
    const alt = m.description || '';
    let item;
    if (m.type === 'image') {
      const full = safeUrl(m.url) || safeUrl(m.remote_url);
      item = el('a', { href: full, target: '_blank', rel: 'noopener noreferrer' },
        el('img', { src: safeUrl(m.preview_url) || full, alt, title: alt, loading: 'lazy' }));
    } else if (m.type === 'gifv') {
      item = el('video', { src: safeUrl(m.url), autoplay: true, loop: true, muted: true, playsinline: true, 'aria-label': alt });
      item.muted = true;
    } else if (m.type === 'video') {
      item = el('video', { src: safeUrl(m.url), controls: true, preload: 'none', poster: safeUrl(m.preview_url), playsinline: true, 'aria-label': alt });
    } else if (m.type === 'audio') {
      item = el('audio', { src: safeUrl(m.url), controls: true, preload: 'none' });
    } else {
      item = el('a', { href: safeUrl(m.remote_url || m.url), target: '_blank', rel: 'noopener noreferrer', class: 'unknown-media', text: 'Attachment' });
    }
    grid.append(el('div', { class: 'media-item' }, item, alt ? el('span', { class: 'alt-badge', title: alt, text: 'ALT' }) : null));
  }
  if (sensitive) {
    grid.append(el('button', { class: 'reveal', type: 'button', text: 'Sensitive media — tap to show', onclick: (e) => {
      grid.classList.remove('sensitive');
      e.currentTarget.remove();
    } }));
  }
  return grid;
}

function card(c) {
  const href = c && safeUrl(c.url);
  if (!href) return null;
  return el('a', { class: 'card', href, target: '_blank', rel: 'noopener noreferrer' },
    c.image ? el('img', { src: safeUrl(c.image), alt: '', loading: 'lazy' }) : null,
    el('div', { class: 'card-text' },
      el('strong', { text: c.title || href }),
      c.description ? el('p', { text: c.description }) : null,
      el('small', { text: c.provider_name || new URL(href).hostname })));
}

function poll(p, url) {
  if (!p) return null;
  const total = p.votes_count || 0;
  const list = el('ul', { class: 'poll' });
  for (const o of p.options) {
    const pct = total ? Math.round(((o.votes_count || 0) / total) * 100) : 0;
    list.append(el('li', {}, el('span', { class: 'bar', style: `width:${pct}%` }), el('span', { text: `${o.title}` }), el('b', { text: `${pct}%` })));
  }
  return el('div', {}, list, el('a', { class: 'poll-meta', href: url, target: '_blank', rel: 'noopener noreferrer', text: `${total} votes${p.expired ? ' · closed' : ' · vote on server'}` }));
}

function filterHit(status) {
  const hits = (status.filtered || []).map((f) => f.filter);
  if (hits.some((f) => f.filter_action === 'hide')) return { hide: true };
  const warn = hits.find((f) => f.filter_action === 'warn');
  return warn ? { warn: warn.title } : {};
}

function statusBody(s, links, { nested = false } = {}) {
  const body = el('div', { class: 'body' });
  const content = richText(s.content, s.emojis);
  content.className = 'content';
  rewriteLinks(content, s, links);
  const extras = [
    media(s.media_attachments || [], s.sensitive),
    s.poll ? poll(s.poll, links.status(s)) : null,
    !nested && s.quote && s.quote.quoted_status ? quote(s.quote.quoted_status, links) : null,
    !s.media_attachments?.length && !s.poll ? card(s.card) : null,
  ].filter(Boolean);
  if (s.spoiler_text) {
    body.append(el('details', { class: 'cw' },
      el('summary', {}, plainWithEmoji(s.spoiler_text, s.emojis)),
      content, ...extras));
  } else {
    body.append(content, ...extras);
  }
  return body;
}

function quote(q, links) {
  return el('a', { class: 'quote', href: links.status(q), target: '_blank', rel: 'noopener noreferrer' },
    el('div', { class: 'who' }, el('strong', {}, plainWithEmoji(q.account.display_name || q.account.username, q.account.emojis)), el('small', { text: ` @${q.account.acct}` })),
    statusBody(q, links, { nested: true }));
}

function actionButton(label, icon, count, active, onToggle) {
  const btn = el('button', { type: 'button', class: `act${active ? ' on' : ''}`, 'aria-pressed': String(!!active), 'aria-label': label, title: label },
    el('span', { class: 'icon', text: icon }), el('span', { class: 'count', text: count ? String(count) : '' }));
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(next));
    btn.classList.toggle('on', next);
    btn.disabled = true;
    try {
      const updated = await onToggle(next);
      const c = updated && { favourite: updated.favourites_count, reblog: updated.reblogs_count }[btn.dataset.kind];
      if (c != null) btn.querySelector('.count').textContent = c ? String(c) : '';
    } catch (err) {
      btn.setAttribute('aria-pressed', String(!next));
      btn.classList.toggle('on', !next);
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// Returns an <article> for a home timeline entry, or null if a filter hides it.
export function renderStatus(entry, { instance, client }) {
  const s = entry.reblog || entry;
  const f = filterHit(s);
  if (f.hide) return null;
  const links = homeLinks(instance);
  const a = s.account;

  const article = el('article', { class: 'status', 'data-id': entry.id });
  if (entry.reblog) {
    article.append(el('div', { class: 'boosted-by' }, '🔁 ',
      el('a', { href: links.account(entry.account.acct), target: '_blank', rel: 'noopener noreferrer' },
        plainWithEmoji(entry.account.display_name || entry.account.username, entry.account.emojis)),
      ' boosted'));
  }

  const header = el('header', {},
    el('a', { class: 'avatar', href: links.account(a.acct), target: '_blank', rel: 'noopener noreferrer' },
      el('img', { src: safeUrl(a.avatar_static || a.avatar), alt: '', loading: 'lazy' })),
    el('div', { class: 'who' },
      el('a', { href: links.account(a.acct), target: '_blank', rel: 'noopener noreferrer' },
        el('strong', {}, plainWithEmoji(a.display_name || a.username, a.emojis))),
      el('small', { text: `@${a.acct}` })),
    el('a', { class: 'time', href: links.status(s), target: '_blank', rel: 'noopener noreferrer', title: new Date(s.created_at).toLocaleString(), text: relTime(s.created_at) }));
  article.append(header);

  if (s.in_reply_to_id) {
    const target = s.mentions.find((m) => m.id === s.in_reply_to_account_id);
    article.append(el('div', { class: 'reply-to', text: s.in_reply_to_account_id === a.id ? '↩ Thread continues' : `↩ Replying to @${target ? target.acct : '…'}` }));
  }

  let body = statusBody(s, links);
  if (f.warn) {
    body = el('details', { class: 'cw filtered' }, el('summary', { text: `Filtered: ${f.warn}` }), body);
  }
  article.append(body);

  const fav = actionButton('Favourite', '★', s.favourites_count, s.favourited, (on) => client.toggle(s.id, 'favourite', on));
  fav.dataset.kind = 'favourite';
  const boost = actionButton('Boost', '🔁', s.reblogs_count, s.reblogged, (on) => client.toggle(s.id, 'reblog', on).then((r) => r.reblog || r));
  boost.dataset.kind = 'reblog';
  if (s.visibility === 'private' || s.visibility === 'direct') boost.disabled = true;
  const bookmark = actionButton('Bookmark', '🔖', 0, s.bookmarked, (on) => client.toggle(s.id, 'bookmark', on));

  article.append(el('footer', {},
    el('a', { class: 'act', href: links.status(s), target: '_blank', rel: 'noopener noreferrer', title: 'Reply / open thread on your server' },
      el('span', { class: 'icon', text: '💬' }), el('span', { class: 'count', text: s.replies_count ? String(s.replies_count) : '' })),
    boost, fav, bookmark,
    s.url ? el('a', { class: 'act', href: safeUrl(s.url), target: '_blank', rel: 'noopener noreferrer', title: 'Open original' }, el('span', { class: 'icon', text: '↗' })) : null));
  return article;
}

