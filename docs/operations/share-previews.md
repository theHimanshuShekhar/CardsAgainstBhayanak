# Share previews

Set `PUBLIC_SITE_URL` to the site's existing public HTTPS origin (or a `cards` subdomain of a domain you own), e.g. `https://cards.example.com`. This is a runtime server setting: no credentials, path, query or fragment. Production requires HTTPS and fails startup if the setting is missing or invalid. Development alone accepts HTTP localhost. Host and forwarding headers never select the origin. Configure the same value in Dockhand/Compose and restart the rebuilt image.

SSR head metadata is selected by route without looking up a room. Lobby, session and end links all use the same generic invitation; unknown/malformed/expired/ended rooms expose no room existence or gameplay data. Query strings do not enter metadata. A static original 1200×630 card illustration contains no real game content. Artwork uses DejaVu Sans Bold as a deliberate raster typography substitute for the UI’s Geist/Bricolage: the heavy display hierarchy, neutral sans lettering, black/white card outlines and original copy follow the existing style reference. The brand and tagline remain readable at a 360-pixel embed width. Versioned PNG files cache for one year; change filenames and head references together when replacing artwork. Vite copies `public/` into `dist/client`; `server.prod.ts` publicly serves only the explicit preview/icon allowlist alongside hashed JS/CSS assets. The Docker run stage copies `dist`, so it includes these files.

## Inspect and refresh

After deployment replace the example origin, then fetch the **exact Copy link URL**, without cookies:

```sh
curl -sSL -A 'Discordbot/2.0' 'https://cards.example.com/games/ABCDEF/lobby' -o /tmp/cab-preview.html
curl -sSL -A 'Twitterbot/1.0' 'https://cards.example.com/games/ABCDEF/lobby'
curl -I 'https://cards.example.com/share-v1.png'
```

Check the initial `<head>` for one canonical URL and one of each OG/Twitter tag, correct absolute origins, and no tokens or handles. The PNG must return 200, `Content-Type: image/png`, and public immutable caching. Redirects, if configured at ingress, must end on the intended public URL with the same safe head. Repeat for `/`, `/stats`, `/games/create`, `/games/join`, `/session` and `/end`.

Use Facebook Sharing Debugger's “Scrape Again”, opengraph.xyz's URL inspection, and the available X card validator/share composer. X's legacy validator may be unavailable or may validate without displaying a card; record that explicitly. Discord can cache previews: a versioned image URL refreshes artwork; retry the URL in an explicitly authorized test destination. Do not include secrets in cache-busting queries. WhatsApp/Telegram/Slack/iMessage/Reddit/LinkedIn consume the same public OG metadata but may cache independently.

If local/container fetches work but a platform fails, inspect Cloudflare request/security logs for that crawler, HTTP status, redirects, challenges, robots rules and the final image fetch. Tunnel hostname/routing, WAF managed challenges, Bot Fight Mode or Cloudflare Access may intercept crawlers before the app. Make a narrowly scoped rule for verified platform crawlers/public page and image paths where appropriate; preserve application access rules. A curl user-agent alone does not establish crawler identity. Do not disable protections globally.

## Evidence status

Local HTTP/container checks prove serving and SSR behavior only. No production origin or authorized Discord destination was supplied. Actual Discord unfurl, X preview/validator, Facebook Sharing Debugger and opengraph.xyz evidence remain **pending deployment**. Record URL, timestamp, platform result/screenshot and any unavailable validator here after authorized deployment testing. No external posting has been performed.
