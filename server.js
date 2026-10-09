// Runway local server
// - Serves the built app (dist/)
// - /api/storage/* : saves your budget data to data.json on this computer,
//   so every device (laptop, phone) sees the same numbers
// - /api/chat : forwards chat requests to the Anthropic API, adding your key
//   from .env — the key never leaves this machine
import express from "express";
import fs from "fs";
import path from "path";

// Minimal .env loader (no dependency needed)
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.cwd(), "data.json");

const readStore = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return {}; }
};
const writeStore = (s) => fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));

const app = express();
// 30mb: statement PDFs are sent as base64, and a batch upload can include
// several at once, well under Anthropic's 32MB per-request document limit.
app.use(express.json({ limit: "30mb" }));

app.get("/api/storage/:key", (req, res) => {
  const store = readStore();
  if (!(req.params.key in store)) return res.status(404).json({ error: "not found" });
  res.json({ key: req.params.key, value: store[req.params.key] });
});

app.put("/api/storage/:key", (req, res) => {
  const store = readStore();
  store[req.params.key] = req.body.value;
  writeStore(store);
  res.json({ key: req.params.key, value: req.body.value });
});

app.delete("/api/storage/:key", (req, res) => {
  const store = readStore();
  delete store[req.params.key];
  writeStore(store);
  res.json({ key: req.params.key, deleted: true });
});

app.post("/api/chat", async (req, res) => {
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

app.post("/api/parse-statements", async (req, res) => {
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
  console.log(`Runway is running.`);
  console.log(`  On this computer: http://localhost:${PORT}`);
  console.log(`  From your phone (via Tailscale): http://<your-machine-name>:${PORT}`);
});
