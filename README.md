# Mastorss

A small PWA that reads your Mastodon home timeline the way an RSS reader does:

- The app keeps a **"read up to" marker**. Anything at or before it doesn't come back.
- You scroll **oldest → newest** from the marker until you run out ("You're all caught up").
- A post counts as read once it scrolls up past the top bar. Next time you open the app it starts at the first post you haven't read. Already-read posts sit above it, faded, and older ones keep loading as you scroll up.

In the app you can also:

- **Read conversations**: tap a post (or its time) to see the whole thread, with replies indented.
- **Reply and post**: 💬 opens a reply with the right @mentions, visibility and content warning. ✎ writes a new post.
- **Search** 🔍 for people, #hashtags and posts, or paste an `@user@server` handle or a post URL.
- **Favourite, boost and bookmark** in place.
- **See new posts as they arrive**, over Mastodon's streaming API.

People and hashtags open on your own server (`https://mastodon.au/...`), which is where you follow, unfollow, mute and so on. ↗ opens any post there too. Notifications stay in the normal Mastodon app.

It's a static site with no build step, no backend and no dependencies. It talks directly to your Mastodon server's API from the browser.

## Why not an existing client?

Before building this I looked at the main iOS clients (September 2026):

| Client | Position handling | Why it isn't quite this |
|---|---|---|
| **Ivory** (Tapbots) | Keeps your place and syncs it (iCloud; Mastodon markers planned/partial). Tweetbot-style: you open at your last-read post and scroll **up** towards newer ones. | Closest match. But newest is still at the top, older posts are still in the timeline, and it has to fill gaps before it can jump to your spot. |
| **Ice Cubes** | "Semi-automatic" timeline sync through the Mastodon marker API, plus a cached timeline and an unread counter. | Also reverse-chronological, reading upward. The marker is a convenience, not a hard boundary. |
| **Mona** | Very configurable; people who read oldest→newest praise it for filling gaps properly and showing the whole timeline. | Still a newest-on-top timeline you read upward, with a large settings surface. No "read is gone" model. |
| Mastodon (official), Elk, Phanpy, etc. | Official web UI *resets* the home marker instead of honouring it ([mastodon#23677](https://github.com/mastodon/mastodon/issues/23677)). Phanpy has a "catch-up" digest. | Newest-first and no persistent read boundary. |
| RSS bridges (account/tag RSS, Open RSS, feedi) | A real RSS reader gives you oldest-first and read state. | You lose your home timeline (boosts, the people you follow as a unit), and following people then happens in two places. |

Summary: Ivory, Ice Cubes and Mona all remember your spot, but they all read upward in a newest-first list. None treat "read" as gone or read top-to-bottom oldest-first. If you'd rather not self-host, **Ivory is the closest ready-made option**. Otherwise, this app.

## How it works

- **Login**: OAuth authorization-code flow with PKCE. The app registers itself with your server on first login (`POST /api/v1/apps`), using the URL it's served from as the redirect URI. Scopes: `read write:favourites write:statuses write:bookmarks` (`write:statuses` covers posting, replying and boosting).
- **Reading**: `GET /api/v1/timelines/home?min_id=<marker>` returns the page directly after the marker. That page is reversed to oldest-first, and each next page is fetched after the newest post loaded so far. On load, `max_id` fetches the 20 posts up to and including the marker. The page is then scrolled so the first unread post sits under the header. Scrolling up fetches older pages and inserts them without moving what's on screen.
- **Keeping up**: it keeps loading pages as you scroll. It only says you're caught up when the server returns an empty page, since Mastodon returns short pages mid-timeline when it drops deleted or muted posts. Once you're caught up, new posts arrive over a WebSocket to the streaming API (`stream=user`), which only exists while the app is on screen. Each `update` event triggers a normal timeline fetch, so ordering, filters and the marker all work as usual. As a fallback it also checks when you come back to the app, when you scroll to the end, every 5 minutes, or when you tap "Check now".
- **Threads and search**: `GET /api/v1/statuses/:id/context` and `GET /api/v2/search?resolve=true`. Mastodon's full-text post search only covers posts you've written, favourited, boosted, bookmarked or been mentioned in, unless your server has opted into wider search.
- **Marker**: stored per account in `localStorage` and saved as you scroll. Read posts are pruned from the page as you go so long sessions stay light.
- **Filters**: server-side filters are respected. "Hide" filters drop the post, "warn" filters collapse it.
- **Content**: remote HTML is run through an allowlist sanitiser. The nginx config adds a CSP as a second layer.

### Syncing between devices

Settings has an optional **"Sync my position through Mastodon's timeline marker"** switch. It's off by default, because other clients write to the same marker. In particular, Mastodon's own web UI resets it to the newest post when it loads, which would make Mastorss skip everything you hadn't read. Turn it on if you read Mastorss on more than one device and don't use the Mastodon web UI. When it's on, Mastorss uses whichever position is further along, local or server.

### Things to know

- **Mastodon only keeps about the last 800 posts in each home feed.** If you're away long enough for more than that to arrive, the oldest unread posts are no longer served by the API. Mastorss starts from the oldest post still available, and there's no way to get the rest back.
- Composing is deliberately simple: text, content warning and visibility. For media uploads, polls or editing, use ↗ to open the post on your server.

## Running it

### Try it locally

```sh
npm start   # serves on http://localhost:8123
```

`localhost` counts as a secure origin, so login and the service worker work without HTTPS.

### On GitHub Pages (for testing)

`.github/workflows/pages.yml` runs the e2e test on every push, and on `main` publishes the app to `https://brucejcooper.github.io/mastorss/`.

One-time setup:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Pages on a private repo needs a paid GitHub plan. Otherwise make the repo public.
2. Re-run the workflow (Actions → Deploy to GitHub Pages → Run workflow).

Notes:
- GitHub Pages can't set headers, so the CSP is also in a `<meta>` tag in `index.html`.
- Every Pages site under `brucejcooper.github.io` shares one origin, and therefore one `localStorage`. Your login token and reading position are readable by your other Pages sites. That's fine for testing, and another reason to self-host for real use.
- Logging in at the Pages URL registers a separate app with mastodon.au. When you move to the home server you'll log in again there, and the reading position starts fresh unless marker sync is on.

### On your home server

PWAs need **HTTPS** (for the service worker, `crypto.subtle` for PKCE, and "Add to Home Screen" as an app). Any static file server works. A Docker image with nginx is included:

```sh
docker compose up -d --build     # serves on :8080
```

Then put HTTPS in front of it. Two easy options:

- **Tailscale** (private to your devices, nothing exposed to the internet):
  `tailscale serve --bg 8080` → `https://<machine>.<tailnet>.ts.net/`
- **Caddy** with a real domain (automatic Let's Encrypt):
  ```
  mastorss.example.com {
      reverse_proxy localhost:8080
  }
  ```

Mastodon only needs to redirect your browser back to the app, so the app doesn't have to be reachable from mastodon.au. A Tailscale-only URL works.

The redirect URI is registered per URL, so if you move the app to a new address, log in again there.

### Installing on iPhone

1. Open the HTTPS URL in Safari → Share → **Add to Home Screen**.
2. Open it from the home screen and log in (`mastodon.au` is pre-filled).
3. If approving on mastodon.au leaves you in a Safari sheet instead of back in the app, tap **"Log in with a code instead"**, approve, and paste the code it shows. Home-screen apps have storage separate from Safari, so the login has to finish inside the installed app.

Keyboard (iPad/desktop): `j` next post, `k` back, `/` search, `n` new post, `r` check for new posts once caught up, `Esc` close a thread or search.

## Development

```sh
npm install
npm start &     # http://localhost:8123
npm test        # Playwright e2e against a mocked Mastodon server
```

The test covers login (PKCE), starting after the marker, oldest-first order, filtered/sanitised content, reading to the end, pruning, checking for new posts, resuming after reload, marker sync, and favouriting.

Files:

- `index.html`, `styles.css`: shell and styling (light/dark)
- `js/api.js`: OAuth + Mastodon API
- `js/render.js`: status rendering and HTML sanitising
- `js/app.js`: reader logic (marker, paging, read tracking)
- `sw.js`: service worker (caches the app shell only, never API responses)
- `deploy/nginx.conf`, `Dockerfile`, `compose.yaml`: hosting
