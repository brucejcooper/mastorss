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
const posted = [];
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
        return json(route, { id: 'me', acct: 'bruce', source: { privacy: 'public' } });
      case '/api/v2/instance':
        return json(route, { configuration: { statuses: { max_characters: 500 }, urls: { streaming: 'wss://streaming.mastodon.au' } } });
      case '/api/v2/search':
        return json(route, {
          accounts: [acct(1)],
          hashtags: [{ name: 'cats', history: [{ uses: '3' }, { uses: '4' }] }],
          statuses: [status(1002)],
        });
      case '/api/v1/statuses':
        posted.push({ body: JSON.parse(req.postData()), key: req.headers()['idempotency-key'] });
        return json(route, status(5000));
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
        const max = url.searchParams.get('max_id');
        // Real servers return short pages mid-timeline (deleted/muted posts are
        // dropped after the limit), so never fill a page completely.
        let result;
        if (min) result = posts.filter((p) => Number(p.id) > Number(min)).slice(0, limit - 3);
        else if (max) result = posts.filter((p) => Number(p.id) < Number(max)).slice(-limit);
        else result = posts.slice(-limit);
        return json(route, [...result].reverse());
      }
      default: {
        const ctxMatch = url.pathname.match(/^\/api\/v1\/statuses\/(\d+)\/context$/);
        if (ctxMatch) {
          return json(route, {
            ancestors: [status(1001)],
            descendants: [{ ...status(2000), in_reply_to_id: ctxMatch[1] }, { ...status(2001), in_reply_to_id: '2000' }],
          });
        }
        const one = url.pathname.match(/^\/api\/v1\/statuses\/(\d+)$/);
        if (one) return json(route, posts.find((p) => p.id === one[1]) || status(Number(one[1])));
        if (url.pathname.startsWith('/api/v1/statuses/')) return json(route, { ...posts[0], favourites_count: 3 });
        return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
      }
    }
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
await mockServer(ctx);
let streamSocket;
const streamUrls = [];
await ctx.routeWebSocket(/\/api\/v1\/streaming/, (ws) => {
  streamSocket = ws;
  streamUrls.push(ws.url());
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e));

// Fake timers (still running in real time) so the 5 minute poll can be fast-forwarded.
await page.clock.install();

// Login
await page.goto(APP);
await page.fill('#instance', 'mastodon.au');
await page.click('#login-form button');
await page.waitForSelector('#reader:not([hidden])');
await page.waitForSelector('article.status');

const unreadIds = () => page.$$eval('#timeline article:not(.read)', (a) => a.map((n) => n.dataset.id));
const readCount = () => page.$$eval('#timeline article.read', (a) => a.length);
// The first unread post sits just under the header.
const firstUnreadOffset = () => page.evaluate(() => {
  const first = document.querySelector('#timeline article:not(.read)');
  return first.getBoundingClientRect().top - document.querySelector('#bar').getBoundingClientRect().height;
});

// Starts right after the server marker (sync off falls back to it on first run),
// with already-read posts above it and the view scrolled to the first unread.
assert.deepEqual((await unreadIds()).slice(0, 3), ['1011', '1012', '1013'], 'starts after marker, oldest first');
assert.equal(await readCount(), 10, 'read posts 1000-1010 (minus the filtered one) shown above');
assert.ok(Math.abs(await firstUnreadOffset()) < 2, 'scrolled to first unread');
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
assert.ok((await page.$$('#timeline article')).length < 80, 'old read posts trimmed from DOM');
assert.deepEqual(markerPosts, [], 'server marker untouched while sync is off');

assert.match(await page.textContent('#last-checked'), /automatically|as they arrive/);

// New posts arrive and are picked up by the background poll, no button needed.
posts.push(status(1120), status(1121));
await page.clock.runFor(5 * 60_000 + 1000);
await page.waitForSelector('article[data-id="1121"]');
await page.waitForSelector('#end.caught-up');

// Streaming: a pushed update loads the new post straight away.
assert.ok(streamUrls[0].startsWith('wss://streaming.mastodon.au/api/v1/streaming?stream=user'), streamUrls[0]);
assert.ok(!streamUrls[0].includes('tok'), 'token not in the URL');
assert.match(await page.textContent('#last-checked'), /as they arrive/);
posts.push(status(1122));
streamSocket.send(JSON.stringify({ event: 'update', payload: JSON.stringify(status(1122)) }));
await page.waitForSelector('#timeline article[data-id="1122"]');
await page.waitForSelector('#end.caught-up');

