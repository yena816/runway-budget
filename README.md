# Runway — personal budgeting app

Track recurring bills, one-time purchases with your own categories, paychecks,
spending charts, a day-by-day projected balance calendar, and an AI chat about
your money. Password-protected; runs on your computer (reachable from your
phone via Tailscale) or always-on on Fly.io.

## Requirements

- Node.js 18+ — https://nodejs.org (check with `node --version`)

## First-time setup

```bash
cd runway-budget
npm install
```

You need three things, as environment variables or in a `.env` file
(`cp .env.example .env` and fill it in — `server.js` only reads `.env` as a
fallback when an environment variable isn't already set, so either way works):

- `ANTHROPIC_API_KEY` — from https://console.anthropic.com, pay-as-you-go, a
  fraction of a cent per chat question.
- `APP_PASSWORD` — the password you'll type to open the app.
- `SESSION_SECRET` — any random string, used to sign login sessions. Generate
  one with `openssl rand -hex 32`.

The server refuses to start if `APP_PASSWORD` or `SESSION_SECRET` is missing,
so a deploy can't accidentally go out unprotected.

**Windows (Command Prompt)** — persists across reboots, takes effect in new
Command Prompt windows:
```cmd
setx ANTHROPIC_API_KEY "sk-ant-your-key-here"
```

**Windows (PowerShell)** — user-level, persistent:
```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-your-key-here", "User")
```

**macOS/Linux (bash/zsh)** — add to `~/.bashrc` or `~/.zshrc` to persist:
```bash
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
```

Prefer not to set it permanently? Set it just for the current terminal
session instead (`set` in Command Prompt, `$env:ANTHROPIC_API_KEY = "..."`
in PowerShell, or `export` in bash/zsh as above) — you'll need to set it
again next time you open a new terminal before running the server.

## Run it

```bash
npm run app
```

This builds the app and starts the server at http://localhost:3000. Log in
with `APP_PASSWORD`. Day to day you only need this one command. Leave it
running.

## Phone access with Tailscale

1. On this computer: install Tailscale from https://tailscale.com/download
   and sign in (Google/Apple/GitHub account — free personal plan).
2. On your phone: install the Tailscale app from the App Store / Play Store
   and sign in with the SAME account.
3. Find your computer's Tailscale name: it's shown in the Tailscale menu/app
   (something like `your-laptop.tail1234.ts.net`), or run `tailscale status`.
4. On your phone (Tailscale toggled on), open:
   `http://your-laptop.tail1234.ts.net:3000`
5. Bookmark it, or "Add to Home Screen" in your phone browser to get an
   app-like icon.

Only devices signed into YOUR Tailscale account can reach it — it is not
exposed to the internet. The computer must be on and awake for the app to
work from your phone (on a laptop, disable sleep-when-plugged-in or use
`caffeinate` on macOS).

## Deploying to Fly.io (always-on, no laptop required)

This gets you an always-on URL reachable from anywhere — no Tailscale, no
keeping your computer on — for about $2.50–3/month. You'll need a Fly.io
account and the `flyctl` CLI installed.

1. **Launch the app** (from this directory):
   ```
   fly launch --no-deploy
   ```
   Accept or edit the app name and region when prompted; say no to a
   Postgres/Redis database. This writes your `app` name and
   `primary_region` into `fly.toml`.

2. **Create a volume** so `data.json` survives restarts and redeploys:
   ```
   fly volumes create runway_data --size 1 --region <same region as above>
   ```

3. **Set your secrets** (never committed — these only live on Fly):
   ```
   fly secrets set ANTHROPIC_API_KEY=sk-ant-... APP_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32)
   ```

4. **Deploy:**
   ```
   fly deploy
   ```

5. Open the printed `https://<app-name>.fly.dev` URL on your phone, log in
   with `APP_PASSWORD`, and confirm it works. Future deploys are just
   `fly deploy` again — your data stays on the volume.

## Where your data lives

Everything is saved to `data.json` next to `server.js` (or on the Fly volume,
mounted at `/data`, when deployed) — one file, shared by every device. Back
it up by copying that file. Your API key and session secret stay as
environment variables (or in `.env`/Fly secrets) and never reach the browser.

## How it's wired

- `server.js` — serves the built app; stores data in `data.json`
  (`/api/storage/*`); forwards chat/statement-parsing requests to the
  Anthropic API with your key (`/api/chat`, `/api/parse-statements`); and
  gates all of the above behind a signed-cookie session
  (`/api/login`, `/api/logout`, `/api/session`)
- `src/App.jsx` — the entire UI: date utils, the `buildProjection` engine,
  the `LoginScreen` and auth-gated `App` wrapper, the four tabs, and
  `buildFinancialContext` (the snapshot the AI sees)
- `src/main.jsx` — bootstrap + a shim mapping the app's storage calls onto
  the server API (the app was originally built for Claude.ai's storage; the
  shim keeps the component code unchanged)
- `index.html` — loads Tailwind via its Play CDN (zero build config; swap in
  a proper Tailwind install later if you want)
- `Dockerfile` / `.dockerignore` / `fly.toml` — the Fly.io deployment config

## Editing the code

For live-reload while editing, run two terminals:

```bash
npm start     # terminal 1: the API/data server on :3000
npm run dev   # terminal 2: Vite dev server on :5173 (proxies /api to :3000)
```

Edit, save, see changes instantly at http://localhost:5173. When you're done,
`npm run app` rebuilds the production version served on :3000.

## Ideas to try

- Change the $250 low-balance warning threshold (`toneFor` in `CalendarTab`)
- Edit entries in place instead of remove + re-add
- Category budgets with progress bars, or savings goals
