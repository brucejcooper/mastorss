# Mastorss

A small PWA that reads your Mastodon home timeline the way an RSS reader does:

- The app keeps a **"read up to" marker**. Anything at or before it doesn't come back.
- You scroll **oldest → newest** from the marker until you run out ("You're all caught up").
- A post counts as read once it scrolls up past the top bar, or when you scroll down to the "You're all caught up" message below it. On a phone, pull up past that message to check for new posts. Next time you open the app it starts at the first post you haven't read. Already-read posts sit above it, faded, and older ones keep loading as you scroll up.

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
- **Marker**: stored per account in `localStorage` and saved as you scroll. Nothing is removed from or added above the part of the page you're reading while you scroll. On iOS, the scroll correction that would need is delayed while a flick is gliding, and the posts that briefly slid under the top bar got marked read. Older posts are only inserted once scrolling has stopped.
- **Filters**: server-side filters are respected. "Hide" filters drop the post, "warn" filters collapse it.
- **Content**: remote HTML is run through an allowlist sanitiser. The nginx config adds a CSP as a second layer.

### Syncing between devices

Settings has an optional **"Sync my position across devices"** switch. Your position is kept in a **private note on your own Mastodon account**: the note Mastodon lets you attach to any account, which only you can see. Mastorss writes one line to it, `mastorss:{"home":"<post id>"}`, and leaves anything else in the note alone.

Why not Mastodon's timeline marker, which is built for this? Every client writes to it. Mastodon's own web UI, for example, sets it to the newest post whenever it's active, so a sleeping laptop tab could make Mastorss skip everything you hadn't read. No other client touches account notes.

- **On startup**, Mastorss uses whichever is further along: this device's position or the note's.
- **As you read**, it saves a few seconds after you move on, and when you switch away. It re-reads the note first, so a device that has read further is never moved back.
- **The note needs the `write:accounts` permission**, which versions before note sync didn't ask for. If you logged in before then, Settings shows a "Log in again" button.
- **If your server refuses a note on your own account**, Mastorss uses the note on your server's contact account instead (from `/api/v2/instance`). Every device follows the same rule, so they all find the same note.

The timeline marker is still read once, on a device's very first run when nothing is saved yet. Mastorss never writes it.

### Curated feed

Optionally, Mastorss merges in articles picked for you by a
[curator](https://git.8bitcloud.com/bruce/curator) service: news and posts from
RSS feeds, Mastodon hashtags and Bluesky, grouped by story and filtered by a
classifier trained on your votes. Put its feed address and vote token in
Settings → Curated feed; they're stored only in this browser.

- **Placement**: each story carries a `sort_id` in Mastodon's id format
  (milliseconds << 16, from when the curator first saw it), so it slots in
  among posts by time and shares the reading position, the sync note and
  "Mark everything read".
- **No doubles**: stories the curator found in your own home timeline are
  left out, since the timeline already shows them.
- **Each card** shows the source, the article title (linking to it), its
  picture when there is one, and its summary (long ones open in place with
  **Show more**; posts from Mastodon and Bluesky show their full text), other outlets that covered the same story, and "Why this?" (the
  classifiers' scores). 👍/👎 go to the curator as training votes; pressing
  again clears a vote. Opening the article is reported too.
- **Every curated card says what it is** above the source: "📰 Picked for
  you by the curator", or "🤔 Maybe" (also marked with a dashed edge).
- **"Maybe" cards** are ones the deciding classifier would have
  dropped but the other one wouldn't, plus a small random sample. Voting on
  these is what teaches the curator about its blind spots.
- The feed is fetched at most once a minute, whenever Mastorss checks for new
  posts.

### Things to know

- **Mastodon only keeps about the last 800 posts in each home feed.** If you're away long enough for more than that to arrive, the oldest unread posts are no longer served by the API. Mastorss starts from the oldest post still available, and there's no way to get the rest back.
- On an iPhone/iPad home-screen app, links to other sites open in iOS's in-app viewer. If a link hands off to another app (YouTube, Mastodon, …), that viewer is left blank ("Search or enter website name") when you come back: tap Done to close it. A web app can't detect or close the viewer itself. The Settings option "Open links in Safari" (off by default, iOS 17+) avoids the blank page, but the other app's back button then goes to Safari instead of Mastorss.
- Composing is deliberately simple: text, content warning and visibility. For media uploads, polls or editing, use ↗ to open the post on your server.

## Running it

### Try it locally

```sh
npm start   # serves on http://localhost:8123
```

`localhost` counts as a secure origin, so login and the service worker work without HTTPS.

### On GitHub Pages

`https://brucejcooper.github.io/mastorss/` is published from `main`:

- `.github/workflows/ci.yml` runs the e2e test on every push.
- `.github/workflows/pages.yml` runs once CI passes on `main` and publishes it. It runs as a `workflow_run` job, which GitHub runs as the default branch, so the `github-pages` environment accepts it.

Notes:
- GitHub Pages can't set headers, so the CSP is also in a `<meta>` tag in `index.html`.
- Every Pages site under `brucejcooper.github.io` shares one origin and therefore one `localStorage`, so your other Pages sites could read the token. That's another reason to self-host for real use. Storage keys are scoped by folder (`…@/mastorss/`), so copies served from different folders on the same origin don't share a login or position.

### Updates

Each deploy writes a `version.json` with the commit and its date. Settings shows it at the bottom ("Version 4691a93 · 30 Sep 2026, 11:04 pm"), with a **Check for update** button that reloads if a newer version is out. iOS keeps home-screen apps suspended for days, so the app checks this file whenever it comes back to the foreground and every 30 minutes while open. If a new version has been deployed, it reloads straight away when nothing is open; your reading position is saved, so you land in the same place. If a thread, search or the composer is open, it shows a "New version available · Reload" bar instead. A fresh launch always fetches the latest files, because the service worker is network-first.

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

### Diagnostics

☰ → **Copy diagnostics** copies a plain-text report you can paste into a message. If the clipboard is blocked, it opens the share sheet instead. The report has a header (version, device, screen, settings, position and page state) and the last 400 events, which survive reloads:
- each batch of posts marked read, with the reason, the scroll position, how long since you last touched the screen, and where the posts were relative to the top bar;
- newer and older posts loaded, and how much the page was shifted to compensate;
- page jumps with no touch;
- sync-note reads and saves, live-update connects and disconnects, the app being hidden or shown, update reloads, and JavaScript errors.

It holds post ids and positions only: no post text, names or tokens.

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
