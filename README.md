# Runway — personal budgeting app

Track recurring bills, one-time purchases with your own categories, paychecks,
spending charts, a day-by-day projected balance calendar, and an AI chat about
your money. Runs on your computer; reachable from your phone via Tailscale.

## Requirements

- Node.js 18+ — https://nodejs.org (check with `node --version`)

## First-time setup

```bash
cd runway-budget
npm install
```

Create an Anthropic API key at https://console.anthropic.com — pay-as-you-go,
a fraction of a cent per chat question. Set it as an environment variable
rather than pasting it into a file, so it never ends up on disk or gets
committed by accident.

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

If you'd rather keep the key in a file, `.env.example` still works as a
template (`cp .env.example .env`) — `server.js` only reads `.env` as a
fallback when the environment variable isn't already set.

## Run it

```bash
npm run app
```

This builds the app and starts the server at http://localhost:3000.
Day to day you only need this one command. Leave it running.

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

## Where your data lives

Everything is saved to `data.json` next to `server.js` — one file, shared by
every device. Back it up by copying that file. Your API key stays as an
environment variable (or in `.env` if you chose that route) on this computer
and never reaches the browser.

## How it's wired

- `server.js` — serves the built app, stores data in `data.json`
  (`/api/storage/*`), and forwards chat requests to the Anthropic API with
  your key from `.env` (`/api/chat`)
- `src/App.jsx` — the entire UI: date utils, the `buildProjection` engine,
  the four tabs, and `buildFinancialContext` (the snapshot the AI sees)
- `src/main.jsx` — bootstrap + a shim mapping the app's storage calls onto
  the server API (the app was originally built for Claude.ai's storage; the
  shim keeps the component code unchanged). Also migrates data automatically
  from the older localStorage version if you used it.
- `index.html` — loads Tailwind via its Play CDN (zero build config; swap in
  a proper Tailwind install later if you want)

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
