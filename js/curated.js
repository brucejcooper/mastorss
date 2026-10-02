// The curated feed: articles picked for you by the curator service, merged
// into the home timeline. The curator gives every story a `sort_id` in
// Mastodon's id space (milliseconds << 16, from when it first saw the story),
// so curated items sort among posts by time and the reading position, sync
// note and "read up to" logic work for them unchanged.

const REFRESH_MS = 60_000; // don't fetch the feed more often than this
const VERDICT_TIMEOUT_MS = 10_000; // past this, show the posts unjudged
const VOTES_KEY = 'mastorss.curated.votes';
const MAX_VOTES = 2000;

// Shown on each item instead of the raw source id ("rss:ABC News Top Stories").
export function sourceLabel(source) {
  const [kind, rest = ''] = source.split(/:(.*)/s);
  if (kind === 'rss') return rest;
  if (kind === 'mastodon') return rest.startsWith('#') ? `${rest} on Mastodon` : 'Mastodon';
  if (kind === 'bluesky') return `${rest} on Bluesky`;
  return source;
}

export class Curated {
  // `feedUrl` is the full feed address, secret path included; votes and
  // reading events go to the same server with `token`.
  constructor({ feedUrl, token }, store, log) {
    this.feedUrl = feedUrl;
    this.token = token;
    this.api = new URL('/api/', feedUrl).href;
    this.store = store;
    this.log = log;
    this.items = []; // oldest first
    this.fetchedAt = 0;
    this.votes = store.get(VOTES_KEY, {}); // item id or "status:<id>" → 1 | -1
    this.bookmarked = new Set(); // item ids, from the curator
    this.hidden = 0; // home posts filtered out this session
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  // Your home timeline goes through the curator too: it says which posts to
  // show (`show`), whether they're in the maybe lane, and what other coverage
  // the same story has. Returns Map(status id → verdict). If the curator
  // can't be reached in time, an empty map: everything shows.
  async verdicts(ids) {
    if (!ids.length) return new Map();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), VERDICT_TIMEOUT_MS);
    try {
      const res = await fetch(this.api + 'home', { method: 'POST', headers: this.headers(), body: JSON.stringify({ ids }), signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Map(Object.entries((await res.json()).verdicts || {}));
    } catch (err) {
      this.log('home-failed', { status: err.name === 'AbortError' ? 'timeout' : err.message });
      return new Map();
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetches the feed (at most once a minute unless forced). Returns the
  // items, oldest first. Stories that came from your own home timeline are
  // left out: the timeline already has them.
  async refresh({ force = false } = {}) {
    if (!force && Date.now() - this.fetchedAt < REFRESH_MS) return this.items;
    this.fetchedAt = Date.now();
    try {
      const res = await fetch(this.feedUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feed = await res.json();
      const fromHome = (c) => c.source === 'mastodon:home' || (c.also || []).some((a) => a.source === 'mastodon:home');
      this.items = (feed.items || [])
        .filter((it) => it._curator?.sort_id && !fromHome(it._curator))
        .map((it) => ({
          id: it._curator.sort_id,
          itemId: it.id,
          url: it.url,
          title: it.title,
          summary: it.content_text || '',
          image: it.image || null,
          published: it.date_published,
          author: it.authors?.[0]?.name || '',
          source: it._curator.source,
          lane: it._curator.lane,
          reason: it._curator.reason || '',
          also: it._curator.also || [],
        }))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      this.log('curated', { got: this.items.length });
    } catch (err) {
      this.log('curated-failed', { status: err.message });
      console.warn('Could not fetch the curated feed', err);
    }
    return this.items;
  }

  // Votes and bookmarks name either a curated item ({ item_id }) or a post in
  // your home timeline ({ status_id }).
  static key(target) {
    return target.status_id ? `status:${target.status_id}` : target.item_id;
  }

  vote(target) {
    return this.votes[Curated.key(target)] || 0;
  }

  // 1 up, -1 down, 0 clears. Remembered here so the buttons show it.
  async setVote(target, vote) {
    await this.post('vote', { ...target, vote });
    const key = Curated.key(target);
    if (vote) this.votes[key] = vote;
    else delete this.votes[key];
    const keys = Object.keys(this.votes);
    if (keys.length > MAX_VOTES) for (const k of keys.slice(0, keys.length - MAX_VOTES)) delete this.votes[k];
    this.store.set(VOTES_KEY, this.votes);
    this.log('vote', { vote });
  }

  isBookmarked(itemId) {
    return this.bookmarked.has(itemId);
  }

  // Bookmarks live on the curator, so every device sees them; a bookmark also
  // counts as a strong 👍.
  async setBookmark(target, on) {
    await this.post('bookmark', { ...target, on });
    if (target.item_id) {
      if (on) this.bookmarked.add(target.item_id);
      else this.bookmarked.delete(target.item_id);
    }
    this.log('bookmark', { on });
  }

  // Bookmarked articles, newest first, shaped like feed items.
  async bookmarks() {
    const res = await fetch(this.api + 'bookmarks', { headers: this.headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Curator error ${res.status}`);
    const items = (await res.json()).items || [];
    this.bookmarked = new Set(items.map((it) => it.id));
    return items.map((it) => ({
      id: `bookmark-${it.id}`, itemId: it.id, url: it.url, title: it.title, summary: it.summary || '', image: it.image,
      published: it.published, author: '', source: it.source, lane: 'main', reason: '', also: [],
    }));
  }

  // Reading signals ("open" when you follow the link: a lighter 👍). Best effort.
  event(itemId, kind) {
    this.post('event', { item_id: itemId, kind }, { keepalive: true }).catch(() => {});
  }

  async post(path, body, { keepalive = false } = {}) {
    const res = await fetch(this.api + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      keepalive,
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'The curator refused the vote token (check Settings)' : `Curator error ${res.status}`);
  }
}
