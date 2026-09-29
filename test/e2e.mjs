// End-to-end check against a fake Mastodon server.
//   npx http-server -p 8123 -c-1 .   (in another shell)
//   node test/e2e.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const APP = process.env.APP_URL || 'http://localhost:8123/';
const INSTANCE = 'https://mastodon.au';

// 120 posts, ids 1000..1119, oldest first.
const acct = (i) => ({ id: `a${i}`, username: `user${i}`, acct: `user${i}@example.social`, display_name: `User ${i} :blob:`, avatar: `${INSTANCE}/avatar.png`, avatar_static: `${INSTANCE}/avatar.png`, emojis: [{ shortcode: 'blob', url: `${INSTANCE}/blob.png` }] });
let posts = Array.from({ length: 120 }, (_, n) => status(1000 + n));
// A boost with an image, and a post with a link card.
posts[12] = { ...status(1012), account: acct(3), reblog: { ...status(900), media_attachments: [{ type: 'image', url: `${INSTANCE}/big.png`, preview_url: `${INSTANCE}/small.png`, description: 'a cat' }] } };
posts[13] = { ...status(1013), card: { url: 'https://example.com/article', title: 'An article', description: 'Something to read', provider_name: 'Example' } };
function status(id) {
  return {
    id: String(id),
    created_at: new Date(Date.now() - (2000 - id) * 60000).toISOString(),
    account: acct(id % 7),
    content: `<p>Post number ${id} <a href="${INSTANCE}/tags/test" class="mention hashtag">#<span>test</span></a> <img src=x onerror="window.pwned=1"><script>window.pwned=1</script></p>`,
    spoiler_text: id === 1014 ? 'spoilers' : '',
    sensitive: false,
    visibility: 'public',
    mentions: [],
    emojis: [],
    media_attachments: [],
    replies_count: 0, reblogs_count: 1, favourites_count: 2,
    favourited: false, reblogged: false, bookmarked: false,
    url: `https://example.social/@x/${id}`,
    reblog: null,
    filtered: id === 1005 ? [{ filter: { title: 'hidden', filter_action: 'hide' } }] : [],
  };
}

let serverMarker = '1010';
let failTimeline = false;
let timelineRequests = 0;
const markerPosts = [];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });

async function mockServer(ctx) {
  await ctx.route(`${INSTANCE}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    }
    switch (url.pathname) {
      case '/api/v1/apps':
        return json(route, { client_id: 'cid', client_secret: 'secret' });
      case '/oauth/authorize': {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'the-code');
        back.searchParams.set('state', url.searchParams.get('state'));
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        return route.fulfill({ status: 302, headers: { Location: back.toString() } });
      }
      case '/oauth/token': {
        const body = JSON.parse(req.postData());
        assert.equal(body.code, 'the-code');
        assert.ok(body.code_verifier);
        return json(route, { access_token: 'tok' });
      }
      case '/api/v1/accounts/verify_credentials':
        return json(route, { id: 'me', acct: 'bruce' });
      case '/api/v1/markers':
        if (req.method() === 'POST') {
          serverMarker = JSON.parse(req.postData()).home.last_read_id;
          markerPosts.push(serverMarker);
          return json(route, {});
        }
        return json(route, { home: { last_read_id: serverMarker } });
      case '/api/v1/timelines/home': {
        timelineRequests++;
        if (failTimeline) return json(route, { error: 'boom' }, 503);
        const limit = Number(url.searchParams.get('limit'));
        const min = url.searchParams.get('min_id');
        const newer = min ? posts.filter((p) => Number(p.id) > Number(min)).slice(0, limit) : posts.slice(-limit);
        return json(route, [...newer].reverse());
      }
      default:
        if (url.pathname.startsWith('/api/v1/statuses/')) return json(route, { ...posts[0], favourites_count: 3 });
        return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
    }
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
await mockServer(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e));

// Login
await page.goto(APP);
await page.fill('#instance', 'mastodon.au');
await page.click('#login-form button');
await page.waitForSelector('#reader:not([hidden])');
await page.waitForSelector('article.status');

// Starts right after the server marker (sync off falls back to it on first run).
const firstIds = await page.$$eval('article.status', (a) => a.slice(0, 3).map((n) => n.dataset.id));
assert.deepEqual(firstIds, ['1011', '1012', '1013'], 'starts after marker, oldest first');
assert.equal(await page.$('article[data-id="1005"]'), null);
assert.equal(await page.evaluate(() => window.pwned), undefined, 'no script execution');
assert.equal(await page.$('article img[src="x"]'), null, 'inline img stripped');
assert.equal(await page.$eval('article .content a', (a) => a.href), 'https://mastodon.au/tags/test');
assert.ok(await page.$('article .who img.emoji'), 'custom emoji rendered');
assert.ok(!(await page.textContent('#timeline')).includes('null'), 'no stray null text');
assert.ok(await page.$('article[data-id="1012"] .boosted-by'), 'boost rendered');
assert.ok(await page.$('article[data-id="1012"] .media img[alt="a cat"]'), 'image rendered');
assert.ok(await page.$('article[data-id="1013"] a.card'), 'card rendered');
assert.ok(await page.$('article[data-id="1014"] details.cw'), 'content warning rendered');

// Scroll through everything.
for (let i = 0; i < 80; i++) {
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(40);
}
await page.waitForSelector('#end.caught-up');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(200);
const pos = await page.evaluate(() => JSON.parse(localStorage.getItem('mastorss.pos.mastodon.au.me')));
assert.equal(pos, '1119', 'read to the end');
assert.equal(await page.textContent('#count'), '0 unread');
assert.ok((await page.$$('article.status')).length < 80, 'old read posts trimmed from DOM');
assert.deepEqual(markerPosts, [], 'server marker untouched while sync is off');

// New posts arrive; check for new.
posts.push(status(1120), status(1121));
await page.click('#check-new');
await page.waitForSelector('article[data-id="1121"]');

// Reload: resumes after position; nothing older is shown.
await page.reload();
await page.waitForSelector('article.status');
const afterReload = await page.$$eval('article.status', (a) => a.map((n) => n.dataset.id));
assert.deepEqual(afterReload, ['1120', '1121']);

// A failing load shows Retry and does not hammer the server.
failTimeline = true;
timelineRequests = 0;
await page.click('#check-new');
await page.waitForSelector('#retry:not([hidden])');
await page.waitForTimeout(500);
assert.equal(timelineRequests, 1, 'no retry loop');
failTimeline = false;
await page.click('#retry');
await page.waitForSelector('#end.caught-up');

// Turn marker sync on and confirm it is written.
await page.click('#menu');
await page.check('#sync-marker');
await page.click('#settings-close');
await page.waitForTimeout(300);
assert.equal(serverMarker, '1119');

// Favourite toggles.
await page.click('article[data-id="1120"] button[aria-label="Favourite"]');
await page.waitForFunction(() => document.querySelector('article[data-id="1120"] button[aria-label="Favourite"]').classList.contains('on'));

await page.screenshot({ path: process.env.SHOT || 'test/screenshot.png' });
await browser.close();
console.log('e2e ok');
