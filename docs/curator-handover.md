# Curator: handover brief

A brief for a fresh Claude Code session (desktop) to build the **curator**: a
self-hosted, AI-curated news and article feed for Bruce, read through Mastorss.
It records what was decided in the first session (web, 29 Sep – 1 Oct 2026) so
nothing has to be re-derived. Read it start to end before doing anything.

The person is Bruce Cooper (`bruce@mechination.com.au`, Perth, Australia,
timezone `Australia/Perth`). Use they/them for anyone else mentioned.

---

## 1. Where things stand

| Thing | State |
|---|---|
| **Mastorss** (the reader) | Built and live at `https://brucejcooper.github.io/mastorss/`. Repo `brucejcooper/mastorss` on GitHub, deployed from `main` by GitHub Actions to Pages. Single deployment; every change goes to prod after CI passes. See its `README.md`. |
| **The curator** | Not started. This brief is the design. |
| **Repo for the curator** | To be created: `bruce/curator` on Bruce's private Forgejo, `https://git.8bitcloud.com` (Forgejo 15, reachable on the public internet, SSH on port 222). Needs a token with `repository` read/write. On the desktop, use `gh`-style or plain git with the token in Keychain; never paste tokens into chat or commit them. |
| **Homelab** | `brucejcooper/homelab` on GitHub (private; kept there because of the bootstrap problem). Read its `CLAUDE.md`, `README.md`, `docs/DECISIONS.md`, `stacks/README.md`, `stacks/caddy/Caddyfile` and `ansible/group_vars/docker_vm/vars.yml` before touching anything. Conventions summarised in §7. |

---

## 2. What Bruce wants (in their words, condensed)

- An **AI-curated list of news and articles personalised just for them**: an
  aggregator and filter in one.
- Sources: ABC News topic feeds, their wife's blog, the Mastodon bots they
  follow, Mastodon hashtags they find interesting, and ideally the X/Bluesky
  equivalents "that aren't just advertising and rage bait".
- **Deduplicate**: several sites report the same news; **group articles on the
  same story and rank which is most informative**.
- **Reinforcement** via 👍/👎 in Mastorss.
- **Use as much of their behaviour as possible** as signals: browsing history,
  Claude history, Mastodon activity. Happy to feed it all into a local model.
- A "slow-moving model of me": Claude summarises interests, history and
  conversations **once a day** into a profile, which also says **which hashtags
  and websites to scrape**. The fast loop classifies everything against it.
- **Compare two classifiers in parallel over time**: Jev (hosted, from
  TypeSafe AI) versus a custom local classifier built on embeddings. Bruce has
  a Jev account and is happy to pay for it. Haiku as fallback is fine; they
  "romanticise" a non-LLM filter because it's cheaper.
- A **daily briefing** is a nice-to-have.
- Everything **git-controlled** so its evolution is visible, including the
  profile and the never-collect list, on Forgejo.
- Mastorss should **fetch the curated feed and merge it in**. The feed can be
  public at an obscure URL; nothing in it is private.

---

## 3. Design

Two loops in one container on the homelab, plus a small agent on the Mac.

### 3.1 Slow loop (daily): Claude builds the model of Bruce

Reads: recent browsing history (Firefox + Safari), Claude Code sessions and
claude.ai exports, Mastodon favourites/boosts/bookmarks/follows, Mastorss votes
and reading events, **and yesterday's profile**. Writes a profile in three parts:

1. **`profile/profile.md`**: who Bruce is and what they care about, in plain
   English, interests weighted by recency ("this week: …; standing: …").
2. **`profile/sources.yaml`**: what to scrape. Fixed entries (ABC feeds, the
   blog, Mastodon home) plus hashtags/sites Claude adds and retires.
3. **`profile/jev-questions.yaml`**: the typed questions and criteria the fast
   loop sends to Jev (see 3.3). Claude rewrites these as votes come in, so the
   "learning" on the Jev side is legible: you can read what changed.

"Slow-moving" by construction: Claude revises yesterday's profile rather than
starting fresh. A few thousand tokens once a day; use `claude-sonnet-5-5` if
Haiku's version isn't good enough. **All three files are committed to the
curator repo by the daily job** so the model of Bruce has a git history.

Seed profile v1 by interviewing Bruce. Known facts to start from:

- Software engineer. Likes computers generally. Apple hardware by preference;
  also Linux, the homelab, Home Assistant.
- Uses AI at work; interested in **novel uses of AI**. Current work project: a
  **customer model** for better support problem resolution, investigating
  Jev and its clones, a ModernBERT classifier, and gradient-boosted decision
  trees, rather than "just making a bot".
