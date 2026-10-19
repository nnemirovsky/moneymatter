# Environment Variable Reference

Grouped as in `.env.example`. Only the REQUIRED block is needed to
boot; everything else is optional.

## Required

| Variable                  | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`                | Must be `production`                                          |
| `BETTER_AUTH_URL`         | URL you open the app at (`http://localhost:8080` for a trial) |
| `AUTH_ORIGIN`             | Same value as `BETTER_AUTH_URL`                               |
| `APPLICATION_JWT_SECRET`  | Encryption key for stored credentials                         |
| `APP_SESSION_ID_SECRET`   | Signs request-tracing cookies                                 |
| `BETTER_AUTH_SECRET`      | Signs all auth sessions / tokens                              |
| `APPLICATION_DB_PASSWORD` | Postgres password (rest of `DB_*` default to `db`, etc.)      |
| `APPLICATION_DB_*`        | Host/port/user/db (defaults suit the bundled Postgres)        |
| `APPLICATION_REDIS_HOST`  | Redis hostname (defaults to `redis`)                          |
| `APPLICATION_PORT`        | Backend listen port; also the frontend proxy target (`8081`)  |

## Compose-level (optional, defaults shown)

| Variable                   | Purpose                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_PORT` (`8080`)       | Host port the app is served on; set `127.0.0.1:8080` to make it reachable only from the server itself (when a reverse proxy on the same server fronts the app)                                                                                          |
| `LISTEN_PORT` (`80`)       | Port nginx binds inside the frontend container. Set it above 1024 (e.g. `8080`) on hosts that reserve low ports for root, such as Synology Container Manager; proxies on the Docker network then reach the app at `http://budget-tracker:<LISTEN_PORT>` |
| `IMAGE_TAG` (`latest`)     | Image tag to pull; set `sha-<commit>` to pin                                                                                                                                                                                                            |
| `DB_HOST_PORT` (`5432`)    | Postgres admin port; used only if you uncomment the db `ports:` line in `docker-compose.yml` (binds to localhost)                                                                                                                                       |
| `REDIS_HOST_PORT` (`6379`) | Redis admin port; used only if you uncomment the redis `ports:` line in `docker-compose.yml` (binds to localhost)                                                                                                                                       |

## Traefik overlay only

Ignored unless you use the [Traefik overlay](traefik-overlay.md)
(`docker-compose.traefik.yml`).

