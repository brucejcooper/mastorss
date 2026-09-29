import { Client, beginLogin, finishLogin, normaliseInstance, revoke, compareIds, nextId } from './api.js';
import { renderStatus, renderAccount, renderTag, el } from './render.js';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_INSTANCE = 'mastodon.au';
const PAGE_SIZE = 40;
const POLL_MS = 5 * 60_000; // how often to look for new posts while the page stays open
const MIN_RECHECK_MS = 15_000; // don't re-check more often than this when scrolling to the end
const STREAM_DEBOUNCE_MS = 1500; // batch bursts of streamed posts into one fetch
const STREAM_RETRY_MAX_MS = 60_000;
const KEEP_READ_IN_DOM = 30;
const HISTORY_SIZE = 20; // already-read posts shown above the reading position on load
const VISIBILITIES = ['public', 'unlisted', 'private', 'direct']; // least to most restrictive

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function showToast(text) {
  const bar = $('#toast');
  bar.textContent = text;
  bar.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => (bar.hidden = true), 5000);
}

function showError(err) {
  console.error(err);
  showToast(err.message || String(err));
}

function plainText(html) {
  const body = new DOMParser().parseFromString(html || '', 'text/html').body;
  body.querySelectorAll('script, style, template').forEach((n) => n.remove());
  return body.textContent;
}

// ---------------------------------------------------------------- login

function showLogin() {
  $('#login').hidden = false;
  $('#reader').hidden = true;
  const input = $('#instance');
  input.value = store.get('mastorss.lastInstance', DEFAULT_INSTANCE);

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const instance = normaliseInstance(input.value);
      store.set('mastorss.lastInstance', instance);
      await beginLogin(instance);
    } catch (err) {
      showError(err);
    }
  };

  $('#use-code').onclick = async () => {
    try {
      const instance = normaliseInstance(input.value);
      store.set('mastorss.lastInstance', instance);
      const url = await beginLogin(instance, { oob: true });
      $('#code-form').hidden = false;
      $('#code-link').href = url;
      window.open(url, '_blank');
    } catch (err) {
      showError(err);
    }
  };

  $('#code-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const session = await finishLogin($('#code').value);
      store.set('mastorss.session', session);
      location.reload();
    } catch (err) {
      showError(err);
    }
  };
}

// ---------------------------------------------------------------- reader

class Reader {
  constructor(session, account) {
    this.session = session;
    this.client = new Client(session);
    this.account = account;
    this.posKey = `mastorss.pos.${session.instance}.${account.id}`;
    this.settingsKey = `mastorss.settings.${session.instance}.${account.id}`;
    this.settings = { syncMarker: false, ...store.get(this.settingsKey, {}) };
    this.position = store.get(this.posKey); // id of the newest post that has been read
    this.newest = null; // id of the newest post loaded into the page
    this.oldest = null; // id of the oldest post loaded into the page
    this.loadingOlder = false;
    this.noMoreOlder = false;
    this.overlays = []; // open thread/search panels, innermost last
    this.stream = null;
    this.streamRetryMs = 2000;
    this.loading = false;
    this.caughtUp = false;
    this.lastChecked = 0;
    this.readCursor = 0; // index into the list of the first article not yet marked read
    this.serverDirty = false;

    this.list = $('#timeline');
    this.end = $('#end');
  }