- **Home brewer**, likes IPAs. New modern architect-designed home.
- Wife: artist, jeweller and metalsmith, focus on Indigenous affairs, climate
  change and political outrage from a left-leaning perspective. Blog:
  `https://melissacameron.net`, RSS at **`https://melissacameron.net/blog/feed.xml`**
  (verified: RSS, 20 items with summaries, advertised correctly by the site).
- Uses Claude extensively: phone (claude.ai), Claude Code on the Mac, desktop
  app for research (less often).
- Browser: **Firefox on the Mac, Safari on the iPhone**.

### 3.2 Fast loop (every 15 min): collect, resolve, judge, publish

**Collect** from `sources.yaml`: RSS/Atom; Mastodon bots and hashtags via the
Mastodon API with Bruce's login (server `mastodon.au`); Bluesky hashtags (open
API). **X: skip.** No free, dependable way in; scraping breaks; bridges are
dead or account-only. Revisit only for specific accounts.

**Resolve the story** (the dedup/grouping Bruce asked for):

- Identical: same link after stripping tracking params, or near-identical
  title → dropped.
- Same story, different outlets: every item gets a local embedding; items
  within 72 h above ~0.75 cosine similarity form one *story* (Cruxwire's
  proven default; tune it).
- Best version: rank within the story by summary length, originality (earliest
  item), source reputation from votes, freshness. Only the lead goes in the
  feed, with "also covered by …" links.

**Judge**, cheapest first:

1. **Rules**: hard drops ("… local news briefing" for non-WA places, blocked
   domains), "always show" (the blog).
2. **Two classifiers in parallel** (§3.3). One is the *decider*; the other runs
   in shadow. Both verdicts are stored for every item.
3. **Haiku (`claude-haiku-4-5`) for the uncertain middle**, batched ~25 items per
   call with the profile cached. Verdicts feed the local model as training data.

**Publish**: JSON Feed (easiest for Mastorss) and RSS at an obscure path; each
item carries score, reason, story group, "also covered by". A small endpoint
accepts votes and reading events (bearer token). A status page (behind
authentik) shows the scorecard (§3.4) and a switch for which classifier decides.

**Daily briefing** (later): Haiku writes a short morning read from the top
stories, published as one special item.

### 3.3 The two classifiers

**Jev** (TypeSafe AI, `https://jevai.net`): a hosted "System One" classifier.
Send text plus typed questions (yes/no "noul", choice with criteria, score with
2–10 described levels); get calibrated probabilities in 70–500 ms. No free
text, no reasoning. Facts gathered:

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, bearer auth, body
  `{model: "jev-latest", state: <text>, questions: {id: {type, instructions,
  criteria}}}`; response `answers` keyed by id with probabilities and
  `confidence`, plus `usage`.
- ~64k tokens per request shared across state and questions. Up to 255
  choice options. Rate limits generous.
- Price: **$0.042 per million input tokens, output free**. A day of 1,000 items
  with a 2,000-token profile ≈ 8 cents.
- Hosted only; model proprietary; SDKs MIT. It sees the profile summary and
  headlines, never raw history. Bruce accepted this.
- Known weaknesses: reads literally, no arithmetic/dates, confident wrong
  answers when the right option isn't offered → **always include an
  "other/unsure" option**. Reviews tested only a handful of cases; validate on
  Bruce's votes.
- Sources: `https://flaviocopes.com/jev/` (API details),
  `https://www.mindstudio.ai/blog/jev-system-one-model-classification` (test).

