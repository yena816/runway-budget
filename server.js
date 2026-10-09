// Runway local server
// - Serves the built app (dist/)
// - /api/storage/* : saves your budget data to data.json (DATA_DIR if set,
//   otherwise this computer) — so every device sees the same numbers
// - /api/chat, /api/parse-statements : forward requests to the Anthropic
//   API, adding your key from .env/secrets — the key never reaches the client
// - /api/login, /api/logout, /api/session : a single-password gate (see
//   below) protecting all of the above once this is reachable from the
//   internet, not just your own machine
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// Minimal .env loader (no dependency needed)
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

if (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET) {
  console.error(
    "Missing APP_PASSWORD or SESSION_SECRET. Copy .env.example to .env, " +
    "set both (SESSION_SECRET can be anything random, e.g. `openssl rand -hex 32`), and restart."
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.env.DATA_DIR || process.cwd(), "data.json");

const readStore = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return {}; }
};
const writeStore = (s) => fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));

/* ---------------- auth: single shared password, signed-cookie session ---
 * No session store, no extra dependency — the cookie is just an expiry
 * timestamp plus an HMAC signature (keyed by SESSION_SECRET), so it's
 * self-verifying and survives server restarts. */
const SESSION_COOKIE = "runway_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(expiresAt) {
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${sig}`;
}
function verifyToken(token) {
  if (!token) return false;
  const [expiresAt, sig] = token.split(".");
  if (!expiresAt || !sig) return false;
  const expectedSig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(expiresAt).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  return Number(expiresAt) > Date.now();
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res) {
  const token = signToken(Date.now() + SESSION_TTL_MS);
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (req.secure) attrs.push("Secure"); // only over HTTPS — omitted for local http://localhost
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}
function requireAuth(req, res, next) {
  if (verifyToken(parseCookies(req.headers.cookie)[SESSION_COOKIE])) return next();
  res.status(401).json({ error: { message: "Not logged in." } });
}

// Crude in-memory rate limit on login attempts — resets on restart, which
// is fine for a single-user app; just deters casual password guessing.
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

const app = express();
app.set("trust proxy", 1); // needed behind Fly's edge: real client IP + req.secure from X-Forwarded-*
// 30mb: statement PDFs are sent as base64, and a batch upload can include
// several at once, well under Anthropic's 32MB per-request document limit.
app.use(express.json({ limit: "30mb" }));

app.post("/api/login", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: { message: "Too many attempts. Try again in a bit." } });
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expected = process.env.APP_PASSWORD;
  const ok = Buffer.byteLength(password) === Buffer.byteLength(expected)
    && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: { message: "Wrong password." } });
  setSessionCookie(req, res);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authenticated: verifyToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]) });
});

app.get("/api/storage/:key", requireAuth, (req, res) => {
  const store = readStore();
  if (!(req.params.key in store)) return res.status(404).json({ error: "not found" });
  res.json({ key: req.params.key, value: store[req.params.key] });
});

app.put("/api/storage/:key", requireAuth, (req, res) => {
  const store = readStore();
  store[req.params.key] = req.body.value;
  writeStore(store);
  res.json({ key: req.params.key, value: req.body.value });
});

app.delete("/api/storage/:key", requireAuth, (req, res) => {
  const store = readStore();
  delete store[req.params.key];
  writeStore(store);
  res.json({ key: req.params.key, deleted: true });
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { message: "No API key configured. Copy .env.example to .env and add your key from console.anthropic.com, then restart the server." },
    });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: req.body.messages,
      }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: { message: "Couldn't reach the Anthropic API: " + e.message } });
  }
});

// Reads one or more bank/credit-card/Venmo statements (CSV text or base64
// PDF) and extracts their transactions via Claude, in a single request so
// mixed batches (some CSVs, some PDFs) are handled together. This only
// extracts — nothing is written to data.json here, the client reviews and
// commits the parsed rows itself.
const STATEMENT_SCHEMA = {
  type: "object",
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fileName: { type: "string" },
          accountGuess: { type: "string", enum: ["bank", "credit_card", "venmo", "unknown"] },
          accountNameGuess: { type: "string" },
          transactions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", format: "date" },
                description: { type: "string" },
                amount: { type: "number" },
                direction: { type: "string", enum: ["debit", "credit"] },
              },
              required: ["date", "description", "amount", "direction"],
              additionalProperties: false,
            },
          },
        },
        required: ["fileName", "accountGuess", "accountNameGuess", "transactions"],
        additionalProperties: false,
      },
    },
  },
  required: ["statements"],
  additionalProperties: false,
};

app.post("/api/parse-statements", requireAuth, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { message: "No API key configured. Copy .env.example to .env and add your key from console.anthropic.com, then restart the server." },
    });
  }
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: { message: "No files provided." } });
  }

  const content = [];
  for (const f of files) {
    content.push({ type: "text", text: `File: ${f.name}` });
    if (f.kind === "pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.content } });
    } else {
      content.push({ type: "text", text: f.content });
    }
  }
  content.push({
    type: "text",
    text:
      "For each file above, extract every transaction line into the schema. Use the statement's own conventions to decide debit vs credit — debit means money leaving the account (a purchase, a bill, a payment sent), credit means money arriving (a deposit, a refund, a payment received). Guess which kind of account each file is a statement for — a checking/bank account, a credit card, or Venmo — and if the statement shows an account or card name or nickname, put your best guess of it in accountNameGuess.",
  });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Structured extraction, not open-ended reasoning — Sonnet is accurate
        // enough for this and far cheaper than Opus. Bump to "claude-opus-5"
        // here if accuracy on messy or scanned statements isn't good enough.
        // Thinking is off: Sonnet 5 runs adaptive thinking by default, which
        // can eat the whole max_tokens budget on a long statement before any
        // JSON gets written — this is bounded extraction, so there's nothing
        // for it to reason through anyway.
        model: "claude-sonnet-5",
        max_tokens: 16000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: STATEMENT_SCHEMA } },
        messages: [{ role: "user", content }],
      }),
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);
    if (json.stop_reason === "refusal") {
      return res.status(422).json({ error: { message: "Claude declined to process one of these files. Try uploading it by itself, or double-check it's a normal statement." } });
    }
    const textBlock = json.content?.find((b) => b.type === "text");
    if (!textBlock) {
      const message = json.stop_reason === "max_tokens"
        ? "That statement produced too much output to finish in one pass — try uploading fewer files, or fewer pages, at a time."
        : "No output returned from the parser.";
      return res.status(502).json({ error: { message } });
    }
    res.json(JSON.parse(textBlock.text));
  } catch (e) {
    res.status(502).json({ error: { message: "Couldn't parse statements: " + e.message } });
  }
});

app.use(express.static("dist"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Runway is running (password-protected).`);
  console.log(`  On this computer: http://localhost:${PORT}`);
  console.log(`  From your phone (via Tailscale): http://<your-machine-name>:${PORT}`);
});
