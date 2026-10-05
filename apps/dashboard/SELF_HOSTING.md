# Self-hosting the textagent dashboard

One server with Docker runs everything: Postgres, the dashboard, and Caddy for HTTPS.

## 1. Before you start

- A server with Docker and a DNS name pointing at it (for example `dash.example.com`), ports 80 and 443 open.
- A GitHub OAuth app (github.com/settings/developers → **New OAuth App**):
  - Homepage URL: `https://dash.example.com`
  - Authorization callback URL: `https://dash.example.com/api/auth/callback/github`

## 2. Configure

```sh
git clone https://github.com/alphasr/textagent.git && cd textagent/apps/dashboard
cp .env.example .env
```

Fill in `.env`: `PUBLIC_URL` (`https://dash.example.com`), the GitHub app's client id and secret, and two secrets
from `openssl rand -hex 32` for `POSTGRES_PASSWORD` and `AUTH_SECRET`. Keep `.env` private.

## 3. Start

```sh
docker compose up -d --build
```

Caddy gets a certificate on first request. The dashboard applies database migrations on every start (safe to
repeat) and deletes traces older than 30 days once a day. Open `PUBLIC_URL`, sign in with GitHub, create a project,
and create an ingestion key in its Settings.

## 4. Point agents at it

In each agent's `.env` (or `npx textagent create --dashboard`):

```sh
TEXTAGENT_INGEST_URL=https://dash.example.com
TEXTAGENT_KEY=ta_...              # from the project's Settings
TEXTAGENT_HASH_SECRET=...         # stays with the agent; never give it to the dashboard
```

## Operating it

- **Upgrade:** `git pull && docker compose up -d --build`. Migrations run when the new version starts.
- **Back up:** `docker compose exec postgres pg_dump -U textagent textagent > backup.sql`.
- **Health:** `GET /healthz` answers 200 when the database is reachable; Docker restarts the dashboard if it isn't.
- **Logs:** `docker compose logs -f dashboard`.
- **Try it locally:** set `PUBLIC_URL=http://localhost` (plain HTTP, no certificate). GitHub sign-in then needs an
  OAuth app whose callback is `http://localhost/api/auth/callback/github`.
- **Other reverse proxies:** the dashboard trusts `X-Forwarded-For` for the sign-in rate limit, so the proxy in front
  must overwrite it, not pass on what clients send. Set `TRUSTED_IP_HEADER` for proxies that use another header
  (for example `cf-connecting-ip`). Never expose port 3000 directly.
- **Building behind a TLS-inspecting proxy:** pass the proxy's CA certificate as a build secret:
  `docker build --secret id=ca,src=/path/to/ca.pem -f apps/dashboard/Dockerfile .` from the repository root.