**Local classifier** (local-first, CPU only; Bruce's preference):

- Embeddings from a small sentence-transformer: start with `nomic-embed-text`
  or `bge-small`; ModernBERT-based embedders are an option later. Each item
  embedded once (~10–30 ms on CPU).
- Features: similarity to the profile's interest topics and to up/down-voted
  items; clickbait and outrage scores from small off-the-shelf HF classifiers;
  source, author, outlet count, freshness; Haiku's verdict when there was one.
- Model: logistic regression, retrained on every vote. Past a few hundred votes,
  try gradient-boosted trees over the same features (Bruce's interest).
- Explainable: record which features drove each verdict.

**Google Coral**: Bruce has one. **Don't use it.** Edge TPU only runs small
8-bit TFLite models with ~8 MB on-chip; transformer ops mostly fall back to
CPU; conversion from PyTorch is painful. These text models are fast enough on
the CPU (32 GB RAM, no GPU, moderately old PVE host). Already explained to Bruce.

### 3.4 The comparison

- Both classifiers score everything; one decides. Start with Jev deciding (the
  local model needs votes first); flip later from the status page.
- **"Maybe" lane** in Mastorss: items where the two disagree, plus a small
  random sample of dropped items, clearly marked, so votes cover each model's
  blind spots, not just what reached the feed.
- Nightly **scorecard** per classifier: precision/recall vs votes,
  **calibration** (Jev's whole pitch), disagreement rate and who won each
  disagreement, cost and latency. The daily Claude pass summarises *what kind*
  of item each gets wrong.

### 3.5 Behaviour signals and the Mac agent

A small Python program on the Mac, run every 15 min by **launchd**:

- **Firefox (Mac)**: history is in the profile's `places.sqlite`. Locked while
  Firefox runs → copy the file, read the copy. Months/years of history to
  bootstrap from.
- **Safari (iPhone)**: syncs via iCloud to the Mac's `~/Library/Safari/History.db`
  (SQLite). Needs iCloud Safari sync on both devices and **Full Disk Access**
  for the agent/terminal. Sync lag of minutes to hours is fine.
- **Claude Code**: sessions are JSONL under `~/.claude/projects/…`. Send only
  Bruce's own messages, not Claude's replies or tool output.
- **claude.ai**: no API. Monthly **Export data** zip (Settings → Privacy)
  dropped in a watched folder. Do not scrape the site.
- **Mastodon** favourites/boosts/bookmarks: the curator pulls these itself.
- Firefox Sync (unofficial clients, hand over the password): **rejected**.
  A Firefox extension (dwell time, scroll depth): possible later, not v1.
- Sends titles and URLs only, never page contents; posts to the curator with a
  shared secret.

**Never-collect list** (agreed): a git-tracked file in the curator repo,
`agent/never-collect.yaml`, applied on the Mac *before* anything is sent.
Rules: domains incl. subdomains; URL patterns (`/login`, `/checkout`,
`token=`); built-in categories (banks, health, government services, password
managers, webmail); private browsing is never in history anyway. Adding a rule
later purges matching history on the homelab. Plus `curator-agent pause 2h`
and `curator-agent forget example.com`. The agent logs a daily count of
dropped visits, no URLs. Raw history kept 90 days on the homelab; embeddings
kept; the daily profile is a summary, never a log. Only item text goes to
Jev/Claude, never raw history. The list contains sensitive domains → private
repo only (Forgejo qualifies).

### 3.6 What others have built (for reference, not to copy)

- **Cruxwire** (`https://github.com/philoking/cruxwire`): local LLM scores 0–10
  against per-category "interest descriptions"; embedding clustering at 0.74;
  per-source affinity and a "taste boost" learned from opens/saves. Python,
  no deps.
- **PersonalRSS** (`https://github.com/andresdelcampo/PersonalRSS`): explicitly
  non-LLM; logistic classifier over title/summary words; four feedback actions
  ("always/never this topic", "interested/not"); **High / Maybe / Filtered**
  buckets; shows why each article scored as it did. Borrow: explicit rules kept
  separate from learned scores; the Maybe bucket; evidence display.
- Kagi News/Kite (`https://github.com/kagisearch/kite-public`), Particle:
  commercial "group coverage, summarise from several perspectives".

---

## 4. Build order

1. **Repo + design doc**: create `bruce/curator` on Forgejo with layout
   `profile/`, `agent/`, `curator/`, `docs/`; put a cleaned-up version of this
   brief in `docs/`.
2. **Profile v1**: interview Bruce (short), write the three profile files,
   commit. Then the daily refresh job using Mastodon activity (easy signal).
3. **Mac agent** early (small job; history accumulates while the rest is built).
4. **Curator v1**: scraping per `sources.yaml`, local embeddings and story
   grouping, rules, Jev deciding, local model in shadow, JSON Feed + RSS.
5. **Mastorss**: fetch the feed, merge by time with its own read position,
   "also covered by" links, 👍/👎, the maybe lane. Mastorss is vanilla JS with no
   build step, Playwright e2e in `test/e2e.mjs`; follow its README.
6. **Scorecard page**, decider switch, Haiku for the middle.
7. **Behaviour signals** into the daily profile build.
8. **Daily briefing**, per-source trust, polish.

Python for the curator and the agent (the embedding/classifier libraries
assume it). Bruce hasn't objected.

---

## 5. Claude API notes (checked 1 Oct 2026)

- Model IDs: `claude-haiku-4-5` ($1/M input, $5/M output), `claude-sonnet-5-5`
  ($2/$10), `claude-opus-5-5` ($4/$20). Use the exact strings; no date suffixes.
- Haiku 4.5 is the one current model that still takes
  `thinking: {type: "enabled", budget_tokens: N}`; the others use adaptive
  thinking. Prompt caching: put the profile in `system` with
  `cache_control: {type: "ephemeral"}` and the items after it.
- Batch API is 50% off for anything that can wait; fine for the nightly jobs.
- Load the `claude-api` skill before writing API code; its docs are
  authoritative over memory.

---

## 6. Mastorss: what to know before touching it

- Live at `https://brucejcooper.github.io/mastorss/`; version shown in Settings
  (short commit + date); the app auto-reloads on new deploys.
- Reading position is synced through a **private note on Bruce's own Mastodon
  account** (the Mastodon timeline marker was abandoned: other clients move it).
- There is a **diagnostic log** (Settings → Copy diagnostics) that records read
  marks, loads, jumps, sync and stream events. Use it when something odd is
  reported.
- Deploy: push to `main` → CI (Playwright e2e) → Pages. Test locally with
  `npm start` and `npm test`. Dev branch `claude/mastodon-rss-reader-4k8ebl`
  exists but nothing deploys from it.
- Hosting stays on Pages for now (decided 1 Oct); moving to Caddy would need a
  static-file stack and either deliberate Ansible deploys or a runner Bruce
  removed on purpose.

---

## 7. Homelab conventions (from `brucejcooper/homelab`)

- One Docker VM (VMID 200, `192.168.10.200`); every service is a Compose stack
  in `stacks/<svc>/`; deployed with `cd ansible && ansible-playbook deploy.yml
  -e only=<svc>`. **Deploys are deliberate**; nothing auto-deploys; push-to-
  deploy and the Actions runner were retired (decision D16). Work on branches.
- **Caddy** routes by container labels: `caddy: "x.8bitcloud.com"` and
  `caddy.reverse_proxy: "{{upstreams <port>}}"`; add `, x.8bitcloud.com:8443`
  and `homelab.tier: public` to expose to the internet. The Mac agent and the
  phone need the curator reachable, so **public-tier**.
- **authentik** is the IdP; SSO-gated routes go in `stacks/caddy/Caddyfile`
  with `forward_auth` (copy an existing block, e.g. `tsdb.8bitcloud.com`).
  The curator's status page goes behind it; the feed path and vote endpoint do
  not (obscure path + bearer token instead).
- **Secrets**: `ansible/group_vars/docker_vm/vault.yml` (ansible-vault),
  rendered into the stack's `.env`. **Bruce adds vault entries**; don't touch
  the vault. The stack list is `stacks:` in
  `ansible/group_vars/docker_vm/vars.yml`; add `curator` there with its `env`
  keys (`JEV_API_KEY`, `ANTHROPIC_API_KEY`, `MASTODON_TOKEN`, `FORGEJO_TOKEN`,
  `CURATOR_VOTE_TOKEN`, `CURATOR_AGENT_TOKEN`, `TZ`).
- Data on a named volume so deploys never touch it. The container builds from
  (or pulls) the `bruce/curator` repo; code lives there, the stack definition
  lives in the homelab repo. Add a line to `docs/services.md`.
- Forgejo stack: `stacks/forgejo/` (Postgres on a private network, SSH on 222,
  authentik OIDC; the admin account is a separate local break-glass user).

---

## 8. Open questions for Bruce

1. **Never-collect list**: the config-file approach was agreed; confirm the
   built-in category list's aggressiveness (default: banks, health, government
   services, password managers, webmail).
2. **launchd** on the Mac is acceptable for the agent?
3. **Jev and Anthropic API keys**: Bruce has a Jev account; keys to go in the
   vault (homelab) and Keychain (Mac). Never in chat or git.
4. **Interview** for profile v1: do it early in the desktop session.
5. **Bluesky** as the stand-in for X hashtags: OK?

---

## 9. Things decided, so don't re-litigate

- Two-speed design (daily Claude profile; 15-min classify loop).
- Jev vs local classifier run in parallel with a scorecard; Jev decides first.
- Local-first embeddings; no Coral; no GPU; CPU is enough.
- Haiku is fallback, not the main filter.
- Story grouping with "best version" selection and "also covered by".
- Never-collect list as a git-tracked file; pause and forget commands.
- Curator repo on Forgejo; stack in the homelab repo; Mastorss on GitHub Pages.
- X skipped; Bluesky instead.
- Firefox Sync rejected; `places.sqlite` + Safari `History.db` on the Mac.