// Reload: resumes after the position, with the read posts above it.
await page.reload();
await page.waitForSelector('#timeline article:not(.read)');
assert.deepEqual(await unreadIds(), ['1120', '1121', '1122']);
assert.equal(await readCount(), 20);
assert.ok(Math.abs(await firstUnreadOffset()) < 2, 'scrolled to first unread after reload');

// Scrolling up loads older posts without moving what's on screen.
const anchorTop = () => page.$eval('#timeline article[data-id="1100"]', (n) => n.getBoundingClientRect().top);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForFunction(() => document.querySelectorAll('#timeline article.read').length > 20);
const top1 = await anchorTop();
await page.waitForTimeout(300);
assert.equal(Math.round(await anchorTop()), Math.round(top1), 'prepending keeps the view steady');
assert.deepEqual(await unreadIds(), ['1120', '1121', '1122'], 'older posts stay read');

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
assert.equal(serverMarker, await page.evaluate(() => JSON.parse(localStorage.getItem('mastorss.pos.mastodon.au.me'))));
assert.ok(Number(serverMarker) >= 1119);

// Thread: tapping a post opens the conversation in the app.
await page.evaluate(() => document.querySelector('#timeline article[data-id="1120"]').scrollIntoView());
await page.click('#timeline article[data-id="1120"] .content', { position: { x: 4, y: 4 } });
await page.waitForSelector('#thread:not([hidden]) article.focus[data-id="1120"]');
assert.deepEqual(await page.$$eval('#thread-body article', (a) => a.map((n) => n.dataset.id)), ['1001', '1120', '2000', '2001']);
assert.ok(await page.$('#thread-body article.d1[data-id="2000"]'));
assert.ok(await page.$('#thread-body article.d2[data-id="2001"]'), 'nested reply indented');

// Reply from the thread.
await page.click('#thread-body article.focus button[aria-label="Reply"]');
await page.waitForSelector('#compose[open]');
assert.equal(await page.inputValue('#compose-text'), '@user0@example.social ');
assert.ok(!(await page.textContent('#compose-context')).includes('pwned'), 'script text not shown in reply preview');
await page.type('#compose-text', 'Nice one https://example.com/a/very/long/link/that/counts/as/twenty/three');
assert.equal(await page.textContent('#compose-count'), String(500 - '@user0 Nice one '.length - 23));
await page.click('#compose-send');
await page.waitForFunction(() => !document.querySelector('#compose').open);
assert.equal(posted.length, 1);
assert.equal(posted[0].body.in_reply_to_id, '1120');
assert.equal(posted[0].body.visibility, 'public');
assert.match(posted[0].body.status, /^@user0@example\.social Nice one/);
assert.ok(posted[0].key, 'idempotency key sent');

// Back closes the thread and the timeline is where we left it.
await page.goBack();
await page.waitForSelector('#thread', { state: 'hidden' });
assert.equal(await page.$('#thread-body article'), null);

// Search: people link to their profile on the home server.
await page.keyboard.press('/');
await page.waitForSelector('#search:not([hidden])');
await page.fill('#search-q', 'cats');
await page.press('#search-q', 'Enter');
await page.waitForSelector('#search-results .account-row');
assert.equal(await page.$eval('#search-results .account-row', (a) => a.href), 'https://mastodon.au/@user1@example.social');
assert.equal(await page.$eval('#search-results .tag-row', (a) => a.href), 'https://mastodon.au/tags/cats');
assert.match(await page.textContent('#search-results .tag-row'), /7 posts this week/);
// A post in the results opens its thread on top of search; back returns to search.
await page.click('#search-results article[data-id="1002"] .content', { position: { x: 4, y: 4 } });
await page.waitForSelector('#thread:not([hidden]) article.focus[data-id="1002"]');
await page.goBack();
await page.waitForSelector('#thread', { state: 'hidden' });
assert.ok(await page.isVisible('#search'), 'search still open under the thread');
await page.goBack();
await page.waitForSelector('#search', { state: 'hidden' });

// New post (not a reply).
await page.click('#open-compose');
await page.fill('#compose-text', 'Hello world');
await page.selectOption('#compose-visibility', 'private');
await page.click('#compose-send');
await page.waitForFunction(() => !document.querySelector('#compose').open);
assert.equal(posted[1].body.in_reply_to_id, undefined);
assert.equal(posted[1].body.visibility, 'private');
assert.notEqual(posted[1].key, posted[0].key);

// Favourite toggles.
await page.click('#timeline article[data-id="1120"] button[aria-label="Favourite"]');
await page.waitForFunction(() => document.querySelector('#timeline article[data-id="1120"] button[aria-label="Favourite"]').classList.contains('on'));

await page.screenshot({ path: process.env.SHOT || 'test/screenshot.png' });
await browser.close();
console.log('e2e ok');
