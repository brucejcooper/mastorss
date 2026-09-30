import { Client, beginLogin, finishLogin, normaliseInstance, revoke, compareIds, nextId } from './api.js';
import { renderStatus, renderAccount, renderTag, el, safariUrl } from './render.js';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_INSTANCE = 'mastodon.au';
const PAGE_SIZE = 40;
const POLL_MS = 5 * 60_000; // how often to look for new posts while the page stays open
const MIN_RECHECK_MS = 15_000; // don't re-check more often than this when scrolling to the end
const STREAM_DEBOUNCE_MS = 1500; // batch bursts of streamed posts into one fetch
const STREAM_RETRY_MAX_MS = 60_000;
// A fetch quicker than this shows "Fetched" for FETCHED_SHOW_MS afterwards so
// it doesn't flash by unnoticed; slower ones just clear when done.
const QUICK_FETCH_MS = 1000;
const FETCHED_SHOW_MS = 1000;
const STATUS_FADE_MS = 300; // matches the #end-status transition
const SAFARI_FALLBACK_MS = 1500;

// iOS only: `navigator.standalone` exists in Safari on iPhone/iPad and is
// true when running from the home screen.
const IS_IOS = 'standalone' in navigator;
const IOS_HOME_SCREEN = navigator.standalone === true;
const HISTORY_SIZE = 20; // already-read posts shown above the reading position on load
const VISIBILITIES = ['public', 'unlisted', 'private', 'direct']; // least to most restrictive
const NOTE_SAVE_MS = 4000; // batch position saves to the sync note

// ---------------------------------------------------------------- position sync
// Syncing uses a private note on an account (Mastodon lets you keep a note on
// any account that only you can see). Unlike the home timeline marker, no
// other client writes to it, so another app can't move your place. Our line
// in the note looks like `mastorss:{"home":"115..."}`; anything else in the
// note is left alone.
const NOTE_PREFIX = 'mastorss:';

function notePosition(text) {
  const line = (text || '').split('\n').find((l) => l.startsWith(NOTE_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(NOTE_PREFIX.length)).home || null;
  } catch {
    return null;
  }
}

function withNotePosition(text, position) {
  const ours = `${NOTE_PREFIX}${JSON.stringify({ home: position })}`;
  const lines = (text || '').split('\n').filter((l) => l && !l.startsWith(NOTE_PREFIX));
  return [...lines, ours].join('\n');
}

// Keys are scoped to the folder the app is served from, so copies on the
// same origin (e.g. /mastorss/ and /mastorss/test/) keep separate logins
// and reading positions. The first read of a key falls back to the
// unscoped key used by earlier versions, and copies it across.
const SCOPE = new URL('.', location.href).pathname;
const scoped = (key) => `${key}@${SCOPE}`;

