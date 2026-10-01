// The curated feed: articles picked for you by the curator service, merged
// into the home timeline. The curator gives every story a `sort_id` in
// Mastodon's id space (milliseconds << 16, from when it first saw the story),
// so curated items sort among posts by time and the reading position, sync
// note and "read up to" logic work for them unchanged.

const REFRESH_MS = 60_000; // don't fetch the feed more often than this
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
    this.votes = store.get(VOTES_KEY, {}); // item id → 1 | -1
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

  vote(itemId) {
    return this.votes[itemId] || 0;
  }

  // 1 up, -1 down, 0 clears. Remembered here so the buttons show it.
  async setVote(itemId, vote) {
    await this.post('vote', { item_id: itemId, vote });
    if (vote) this.votes[itemId] = vote;
    else delete this.votes[itemId];
    const keys = Object.keys(this.votes);
    if (keys.length > MAX_VOTES) for (const k of keys.slice(0, keys.length - MAX_VOTES)) delete this.votes[k];
    this.store.set(VOTES_KEY, this.votes);
    this.log('vote', { vote });
  }

  // Reading signals ("open" when you follow the link). Best effort.
  event(itemId, kind) {
    this.post('event', { item_id: itemId, kind }, { keepalive: true }).catch(() => {});
  }

  async post(path, body, { keepalive = false } = {}) {
    const res = await fetch(this.api + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive,
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'The curator refused the vote token (check Settings)' : `Curator error ${res.status}`);
  }
}
