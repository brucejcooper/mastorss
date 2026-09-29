import { Client, beginLogin, finishLogin, normaliseInstance, revoke, compareIds } from './api.js';
import { renderStatus } from './render.js';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_INSTANCE = 'mastodon.au';
const PAGE_SIZE = 40;
const KEEP_READ_IN_DOM = 30;

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

function showError(err) {
  console.error(err);
  const bar = $('#toast');
  bar.textContent = err.message || String(err);
  bar.hidden = false;
  clearTimeout(showError.t);
  showError.t = setTimeout(() => (bar.hidden = true), 5000);
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
    this.loading = false;
    this.caughtUp = false;
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
    await this.loadMore();
    // Only start infinite loading once we know where the reader is up to.
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
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

  bindUi() {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        this.trackRead();
      });
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushMarker(true);
      else if (this.caughtUp) this.checkForNew();
    });
    window.addEventListener('pagehide', () => this.flushMarker(true));

    $('#check-new').onclick = () => this.checkForNew();
    $('#retry').onclick = () => this.loadMore();
    $('#refresh').onclick = () => (this.caughtUp ? this.checkForNew() : this.nextPost());
    $('#menu').onclick = () => this.openSettings();

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, dialog[open]')) return;
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

  async loadMore() {
    if (this.loading || this.caughtUp) return;
    this.loading = true;
    let ok = false;
    this.setStatus('Loading…');
    $('#retry').hidden = true;
    try {
      const page = await this.client.homeAfter(this.newest, PAGE_SIZE);
      if (!this.newest && !page.length) {
        this.markCaughtUp();
        return;
      }
      // With no saved position this is simply the most recent page.
      const fresh = page.filter((s) => compareIds(s.id, this.newest) > 0);
      for (const entry of fresh) {
        const node = renderStatus(entry, { instance: this.session.instance, client: this.client });
        if (node) this.list.append(node);
        this.newest = entry.id;
      }
      if (fresh.length < PAGE_SIZE) this.markCaughtUp();
      else this.setStatus('');
      this.updateCount();
      this.trackRead();
      ok = true;
    } catch (err) {
      this.handleError(err);
    } finally {
      this.loading = false;
    }
    // If the page did not fill the screen, keep going (but never retry in a loop).
    if (ok && !this.caughtUp && this.end.getBoundingClientRect().top < window.innerHeight + 2000) this.loadMore();
  }

  markCaughtUp() {
    this.caughtUp = true;
    this.end.classList.add('caught-up');
    this.setStatus('');
    this.updateCount();
  }

  async checkForNew() {
    this.caughtUp = false;
    this.end.classList.remove('caught-up');
    await this.loadMore();
    if (this.readCursor < this.articles().length) this.nextPost();
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