const store = {
  get(key, fallback = null) {
    try {
      let v = localStorage.getItem(scoped(key));
      if (v == null) {
        v = localStorage.getItem(key);
        if (v != null) localStorage.setItem(scoped(key), v);
      }
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(scoped(key), JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(scoped(key));
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

const spinner = () => el('span', { class: 'spinner', 'aria-hidden': 'true' });

// A status line with an optional spinner in front.
function busyText(text) {
  return [spinner(), text];
}

function plainText(html) {
  const body = new DOMParser().parseFromString(html || '', 'text/html').body;
  body.querySelectorAll('script, style, template').forEach((n) => n.remove());
  return body.textContent;
}

// ---------------------------------------------------------------- updates
// iOS keeps home-screen apps suspended in memory for days, so a deploy isn't
// picked up until the app is killed. Each deploy writes version.json; we
// compare it with the one we started with whenever the app comes back to
// the foreground (and every so often while open). If it changed, reload
// straight away when nothing is in progress (the reading position is saved,
// so we land in the same place), otherwise offer a reload button.

const UPDATE_CHECK_MS = 30 * 60_000;
let loadedVersion = null;

async function fetchVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null;
  }
}

function busy() {
  return !!document.querySelector('dialog[open]') || !!document.querySelector('.overlay:not([hidden])');
}

async function checkForUpdate() {
  if (!loadedVersion || document.visibilityState !== 'visible') return;
  const latest = await fetchVersion();
  if (!latest || latest === loadedVersion) return;
  if (!busy()) {
    location.reload();
    return;
  }
  $('#update-bar').hidden = false;
}

async function watchForUpdates() {
  loadedVersion = await fetchVersion();
  if (!loadedVersion) return; // local development: no version file
  $('#update-reload').onclick = () => location.reload();
  document.addEventListener('visibilitychange', checkForUpdate);
  setInterval(checkForUpdate, UPDATE_CHECK_MS);
}

// ---------------------------------------------------------------- login

function showLogin() {
  $('#boot').hidden = true;
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
    this.settings = { syncNote: false, ...store.get(this.settingsKey, {}) };
    // Earlier versions synced through the timeline marker; carry the choice over.
    if (this.settings.syncMarker) this.settings.syncNote = true;
    delete this.settings.syncMarker;
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
    this.noteDirty = false;
    this.noteTarget = null; // { id, text, fallback } once known
    this.noteNeedsLogin = false;

    this.list = $('#timeline');
    this.end = $('#end');
  }

  async start() {
    $('#boot').hidden = true;
    $('#login').hidden = true;
    $('#reader').hidden = false;
    this.startBusy('Loading…');
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
    if (this.settings.syncNote) {
      try {
        const synced = notePosition((await this.findNote()).text);
        if (compareIds(synced, this.position) > 0) this.position = synced;
      } catch (err) {
        console.warn('Could not read the sync note', err);
      }
    }
    // First run on this device with nothing synced: start from the server's
    // timeline marker, if there is one.
    if (!this.position) {
      try {
        this.position = await this.client.getMarker();
      } catch (err) {
        console.warn('Could not read marker', err);
      }
    }
    this.newest = this.position;
    if (this.position) store.set(this.posKey, this.position);
  }

  // Which account the sync note lives on: your own account if Mastodon allows
  // a note there, otherwise your server's contact account. Every device
  // follows the same rule, so they all find the same note.
  async findNote() {
    if (this.noteTarget) return this.noteTarget;
    const self = this.account.id;
    const contact = (await this.client.instanceInfo()).contact?.account?.id;
    const fallback = contact && contact !== self ? contact : null;
    const selfText = await this.client.getNote(self).catch(() => null);
    if (selfText == null || !notePosition(selfText)) {
      const other = fallback ? await this.client.getNote(fallback).catch(() => null) : null;
      if (other != null && notePosition(other)) return (this.noteTarget = { id: fallback, text: other, fallback: null });
    }
    return (this.noteTarget = { id: self, text: selfText ?? '', fallback });
  }

  // Save the position to the note. Normally re-reads it first so another
  // device that has read further is never moved back; when the app is being
  // hidden there's only time for a single write.
  async flushNote(keepalive = false) {
    if (!this.noteDirty || !this.position || !this.settings.syncNote) return;
    this.noteDirty = false;
    clearTimeout(this.noteTimer);
    let target;
    try {
      target = await this.findNote();
      if (!keepalive) {
        target.text = await this.client.getNote(target.id);
        if (compareIds(notePosition(target.text), this.position) >= 0) return;
      }
      await this.writeNote(target, keepalive);
    } catch (err) {
      if (err.status === 403) {
        // Logged in before the app asked for write:accounts.
        if (!this.noteNeedsLogin) showToast('Log in again (in Settings) to sync your position across devices');
        this.noteNeedsLogin = true;
        this.updateSyncInfo();
        return;
      }
      if (err.status === 422 && target?.fallback) {
        // Mastodon won't take a note on your own account: use the fallback.
        this.noteTarget = { id: target.fallback, text: await this.client.getNote(target.fallback).catch(() => ''), fallback: null };
        try {
          await this.writeNote(this.noteTarget, keepalive);
          return;
        } catch (err2) {
          console.warn('Could not save the sync note', err2);
        }
      } else {
        console.warn('Could not save the sync note', err);
      }
      this.noteDirty = true;
    }
  }

  async writeNote(target, keepalive) {
    const text = withNotePosition(target.text, this.position);
    await this.client.setNote(target.id, text, { keepalive });
    target.text = text;
    this.noteNeedsLogin = false;
    this.updateSyncInfo();
  }

  updateSyncInfo() {
    $('#sync-login').hidden = !this.noteNeedsLogin;
    $('#sync-info').textContent = this.noteNeedsLogin
      ? 'Mastorss needs one more permission to save the note. Log in again to allow it.'
      : this.settings.syncNote && this.noteTarget
        ? `Saved in a private note on ${this.noteTarget.id === this.account.id ? 'your account' : "your server's contact account"} (only you can see it).`
        : '';
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

  // Put the first unread post just under the header. With nothing unread,
  // show the last few read posts with the "caught up" message below them,
  // rather than the message alone.
  jumpToFirstUnread() {
    const first = this.articles()[this.readCursor];
    if (first) {
      window.scrollTo(0, first.getBoundingClientRect().top + window.scrollY - this.headerHeight());
    } else if (this.readCursor) {
      const endTop = this.end.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, endTop - window.innerHeight * 0.6));
    }
  }

  async loadOlder() {
    if (this.loadingOlder || this.noMoreOlder || !this.oldest || !this.overlaysClosed()) return;
    this.loadingOlder = true;
    const status = $('#older-status');
    status.replaceChildren(...busyText('Loading older posts…'));
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
      // Prepend without moving what the reader is looking at. Adding content
      // above the viewport needs a matching scroll correction, and iOS drops
      // or delays those while a flick is still gliding, so wait for scrolling
      // to stop first.
      await this.scrollSettled();
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

  // On an iOS home-screen app, links to other sites open in an in-app Safari
  // viewer. If that page hands off to another app (YouTube, Mastodon, ...),
  // iOS leaves a blank viewer behind that we can neither detect nor close.
  // Optionally (off by default) send those links to Safari proper instead
  // (iOS 17+). The catch is that the other app's back button then returns to
  // Safari rather than Mastorss. If nothing happens (older iOS), fall back to
  // the normal behaviour.
  linksInSafari() {
    return IOS_HOME_SCREEN && this.settings.linksInSafari === true;
  }

  bindExternalLinks() {
    document.addEventListener('click', (e) => {
      if (!this.linksInSafari() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest('a[href]');
      if (!a) return;
      const url = new URL(a.href, location.href);
      const target = url.origin === location.origin ? null : safariUrl(url.href);
      if (!target) return;
      e.preventDefault();
      location.href = target;
      setTimeout(() => {
        if (document.visibilityState === 'visible') window.open(url.href, '_blank', 'noopener');
      }, SAFARI_FALLBACK_MS);
    });
  }

  bindUi() {
    this.bindExternalLinks();
    // The bar is position: fixed; pad the page by its real height (which
    // includes the iOS safe area and changes with text size).
    const bar = $('#bar');
    new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`)).observe(bar);

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

    // Browsers also fire scroll events when content is added or removed, so
    // note when the reader actually touched, wheeled, clicked or typed.
    let lastInput = 0;
    for (const type of ['touchmove', 'wheel', 'pointerdown', 'keydown']) {
      window.addEventListener(type, () => (lastInput = performance.now()), { passive: true });
    }
    window.addEventListener('touchstart', () => (this.touching = true), { passive: true });
    window.addEventListener('touchend', () => (this.touching = false), { passive: true });
    window.addEventListener('touchcancel', () => (this.touching = false), { passive: true });
    let ticking = false;
    window.addEventListener('scroll', () => {
      this.lastScrollAt = performance.now();
      if (ticking || !this.overlaysClosed()) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        this.trackRead({ byScrolling: performance.now() - lastInput < 1000 });
      });
    }, { passive: true });
    this.bindPull();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushNote(true);
        this.stopStream();
      } else {
        this.startStream();
        if (this.caughtUp) this.checkForNew({ background: true });
      }
    });
    window.addEventListener('pagehide', () => this.flushNote(true));

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

  // Resolves once the page has stopped scrolling (no finger down, no scroll
  // events for a moment, which covers iOS momentum scrolling).
  scrollSettled() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.touching && performance.now() - (this.lastScrollAt || 0) > 250) resolve();
        else setTimeout(check, 100);
      };
      check();
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
    let failed = false;
    let result = 'Fetched';
    const checking = this.caughtUp;
    this.startBusy(checking ? 'Checking for new posts…' : 'Loading…');
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
        this.leaveCaughtUp();
      }
      if (checking) result = fresh.length ? `Fetched ${fresh.length} new post${fresh.length === 1 ? '' : 's'}` : 'Fetched · no new posts';
      this.updateCount();
      this.trackRead();
      ok = true;
    } catch (err) {
      if (background) {
        console.warn('Background check failed', err);
        $('#last-checked').textContent = "Couldn't check for new posts, will try again shortly.";
        this.schedulePoll();
      } else {
        failed = true;
        this.handleError(err);
      }
    } finally {
      this.loading = false;
      // Always settle the status line, whatever happened above.
      if (!failed) this.endBusy(result);
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

  // Pull up past the end of the timeline to check for new posts: the
  // bottom-of-the-page version of pull-to-refresh, since new posts arrive
  // at the bottom.
  bindPull() {
    const PULL_PX = 70;
    const hint = $('#pull-hint');
    let startY = null;
    let armed = false;
    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const reset = () => {
      startY = null;
      armed = false;
      hint.textContent = 'Pull up to check for new posts';
      this.end.classList.remove('pulling');
    };
    window.addEventListener('touchstart', (e) => {
      if (!this.caughtUp || !this.overlaysClosed() || e.touches.length !== 1 || !atBottom()) return;
      startY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      const pulled = startY - e.touches[0].clientY;
      armed = pulled > PULL_PX && atBottom();
      this.end.classList.toggle('pulling', pulled > 10);
      hint.textContent = armed ? 'Release to check for new posts' : 'Pull up to check for new posts';
    }, { passive: true });
    window.addEventListener('touchend', () => {
      const go = armed;
      reset();
      if (go) this.checkForNew();
    });
    window.addEventListener('touchcancel', reset);
  }

  markCaughtUp() {
    this.caughtUp = true;
    this.end.classList.add('caught-up');
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

  // The status line fades in and out (see #end-status in styles.css). Its
  // contents are only removed once the fade-out has finished, and any new
  // status cancels a pending fade.
  setStatus(text, busy = false) {
    clearTimeout(this.statusTimer);
    clearTimeout(this.fadeTimer);
    const line = $('#end-status');
    if (!text) {
      line.classList.remove('show');
      this.fadeTimer = setTimeout(() => line.replaceChildren(), STATUS_FADE_MS);
      return;
    }
    line.replaceChildren(...(busy ? busyText(text) : [text]));
    requestAnimationFrame(() => line.classList.add('show'));
  }

  startBusy(text) {
    this.busySince = performance.now();
    this.setStatus(text, true);
  }

  endBusy(done) {
    if (performance.now() - this.busySince >= QUICK_FETCH_MS) {
      this.setStatus('');
      return;
    }
    this.setStatus(`✓ ${done}`);
    this.statusTimer = setTimeout(() => this.setStatus(''), FETCHED_SHOW_MS);
  }

  // A post counts as read once its bottom edge has scrolled up under the header.
  // Scrolling down to the "caught up" message also counts everything above
  // it as read, so the last few posts don't need a screen of empty space
  // below them. That only happens when the reader scrolls, never because a
  // new post arrived while they were already at the bottom.
  trackRead({ byScrolling = false } = {}) {
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
    const done = this.end.querySelector('.done');
    if (byScrolling && this.caughtUp && this.readCursor < items.length && done.getBoundingClientRect().bottom <= window.innerHeight) {
      for (; this.readCursor < items.length; this.readCursor++) {
        const node = items[this.readCursor];
        node.classList.add('read');
        this.setPosition(node.dataset.id);
      }
      advanced = true;
    }
    if (advanced) this.updateCount();
  }

  updateCount() {
    const unread = this.articles().length - this.readCursor;
    $('#count').textContent = unread || this.caughtUp ? `${unread}${this.caughtUp ? '' : '+'} unread` : '';
  }

  setPosition(id) {
    if (compareIds(id, this.position) <= 0) return;
    this.position = id;
    store.set(this.posKey, id);
    if (this.settings.syncNote) {
      this.noteDirty = true;
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => this.flushNote(), NOTE_SAVE_MS);
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
    panel.querySelector('.overlay-body').scrollTop = 0;
    this.overlays.push(panel);
    history.pushState({ overlay: panel.id }, '');
  }

  closeTopOverlay() {
    const panel = this.overlays.pop();
    if (panel) {
      panel.hidden = true;
      if (panel.id === 'thread') $('#thread-body').replaceChildren();
    }
  }

  async openThread(status) {
    const panel = $('#thread');
    const body = $('#thread-body');
    this.openOverlay(panel);
    this.threadStatus = status;
    body.replaceChildren(el('p', { class: 'hint pad' }, ...busyText('Loading conversation…')));
    body.scrollTop = 0;
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
        body.scrollTop = focus.offsetTop;
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
    results.replaceChildren(el('p', { class: 'hint pad' }, ...busyText('Searching…')));
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
    const sync = $('#sync-note');
    sync.checked = this.settings.syncNote;
    sync.onchange = () => {
      this.settings.syncNote = sync.checked;
      store.set(this.settingsKey, this.settings);
      if (sync.checked) {
        this.noteDirty = true;
        this.flushNote();
      }
      this.updateSyncInfo();
    };
    $('#sync-login').onclick = async () => {
      await this.flushNote(true);
      beginLogin(this.session.instance).catch(showError);
    };
    this.updateSyncInfo();
    $('#safari-row').hidden = !IS_IOS;
    const safari = $('#links-in-safari');
    safari.checked = this.linksInSafari();
    safari.onchange = () => {
      this.settings.linksInSafari = safari.checked;
      store.set(this.settingsKey, this.settings);
    };
    $('#position-info').textContent = this.position ? `Read up to post ${this.position}` : 'No position saved yet';
    $('#mark-all').onclick = async () => {
      if (!confirm('Skip everything and start from now?')) return;
      try {
        const latest = await this.client.latestHomeId();
        if (latest) this.setPosition(latest);
        await this.flushNote();
        location.reload();
      } catch (err) {
        showError(err);
      }
    };
    $('#logout').onclick = async () => {
      if (!confirm('Log out of this device?')) return;
      await this.flushNote();
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
  watchForUpdates();

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
