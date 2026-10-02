# Mastorss has moved

Mastorss now lives inside the **curator**
(`git.8bitcloud.com/bruce/curator`, in `web/`) and is served at
**https://curator.8bitcloud.com/**, behind Mechination SSO. Its only backend
is the curator, which merges your Mastodon home timeline (filtered) with the
articles it picks; the app no longer talks to Mastodon itself.

This repository keeps the history of the original app, which read the
Mastodon home timeline directly from the browser (last version: `fb81148`).
The GitHub Pages site now just redirects to the new address and cleans up
after the old app (service worker, cache, and the Mastodon login it kept in
the shared github.io storage).