  async start() {
    $('#login').hidden = true;
    $('#reader').hidden = false;
    $('#who').textContent = `@${this.account.acct}@${this.session.instance}`;
    this.bindUi();
    await this.resolvePosition();
    await this.loadHistory();
    // Load until there's a screenful below the first unread post (or nothing
    // more), so jumping to it isn't cut short by the bottom of the page.
    for (let i = 0; i < 10 && !this.caughtUp; i++) {
      const first = this.articles()[this.readCursor];
      if (first && this.end.getBoundingClientRect().top - first.getBoundingClientRect().top > window.innerHeight) break;
      if (!(await this.loadMore())) break;
    }
    this.jumpToFirstUnread();
    this.startStream();
    // Only start infinite loading once we know where the reader is up to.
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadOlder();
    }, { rootMargin: '1500px 0px 0px 0px' }).observe($('#older'));
    new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (!this.caughtUp) this.loadMore();
      else if (Date.now() - this.lastChecked > MIN_RECHECK_MS) this.checkForNew({ background: true });
    }, { rootMargin: '0px 0px 2000px 0px' }).observe(this.end);
  }

  async resolvePosition() {
    let server = null;
    try {
      server = await this.client.getMarker();
    } catch (err) {
      console.warn('Could not read marker', err);
    }
    if (this.settings.syncMarker) {
      if (compareIds(server, this.position) > 0) this.position = server;
    } else if (!this.position) {
      this.position = server;
    }
    this.newest = this.position;
    if (this.position) store.set(this.posKey, this.position);
  }

  // A few already-read posts above the reading position, so scrolling up
  // shows where you were.
  async loadHistory() {
    if (!this.position) return;
    try {
      const page = await this.client.homeBefore(nextId(this.position), HISTORY_SIZE);
      if (!page.length) this.noMoreOlder = true;
      else this.oldest = page[0].id;
      for (const entry of page) {
        const node = this.render(entry);
        if (!node) continue;
        node.classList.add('read');
        this.list.append(node);
        this.readCursor++;
      }
    } catch (err) {
      console.warn('Could not load read posts', err);
    }
  }

  // Put the first unread post just under the header (or the "caught up"
  // message if there is nothing new).
  jumpToFirstUnread() {
    const target = this.articles()[this.readCursor] || (this.readCursor ? this.end : null);
    if (!target) return;
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - this.headerHeight());
  }

  async loadOlder() {
    if (this.loadingOlder || this.noMoreOlder || !this.oldest || !this.overlaysClosed()) return;
    this.loadingOlder = true;
    const status = $('#older-status');
    status.textContent = 'Loading older posts…';
    let ok = false;
    try {
      const page = await this.client.homeBefore(this.oldest, PAGE_SIZE);
      if (!page.length) {
        this.noMoreOlder = true;
        status.textContent = 'Start of your home timeline';
        return;
      }
      this.oldest = page[0].id;
      const frag = document.createDocumentFragment();
      let added = 0;
      for (const entry of page) {
        const node = this.render(entry);
        if (!node) continue;
        node.classList.add('read');
        frag.append(node);
        added++;
      }
      // Prepend without moving what the reader is looking at.
      const anchor = this.list.firstElementChild || this.end;
      const before = anchor.getBoundingClientRect().top;
      this.list.prepend(frag);
      this.readCursor += added;
      window.scrollBy(0, anchor.getBoundingClientRect().top - before);
      status.textContent = '';
      ok = true;
    } catch (err) {
      status.textContent = "Couldn't load older posts";
      showError(err);
    } finally {
      this.loadingOlder = false;
    }
    if (ok && window.scrollY < 1500) this.loadOlder();
  }

  render(entry, extra = {}) {
    return renderStatus(entry, {
      instance: this.session.instance,
      client: this.client,
      onThread: (s) => this.openThread(s),
      onReply: (s) => this.openCompose(s),
      ...extra,
    });
  }

  bindUi() {
    // We position the page ourselves (at the first unread post); stop the
    // browser restoring the old scroll offset over the top of that.
    history.scrollRestoration = 'manual';
    if (history.state?.overlay) history.replaceState(null, '');
    window.addEventListener('popstate', () => this.closeTopOverlay());
    for (const back of document.querySelectorAll('.overlay .back')) back.onclick = () => history.back();
    $('#open-search').onclick = () => this.openSearch();
    $('#open-compose').onclick = () => this.openCompose();
    $('#search-form').onsubmit = (e) => {
      e.preventDefault();
      this.runSearch($('#search-q').value.trim());
    };
    this.bindCompose();

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking || !this.overlaysClosed()) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        this.trackRead();
      });
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushMarker(true);
        this.stopStream();
      } else {
        this.startStream();
        if (this.caughtUp) this.checkForNew({ background: true });
      }
    });
    window.addEventListener('pagehide', () => this.flushMarker(true));

    $('#check-new').onclick = () => this.checkForNew();
    $('#retry').onclick = () => this.loadMore({ force: true });
    $('#refresh').onclick = () => (this.caughtUp ? this.checkForNew() : this.nextPost());
    $('#menu').onclick = () => this.openSettings();

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, dialog[open]')) return;
      if (e.key === 'Escape' && this.overlays.length) history.back();
      if (e.key === '/') {
        e.preventDefault();
        this.openSearch();
      }
      if (e.key === 'n') this.openCompose();
      if (!this.overlaysClosed()) return;
      if (e.key === 'j') this.nextPost();
      if (e.key === 'k') window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
      if (e.key === 'r' && this.caughtUp) this.checkForNew();
    });
  }

  headerHeight() {
    return $('#bar').getBoundingClientRect().height;
  }

  articles() {
    return this.list.children;
  }

  // Scroll so the first unread post sits just below the header.
  nextPost() {
    const next = this.articles()[this.readCursor];
    const target = next && next.getBoundingClientRect().top <= this.headerHeight() + 4 ? this.articles()[this.readCursor + 1] : next;
    if (target) window.scrollBy({ top: target.getBoundingClientRect().top - this.headerHeight(), behavior: 'smooth' });
    else this.end.scrollIntoView({ behavior: 'smooth' });
  }

  // Loads the next page after the newest post shown. Only an empty page means
  // we have reached the end: Mastodon drops deleted/muted posts after applying
  // the limit, so short pages are normal in the middle of the timeline.
  async loadMore({ force = false, background = false } = {}) {
    if (this.loading || (this.caughtUp && !force)) return;
    this.loading = true;
    let ok = false;
    if (!background) this.setStatus('Loading…');
    $('#retry').hidden = true;
    try {
      const page = await this.client.homeAfter(this.newest, PAGE_SIZE);
      this.lastChecked = Date.now();
      // With no saved position the first page is simply the most recent posts.
      const fresh = page.filter((s) => compareIds(s.id, this.newest) > 0);
      if (!this.oldest && fresh.length) this.oldest = fresh[0].id;
      for (const entry of fresh) {
        const node = this.render(entry);
        if (node) this.list.append(node);
        this.newest = entry.id;
      }
      if (!fresh.length) {
        this.markCaughtUp();
      } else {
        // New posts are appended above the end block before its spacer
        // collapses, so they appear where the reader is already looking.
        this.leaveCaughtUp();
        this.setStatus('');
      }
      this.updateCount();
      this.trackRead();
      ok = true;
    } catch (err) {
      if (background) {
        console.warn('Background check failed', err);
        $('#last-checked').textContent = "Couldn't check for new posts, will try again shortly.";
        this.schedulePoll();
      } else {
        this.handleError(err);
      }
    } finally {
      this.loading = false;
    }
    // Keep going while the end is close (but never retry in a loop).
    if (ok && !this.caughtUp && this.end.getBoundingClientRect().top < window.innerHeight + 2000) await this.loadMore();
    return ok;
  }

  // ------------------------------------------------ streaming
  // Mastodon pushes an `update` event the moment a post lands in the home
  // timeline. We only use it as a nudge and fetch through the normal timeline
  // API, so ordering, filters and the read marker all work the same way.
  // The 5 minute poll stays as a fallback for when the socket is down.

  async startStream() {
    if (this.stream || document.visibilityState !== 'visible') return;
    clearTimeout(this.streamRetry);
    let ws;
    try {
      ws = await this.client.openStream();
    } catch (err) {
      console.warn('Streaming unavailable', err);
      return;
    }
    this.stream = ws;
    ws.onopen = () => (this.streamRetryMs = 2000);
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.event === 'update') this.onStreamedPost();
    };
    ws.onclose = () => {
      if (this.stream !== ws) return;
      this.stream = null;
      if (document.visibilityState !== 'visible') return;
      // Reconnect with backoff; the poll covers the gap.
      this.streamRetry = setTimeout(() => this.startStream(), this.streamRetryMs);
      this.streamRetryMs = Math.min(this.streamRetryMs * 2, STREAM_RETRY_MAX_MS);
    };
  }

  stopStream() {
    clearTimeout(this.streamRetry);
    const ws = this.stream;
    this.stream = null;
    ws?.close();
  }

  onStreamedPost() {
    // Mid-timeline, infinite scroll will reach it anyway.
    if (!this.caughtUp) return;
    clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => this.checkForNew({ background: true }), STREAM_DEBOUNCE_MS);
  }

  markCaughtUp() {
    this.caughtUp = true;
    this.end.classList.add('caught-up');
    this.setStatus('');
    const time = new Date(this.lastChecked || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#last-checked').textContent = this.stream?.readyState === WebSocket.OPEN
      ? 'New posts will appear here as they arrive.'
      : `New posts will appear here automatically. Last checked ${time}.`;
    this.updateCount();
    this.schedulePoll();
  }

  leaveCaughtUp() {
    this.caughtUp = false;
    this.end.classList.remove('caught-up');
    clearTimeout(this.pollTimer);
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      // While hidden, visibilitychange triggers the next check instead.
      if (document.visibilityState === 'visible') this.checkForNew({ background: true });
    }, POLL_MS);
  }

  checkForNew({ background = false } = {}) {
    return this.loadMore({ force: true, background });
  }

  setStatus(text) {
    $('#end-status').textContent = text;
  }

  // A post counts as read once its bottom edge has scrolled up under the header.
  trackRead() {
    const limit = this.headerHeight();
    const items = this.articles();
    let advanced = false;
    while (this.readCursor < items.length) {
      const node = items[this.readCursor];
      if (node.getBoundingClientRect().bottom > limit) break;
      node.classList.add('read');
      this.setPosition(node.dataset.id);
      this.readCursor++;
      advanced = true;
    }
    if (advanced) {
      this.updateCount();
      this.trimRead();
    }
  }

  // Drop old read posts from the DOM so long sessions stay light, keeping the
  // viewport where it is.
  trimRead() {
    const excess = this.readCursor - KEEP_READ_IN_DOM;
    if (excess < 20) return;
    const items = Array.from(this.articles()).slice(0, excess);
    const firstKept = this.articles()[excess];
    const anchorTop = firstKept.getBoundingClientRect().top;
    items.forEach((n) => n.remove());
    this.readCursor -= excess;
    // Scrolling back up re-fetches what was dropped.
    this.oldest = firstKept.dataset.id;
    this.noMoreOlder = false;
    const shift = firstKept.getBoundingClientRect().top - anchorTop;
    if (shift) window.scrollBy(0, shift);
  }

  updateCount() {
    const unread = this.articles().length - this.readCursor;
    $('#count').textContent = unread || this.caughtUp ? `${unread}${this.caughtUp ? '' : '+'} unread` : '';
  }

  setPosition(id) {
    if (compareIds(id, this.position) <= 0) return;
    this.position = id;
    store.set(this.posKey, id);
    if (this.settings.syncMarker) {
      this.serverDirty = true;
      clearTimeout(this.markerTimer);
      this.markerTimer = setTimeout(() => this.flushMarker(), 4000);
    }
  }

  async flushMarker(keepalive = false) {
    if (!this.serverDirty || !this.position) return;
    this.serverDirty = false;
    clearTimeout(this.markerTimer);
    try {
      await this.client.setMarker(this.position, { keepalive });
    } catch (err) {
      // 409 means another client updated it at the same moment; try again later.
      this.serverDirty = true;
      console.warn('Could not save marker', err);
    }
  }

  handleError(err) {
    if (err.unauthorised) {
      store.del('mastorss.session');
      showError(err);
      setTimeout(() => location.reload(), 1500);
      return;
    }
    this.setStatus('Could not load posts.');
    $('#retry').hidden = false;
    showError(err);
  }

  // ------------------------------------------------ thread + search panels

  overlaysClosed() {
    return this.overlays.length === 0;
  }

  // Panels are history entries, so the back button/swipe closes them.
  openOverlay(panel) {
    if (!panel.hidden) return;
    panel.hidden = false;
    panel.scrollTop = 0;
    this.overlays.push(panel);
    document.body.classList.add('overlay-open');
    history.pushState({ overlay: panel.id }, '');
  }

  closeTopOverlay() {
    const panel = this.overlays.pop();
    if (panel) {
      panel.hidden = true;
      if (panel.id === 'thread') $('#thread-body').replaceChildren();
    }
    if (!this.overlays.length) document.body.classList.remove('overlay-open');
  }

  async openThread(status) {
    const panel = $('#thread');
    const body = $('#thread-body');
    this.openOverlay(panel);
    this.threadStatus = status;
    body.replaceChildren(el('p', { class: 'hint pad', text: 'Loading conversation…' }));
    panel.scrollTop = 0;
    try {
      const [ctx, fresh] = await Promise.all([
        this.client.context(status.id),
        this.client.request(`/api/v1/statuses/${status.id}`).catch(() => status),
      ]);
      if (this.threadStatus !== status || panel.hidden) return;
      const frag = document.createDocumentFragment();
      for (const s of ctx.ancestors) {
        const node = this.render(s);
        if (node) frag.append(node);
      }
      const focus = this.render(fresh, { focus: true }) || this.render(status, { focus: true });
      if (focus) frag.append(focus);
      // Indent replies under the post they answer.
      const depth = new Map([[status.id, 0]]);
      for (const s of ctx.descendants) {
        const d = (depth.get(s.in_reply_to_id) ?? 0) + 1;
        depth.set(s.id, d);
        const node = this.render(s, { depth: d });
        if (node) frag.append(node);
      }
      body.replaceChildren(frag);
      if (focus && ctx.ancestors.length) {
        panel.scrollTop = focus.offsetTop - panel.querySelector('.overlay-bar').offsetHeight;
      }
    } catch (err) {
      body.replaceChildren(el('p', { class: 'hint pad', text: "Couldn't load this conversation." }));
      showError(err);
    }
  }

  openSearch() {
    this.openOverlay($('#search'));
    const q = $('#search-q');
    q.focus();
    q.select();
  }

  async runSearch(q) {
    if (!q) return;
    const results = $('#search-results');
    $('#search-q').blur(); // hide the on-screen keyboard
    results.replaceChildren(el('p', { class: 'hint pad', text: 'Searching…' }));
    try {
      const r = await this.client.search(q);
      const ctx = { instance: this.session.instance };
      const frag = document.createDocumentFragment();
      if (r.accounts.length) {
        frag.append(el('h2', { class: 'section-title', text: 'People' }), ...r.accounts.map((a) => renderAccount(a, ctx)));
      }
      if (r.hashtags.length) {
        frag.append(el('h2', { class: 'section-title', text: 'Hashtags' }), ...r.hashtags.map((t) => renderTag(t, ctx)));
      }
      const posts = r.statuses.map((s) => this.render(s)).filter(Boolean);
      if (posts.length) frag.append(el('h2', { class: 'section-title', text: 'Posts' }), ...posts);
      if (!frag.childNodes.length) frag.append(el('p', { class: 'hint pad', text: `Nothing found for “${q}”.` }));
      results.replaceChildren(frag);
    } catch (err) {
      results.replaceChildren(el('p', { class: 'hint pad', text: 'Search failed.' }));
      showError(err);
    }
  }

  // ------------------------------------------------ composer

  bindCompose() {
    const dlg = $('#compose');
    const text = $('#compose-text');
    const cw = $('#compose-cw');
    const update = () => this.updateComposeCount();
    text.oninput = update;
    cw.oninput = update;
    const cancel = () => {
      if (text.value.trim() !== this.composeInitial.trim() && !confirm('Discard this post?')) return;
      dlg.close();
    };
    $('#compose-cancel').onclick = cancel;
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      cancel();
    });
    $('#compose-form').onsubmit = async (e) => {
      e.preventDefault();
      if (this.composeLength() > this.maxChars) return;
      const send = $('#compose-send');
      send.disabled = true;
      try {
        await this.client.post({
          status: text.value,
          inReplyToId: this.composeReply?.id,
          visibility: $('#compose-visibility').value,
          spoilerText: cw.value.trim(),
          idempotencyKey: this.composeKey,
        });
        dlg.close();
        showToast(this.composeReply ? 'Reply posted' : 'Posted');
        if (this.composeReply && this.threadStatus && !$('#thread').hidden) this.openThread(this.threadStatus);
      } catch (err) {
        showError(err);
      } finally {
        send.disabled = false;
      }
    };
  }

  async openCompose(replyTo = null) {
    this.composeReply = replyTo;
    this.composeKey = crypto.randomUUID();
    const me = this.account.acct;
    const accts = replyTo ? [replyTo.account.acct, ...replyTo.mentions.map((m) => m.acct)] : [];
    const mentions = [...new Set(accts)].filter((a) => a !== me).map((a) => `@${a} `).join('');
    this.composeInitial = mentions;
    $('#compose-text').value = mentions;
    $('#compose-cw').value = replyTo?.spoiler_text || '';
    // Replies are never more public than the post they answer.
    const preferred = this.account.source?.privacy || 'public';
    const vis = replyTo && VISIBILITIES.indexOf(replyTo.visibility) > VISIBILITIES.indexOf(preferred) ? replyTo.visibility : preferred;
    $('#compose-visibility').value = vis;
    $('#compose-context').textContent = replyTo
      ? `Replying to @${replyTo.account.acct}: ${plainText(replyTo.content).slice(0, 120)}`
      : '';
    $('#compose-send').textContent = replyTo ? 'Reply' : 'Post';
    $('#compose').showModal();
    const text = $('#compose-text');
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
    this.maxChars ??= await this.client.maxChars();
    this.updateComposeCount();
  }

  // Mastodon counts every link as 23 characters and remote mentions by
  // their username only.
  composeLength() {
    const body = $('#compose-text').value
      .replace(/https?:\/\/\S+/g, 'x'.repeat(23))
      .replace(/(@[\w.-]+)@[\w.-]+\.[a-z]{2,}/gi, '$1');
    return [...body].length + [...$('#compose-cw').value].length;
  }

  updateComposeCount() {
    const left = (this.maxChars ?? 500) - this.composeLength();
    const count = $('#compose-count');
    count.textContent = String(left);
    count.classList.toggle('over', left < 0);
    $('#compose-send').disabled = left < 0;
  }

  openSettings() {
    const dlg = $('#settings');
    const sync = $('#sync-marker');
    sync.checked = this.settings.syncMarker;
    sync.onchange = () => {
      this.settings.syncMarker = sync.checked;
      store.set(this.settingsKey, this.settings);
      if (sync.checked) {
        this.serverDirty = true;
        this.flushMarker();
      }
    };
    $('#position-info').textContent = this.position ? `Read up to post ${this.position}` : 'No position saved yet';
    $('#mark-all').onclick = async () => {
      if (!confirm('Skip everything and start from now?')) return;
      try {
        const latest = await this.client.latestHomeId();
        if (latest) this.setPosition(latest);
        await this.flushMarker();
        location.reload();
      } catch (err) {
        showError(err);
      }
    };
    $('#logout').onclick = async () => {
      if (!confirm('Log out of this device?')) return;
      await this.flushMarker();
      await revoke(this.session);
      store.del('mastorss.session');
      location.reload();
    };
    dlg.showModal();
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  const params = new URLSearchParams(location.search);
  if (params.has('code')) {
    history.replaceState(null, '', location.pathname);
    try {
      store.set('mastorss.session', await finishLogin(params.get('code'), params.get('state')));
    } catch (err) {
      showError(err);
    }
  } else if (params.has('error')) {
    history.replaceState(null, '', location.pathname);
    showError(new Error(params.get('error_description') || params.get('error')));
  }

  const session = store.get('mastorss.session');
  if (!session) return showLogin();

  try {
    const account = await new Client(session).verify();
    await new Reader(session, account).start();
  } catch (err) {
    if (err.unauthorised) store.del('mastorss.session');
    showError(err);
    if (err.unauthorised) showLogin();
  }
}

$('#settings-close').onclick = () => $('#settings').close();
boot();
