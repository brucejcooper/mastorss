// Thin Mastodon API client + OAuth (authorization code with PKCE, plus a
// paste-the-code fallback for iOS home-screen apps where the redirect can
// land in the wrong browser context).

const SCOPES = 'read write:favourites write:statuses write:bookmarks';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const APP_NAME = 'Mastorss';

export function redirectUri() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  return u.toString();
}

// Per-copy key for the login in progress (see the scoping note in app.js).
const pendingKey = () => `mastorss.pending.${redirectUri()}`;

export function normaliseInstance(input) {
  let s = (input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(s)) throw new Error('That does not look like a server name');
  return s;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

async function registerApp(instance) {
  const key = `mastorss.app.${instance}.${redirectUri()}`;
  const cached = localStorage.getItem(key);
  if (cached) return JSON.parse(cached);
  const res = await fetch(`https://${instance}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: APP_NAME,
      redirect_uris: `${redirectUri()}\n${OOB}`,
      scopes: SCOPES,
      website: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Could not register app with ${instance} (${res.status})`);
  const app = await res.json();
  localStorage.setItem(key, JSON.stringify(app));
  return app;
}

// Starts the login. Returns the authorize URL for the out-of-band flow when
// `oob` is set, otherwise navigates away.
export async function beginLogin(instance, { oob = false } = {}) {
  const app = await registerApp(instance);
  const verifier = randomString(48);
  const state = randomString(16);
  const redirect = oob ? OOB : redirectUri();
  localStorage.setItem(pendingKey(), JSON.stringify({ instance, verifier, state, redirect }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: app.client_id,
    redirect_uri: redirect,
    scope: SCOPES,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  const url = `https://${instance}/oauth/authorize?${params}`;
  if (!oob) location.assign(url);
  return url;
}

// Exchanges an authorization code for a token. `state` is checked when present
// (it is absent in the paste-the-code flow).
export async function finishLogin(code, state) {
  const pending = JSON.parse(localStorage.getItem(pendingKey()) || 'null');
  if (!pending) throw new Error('No login in progress');
  if (state && state !== pending.state) throw new Error('Login state mismatch, please try again');
  const app = await registerApp(pending.instance);
  const res = await fetch(`https://${pending.instance}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: pending.redirect,
      code_verifier: pending.verifier,
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const token = await res.json();
  localStorage.removeItem(pendingKey());
  return { instance: pending.instance, token: token.access_token };
}

export async function revoke(session) {
  const app = JSON.parse(localStorage.getItem(`mastorss.app.${session.instance}.${redirectUri()}`) || 'null');
  if (!app) return;
  await fetch(`https://${session.instance}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, token: session.token }),
  }).catch(() => {});
}

export class Client {
  constructor({ instance, token }) {
    this.instance = instance;
    this.token = token;
  }

  async request(path, { method = 'GET', body, keepalive = false, headers = {} } = {}) {
    const res = await fetch(`https://${this.instance}${path}`, {
      method,
      keepalive,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const err = new Error('Your session has expired, please log in again');
      err.unauthorised = true;
      throw err;
    }
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`);
    return res.json();
  }

  verify() {
    return this.request('/api/v1/accounts/verify_credentials');
  }

  // Posts strictly newer than `sinceId`, returned oldest first.
  async homeAfter(sinceId, limit = 40) {
    const q = new URLSearchParams({ limit });
    if (sinceId) q.set('min_id', sinceId);
    const page = await this.request(`/api/v1/timelines/home?${q}`);
    return page.reverse();
  }

  // Posts strictly older than `beforeId`, returned oldest first.
  async homeBefore(beforeId, limit = 20) {
    const page = await this.request(`/api/v1/timelines/home?${new URLSearchParams({ limit, max_id: beforeId })}`);
    return page.reverse();
  }

  async latestHomeId() {
    const [s] = await this.request('/api/v1/timelines/home?limit=1');
    return s ? s.id : null;
  }

  async getMarker() {
    const m = await this.request('/api/v1/markers?timeline[]=home');
    return m.home ? m.home.last_read_id : null;
  }

  setMarker(id, { keepalive = false } = {}) {
    return this.request('/api/v1/markers', { method: 'POST', body: { home: { last_read_id: id } }, keepalive });
  }

  context(statusId) {
    return this.request(`/api/v1/statuses/${statusId}/context`);
  }

  search(q) {
    return this.request(`/api/v2/search?${new URLSearchParams({ q, resolve: 'true', limit: 20 })}`);
  }

  instanceInfo() {
    this.info ??= this.request('/api/v2/instance').catch(() => ({}));
    return this.info;
  }

  async maxChars() {
    return (await this.instanceInfo()).configuration?.statuses?.max_characters || 500;
  }

  // Real-time stream of the home timeline. The token goes in the WebSocket
  // subprotocol (which Mastodon accepts) rather than the URL, so it doesn't
  // end up in server logs.
  async openStream() {
    const base = (await this.instanceInfo()).configuration?.urls?.streaming || `wss://${this.instance}`;
    return new WebSocket(`${base.replace(/\/$/, '')}/api/v1/streaming?stream=user`, this.token);
  }

  // `idempotencyKey` stops a retried or double-tapped submit posting twice.
  post({ status, inReplyToId, visibility, spoilerText, idempotencyKey }) {
    return this.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        status,
        in_reply_to_id: inReplyToId || undefined,
        visibility,
        spoiler_text: spoilerText || undefined,
        sensitive: !!spoilerText,
      },
    });
  }

  toggle(statusId, action, on) {
    const verb = { favourite: ['favourite', 'unfavourite'], reblog: ['reblog', 'unreblog'], bookmark: ['bookmark', 'unbookmark'] }[action];
    return this.request(`/api/v1/statuses/${statusId}/${on ? verb[0] : verb[1]}`, { method: 'POST' });
  }
}

// The id just above `id`, so `max_id` (which is exclusive) includes `id` itself.
export function nextId(id) {
  return (BigInt(id) + 1n).toString();
}

// Mastodon IDs are numeric strings that may exceed 2^53, so compare as strings.
export function compareIds(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : 1;
}