| Variable                                   | Purpose                                       |
| ------------------------------------------ | --------------------------------------------- |
| `SELFHOST_FRONTEND_DOMAIN`                 | Domain Traefik serves the app on              |
| `LETSENCRYPT_EMAIL`                        | Contact for ACME (Let's Encrypt) registration |
| `SELFHOST_API_DOMAIN`                      | Split-domain mode only: separate API host     |
| `TRAEFIK_HTTP_PORT` / `TRAEFIK_HTTPS_PORT` | Override Traefik's 80/443 host bindings       |

## Optional features (backend runtime; off until set)

| Variable                                                                           | Enables                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`                                              | All outbound email: address verification, password reset, share invitations, membership notices. Unset means invitations are created but never delivered – the link must be shared manually, and the **Forgot password?** link is hidden                                                                                                                                                                                                                                        |
| `APP_URL`                                                                          | Public URL of your frontend, used as the base for links inside invitation / notification emails (defaults to `https://moneymatter.app`)                                                                                                                                                                                                                                                                                                                                         |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`                                        | Google sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`                                        | GitHub sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ENABLE_BANKING_REDIRECT_URL`                                                      | Enable Banking bank linking. Must be `https://<your-domain>/bank-callback` and match the redirect URL registered in your Enable Banking application                                                                                                                                                                                                                                                                                                                             |
| `POLYGON_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `FMP_API_KEY`, `COINGECKO_API_KEY`     | Investments / market data. `COINGECKO_API_KEY` also enables the CoinGecko rate source for custom currencies (without it, saving that source fails with “CoinGecko is not available on this instance”)                                                                                                                                                                                                                                                                           |
| `CRYPTO_PRICES_SYNC_INTERVAL_MINUTES`                                              | Crypto price sync cadence (1–59, default 15)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `API_LAYER_API_KEYS`                                                               | APILayer paid currency-rate fallback                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GEMINI_API_KEY`                                                                   | Included Google AI model for AI features, used when a user has no AI model of their own                                                                                                                                                                                                                                                                                                                                                                                         |
| `TYPESAFE_API_KEY`                                                                 | Optional. Sharpens invoice-to-transaction merchant matching via TypeSafe "Jev". Unset means matching falls back to fuzzy string comparison                                                                                                                                                                                                                                                                                                                                      |
| `LOGO_DEV_SECRET_KEY`                                                              | Server-side payee brand-logo search. Search results only – rendering the logo images also needs `VITE_LOGO_DEV_TOKEN` (below)                                                                                                                                                                                                                                                                                                                                                   |
| `ADMIN_USERS`                                                                      | Comma-separated usernames (not emails) of admins, e.g. `alice,bob`. The username is the handle shown in Settings → Household, without the `@`. Admins get an extra Admin tab in Settings (uploading security prices manually) and are the only users who can connect a Claude or ChatGPT subscription as an AI model (see below). Unset = nobody can; the rest of the app works as usual                                                                                        |
| `AI_CLI_CLAUDE_PATH`, `AI_CLI_CODEX_PATH`                                          | Path to the `claude` / `codex` program used by the subscription AI models. Unset = look both up on `PATH`, where the published backend image already has them. Only set these for a custom image that installs them elsewhere                                                                                                                                                                                                                                                   |
| `AI_CLI_MAX_CONCURRENT_RUNS`                                                       | How many subscription AI runs (`claude` / `codex` processes) may go at the same time across the whole instance (default `4`). One connection can use several of them at once. Each process takes a few hundred MB of memory, so raise it only if your plan's limits and the server's memory allow                                                                                                                                                                               |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `WEB_PUSH_ALLOWED_HOSTS` | Browser notifications (Web Push). The three `VAPID_*` values are required together; with any missing or invalid the feature is off and **Notifications** is hidden in Settings. See [Browser notifications](#browser-notifications)                                                                                                                                                                                                                                             |
| `AUTH_RP_ID`, `AUTH_RP_NAME`                                                       | WebAuthn / passkey support. `AUTH_RP_NAME` doubles as the brand and sender name on outbound emails                                                                                                                                                                                                                                                                                                                                                                              |
| `ALLOWED_ORIGINS`                                                                  | Extra CORS origins beyond `AUTH_ORIGIN`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TRUSTED_PROXIES`                                                                  | Proxies whose `X-Forwarded-For` the backend believes; sets the client address on sessions (Settings → Security) and per-IP rate limits. Comma-separated `loopback`, `linklocal`, `uniquelocal`, IPs and CIDRs, or `none`. Default: the private ranges, so a proxy on the same host or Docker network (Cloudflare Tunnel included) needs nothing. See [Client IP address](reverse-proxies.md#client-ip-address)                                                                  |
| `SENTRY_DSN`                                                                       | Backend error tracking                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SYSTEM_MAX_SIGNUPS_ALLOWED`                                                       | Cap on user accounts: signups are rejected once the instance has this many users (`0` disables signups, `1` = "just me"). Deleting a user frees a slot. Unset = unlimited                                                                                                                                                                                                                                                                                                       |
| `SYSTEM_DEMO_DISABLED`                                                             | Blocks demo-account creation (`POST /demo`). Defaults to `true` in the self-host compose stack; set to `false` to allow demo accounts                                                                                                                                                                                                                                                                                                                                           |
| `ATTACHMENTS_PATH`                                                                 | Where transaction attachments live on the host. Unset = the Docker-managed `attachments_data` volume. Set to a host directory (absolute, or starting with `./`) to use a NAS/shared mount. The backend runs inside the container as user id 1001 and must be able to write there, otherwise uploads fail with "permission denied": on a local disk run `sudo chown -R 1001:1001 <dir>`; on an SMB share mount it with `uid=1001,gid=1001`; on NFS set the owner on the NAS side |
| `ATTACHMENTS_S3_BUCKET`                                                            | Store attachments in S3-compatible object storage (e.g. Cloudflare R2) instead of on disk. Needs `ATTACHMENTS_S3_ENDPOINT`, `ATTACHMENTS_S3_ACCESS_KEY_ID` and `ATTACHMENTS_S3_SECRET_ACCESS_KEY`                                                                                                                                                                                                                                                                               |

## Browser notifications

Browser notifications (Web Push) send each bell notification to the user's
devices, also when MoneyMatter is closed. They stay off until you give the
backend a VAPID key pair. User guide:
[Browser notifications](https://docs.moneymatter.app/settings/notifications/).

| Variable                 | Purpose                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`       | Public half of the key pair (URL-safe base64, 87 characters). The app hands it to browsers when they subscribe                                                                                                                                  |
| `VAPID_PRIVATE_KEY`      | Private half (URL-safe base64, 43 characters). A secret: keep it in `.env` only, never in the repo or in logs                                                                                                                                   |
| `VAPID_SUBJECT`          | Contact the push services get with every request: `mailto:you@example.com` or an `https://` URL you control. It must not point at `localhost` or a `.local` host, because Apple's push service rejects it                                       |
| `WEB_PUSH_ALLOWED_HOSTS` | Optional. Comma-separated hosts the backend may send pushes to; `*.` matches subdomains only. Unset means `*.push.apple.com`, `fcm.googleapis.com`, `*.push.services.mozilla.com` and `*.notify.windows.com`. Setting it **replaces** that list |

Generate the key pair once, on any machine with Node.js:

```bash
npx web-push@3.6.7 generate-vapid-keys
```

It prints a public and a private key. Put them in `.env` as
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, set `VAPID_SUBJECT`, and run
`docker compose up -d`. Settings then shows a **Notifications** page for every
user. The backend checks the values at start and, if any is missing, malformed
or a non-matching pair, or the subject is not a valid `mailto:` / `https:`
address, keeps the feature off and logs which variable is wrong (never its
value).

**Changing the keys removes every device.** A browser subscription is bound to
the public key it was created with. After you change the keys, each device's
subscription is removed the next time the server would send to it, and every
user has to switch notifications on again on each device. Keep the pair
when you move the instance, and treat it like any other secret. Device
subscriptions are not part of a backup.

**Network.** Pushes go from the backend to the push services over outbound
HTTPS (port 443); nothing connects inbound. An auth proxy in front of the app
doesn't affect this. See
[Auth proxies](reverse-proxies.md#auth-proxies-cloudflare-access-and-similar).

## Claude and ChatGPT subscriptions as AI models

An admin (see `ADMIN_USERS`) can add **Claude Code (subscription)** and **Codex (ChatGPT subscription)** under Settings → AI → AI models, signing in with their own Claude or ChatGPT account instead of pasting an API key. See the user guide: [Use your Claude or ChatGPT subscription for AI](https://docs.moneymatter.app/ai/use-your-ai-subscription/). Setup on the server is two steps: list the admin's username in `ADMIN_USERS` and restart the backend. Nothing else is needed with the published images.

The backend image carries the Claude Code and Codex programs to do this, so it is larger than before: about 2.04 GB on disk on `amd64` and 1.94 GB on `arm64`, up from roughly 1.3 GB on `amd64`. Allow for that in disk space and image pull time. The programs run only when an admin's subscription connection is used, so memory use at rest doesn't change.

Subscription sign-ins are stored encrypted in the database like API keys, and, like API keys, are not part of a backup: after a restore, sign in again.

## AI chat

The in-app [Chat](https://docs.moneymatter.app/ai/chat/) needs no new environment variable: it uses the AI models users already set up in Settings → AI, and it ships in the published images. These existing variables apply to it:

| Variable                     | Effect on Chat                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_USERS`                | Chat on a Claude Code or Codex subscription is available to these admins only. Users with an API key or local model connection need nothing                                                                   |
| `AI_CLI_MAX_CONCURRENT_RUNS` | Chat answers on a subscription take one of these slots, like every other subscription AI run (default `4`). A chat that finds no free slot for 2 minutes stops with "All CLI slots on this instance are busy" |
| `IS_SELF_HOST`               | Already set to `true` by the self-host compose stack. The subscription bridge below only starts when it is `true`                                                                                             |

`AI_CLI_CHAT_RUN_TIMEOUT_MS` and `AI_CLI_CHAT_SLOT_WAIT_MS` also exist, but are read only when `NODE_ENV=test`, to shorten the chat timeouts in the test suite. They do nothing in a running install, so leave them unset.

**Subscription bridge (self-hosted only).** To let Claude Code or Codex use MoneyMatter's tools during a chat, the backend opens a plain-HTTP listener on `127.0.0.1` with a random port, the first time a chat on a subscription needs it. Nothing connects to it from outside the container, so it needs no published port, proxy rule, firewall rule or Cloudflare Access policy, and it can't be reached by setting `MCP_BASE_URL`. It accepts only a per-answer key that the backend creates and revokes, and the public `/mcp` address refuses that key. The CLI program is started with that key in its environment as `MM_CHAT_TOKEN`, which the backend sets for the child process itself. Don't set `MM_CHAT_TOKEN` in `.env`. On a hosted instance the listener is never started.

**Sandbox.** Calculations the chat runs (QuickJS in WebAssembly, in two worker threads) have no setting. Each run is capped at 64 MB of heap growth, 2 s of compute time and 5 s in total. The pool of two workers needs about 128 MB in normal use, and up to about 640 MB at the hard ceiling, which matters only on a very small server. Worker code is in `dist/sandbox-worker.js` of the backend image.

**History and backups.** Conversations are deleted after the retention time each user picks (default 30 days) by a background job that runs on every install, offline ones included. They are not part of backups, and a restore removes them.

**Operators.** Chat has no included server model. To offer one, add an entry for the `chat` feature to `SERVER_MODELS` (and `PLUS_SERVER_MODELS`) in `packages/backend/src/services/ai/resolution-ladder.ts` and rebuild; users with the operator AI feature then get it, with no other change.

## Frontend runtime (optional)

Interpolated into the frontend container's `environment:` block. Change and
`up -d` – **no image rebuild** needed.

| Variable                                     | Purpose                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`      | Product analytics (PostHog)                                             |
| `VITE_SENTRY_DSN`                            | Frontend error tracking (Sentry)                                        |
| `VITE_SENTRY_RELEASE`                        | Release tag Sentry events report — also a build arg, see below          |
| `VITE_LOGO_DEV_TOKEN`                        | Brand logos for payees, subs, banks, tickers (logo.dev publishable key) |
| `MCP_BASE_URL`                               | Backend origin advertised to MCP clients — required for MCP, see below  |
| `CARD_PAYMENT_SHORTCUT_ICLOUD_URL`           | iCloud link of the Apple Pay shortcut, offered as Add Shortcut          |
| `API_HTTP`, `API_VER`                        | Point the SPA at a separate API origin (leave unset for same-origin)    |
| `CSP_EXTRA_CONNECT`, `CSP_EXTRA_FORM_ACTION` | Extra CSP allow-list hosts (default to `API_HTTP`)                      |
| `CSP_EXTRA_ANALYTICS`                        | CSP allow-list for analytics — **set this if you use Sentry**           |
| `SKIP_LANDING`                               | `true` (default) redirects `/` to `/dashboard`; `false` serves landing  |

`CSP_EXTRA_ANALYTICS` defaults to `VITE_POSTHOG_HOST` only. Sentry's ingest host
is not derivable from the DSN by the entrypoint, so a Sentry deployment that
leaves this unset gets a `connect-src` that blocks every error report.

`MCP_BASE_URL` is the URL the app advertises to external MCP clients (Claude
Desktop, ChatGPT). In same-origin mode set it to the origin you reach the app on
(`https://money.example.com`): the frontend container proxies `/mcp` and the
OAuth discovery endpoints to the backend, and the backend builds its discovery
documents from this value, so clients are pointed at your instance rather than
the hosted one. In split-domain mode set it to the backend's own origin, the
same value as `BETTER_AUTH_URL`: the OAuth issuer is built from
`BETTER_AUTH_URL`, and the frontend's static discovery mirrors rewrite it to
`MCP_BASE_URL`, so the two must agree. Leave it unset if you do not use MCP.

`CARD_PAYMENT_SHORTCUT_ICLOUD_URL` is the iCloud share link of the "MoneyMatter -
Log card payment" shortcut. When set, the Apple Pay page (Accounts → Apple Pay) offers
it as **Add Shortcut** on an iPhone. It is a runtime variable of the frontend
container, written to the page's config when the container starts: change it and
`up -d`, no rebuild. Leave it empty and the page points to the manual guide
instead. A link can only be created on an iPhone, by sharing the imported
shortcut. See the [Apple Pay guide](https://docs.moneymatter.app/integrations/apple-pay/).

If a gateway with access control (such as Cloudflare Access) sits in front of the
app, give the Apple Pay shortcut a path-scoped service credential for
`/api/v1/ingest/` and keep the login on everything else; see
[reverse-proxies.md](reverse-proxies.md#proxies-with-access-control).

Whatever fronts the frontend container must pass these paths through to it
unchanged, alongside `/api/`: `/mcp`, `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource` (both also in their `/mcp`-suffixed
form), `/.well-known/oauth-authorization-server/api/v1/auth`, and `/authorize`,
`/token`, `/register`. A proxy that forwards only `/` and `/api/` already covers
them; one with an explicit path allow-list does not.

The `VITE_` prefix on the frontend keys above is historical: these are read from
the container's env at start, not inlined at build time. `docker-compose.yml`
maps them onto the unprefixed names the image expects (`VITE_POSTHOG_KEY` →
`POSTHOG_KEY`, and so on).

## Build-from-source only

Used with `docker-compose.build.yml` (`--build`).

| Variable                                            | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Sentry source-map upload at build time                          |
| `VITE_SENTRY_RELEASE`                               | Names the uploaded source maps; baked in as the release default |

`VITE_SENTRY_RELEASE` is the one value that is both a build arg and runtime env.
The build stamps it into the image as the release the SDK reports by default, so
that events match the source maps uploaded alongside them. Setting it in `.env`
after an image already exists only changes the runtime value — rebuild
(`--build`) to move the source maps with it.

## Set for you

`IS_SELF_HOST` is written straight into `docker-compose.yml`, on both the
backend and the frontend. There is nothing to put in `.env` — anything you set
there is ignored. It marks the stack as yours rather than the hosted service,
which turns on five things:

- **No plans, no trial, no billing.** Every feature is on for every user, no
  trial clock starts at signup, and the billing routes answer 404.

- **A custom AI endpoint can point at a server on your own network.** On the
  hosted service the app refuses private addresses (`localhost`, `192.168.x.x`,
  and so on), because there they could only be someone probing the server it
  runs on. On your own stack that restriction is lifted, so you can use a model
  running on your machine or elsewhere on your LAN.
- **Restoring a backup fills in price history.** After a restore, your stocks
  and crypto get their past prices fetched again, so charts and past valuations
  look right instead of starting from the restore date.
- **A backup from another account restores fine.** The hosted service refuses
  archives exported by a different user; on your own stack you may be moving
  data between instances, so that check is off.
- **The HTTP rate source of a custom currency may reach your network.** On the
  hosted service the address must be `https` and public: private and internal
  addresses are blocked. On your own stack that guard is off, so the address may
  use `http` and may point at a server on your LAN. The other limits stay
  regardless: a 5-second timeout, a 256 KB response cap and no redirects (the
  request headers are the user's secrets and belong only to the address they
  saved). Header values are stored encrypted and are never returned by the API.
  The daily sync of these sources runs at 00:45 UTC.

## Hosted service only

Read by the billing code, which never runs on a self-hosted stack – the billing
routes answer 404 and no entitlement depends on them. Listed so a variable you
see in the codebase is not mistaken for something your instance needs.

All three are read by the backend only – the frontend container has no Stripe
variable of its own. `AUTH_ORIGIN` must also be set, because it is the origin
Stripe-hosted checkout and the billing portal return the buyer to.

| Variable                | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `STRIPE_ENV`            | `test` or `live`; picks which set of Stripe price ids the app accepts |
| `STRIPE_SECRET_KEY`     | Stripe API key used to mint checkout and billing-portal sessions      |
| `STRIPE_WEBHOOK_SECRET` | Signing secret Stripe webhooks are verified against                   |
| `AUTH_ORIGIN`           | Frontend origin Stripe returns to after checkout or the portal        |

---

Setup guide: [setup-guide.md](setup-guide.md) · Troubleshooting:
[troubleshooting.md](troubleshooting.md)
