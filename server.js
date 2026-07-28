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
app.use(express.json({ limit: "2mb" }));

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

app.use(express.static("dist"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Runway is running.`);
  console.log(`  On this computer: http://localhost:${PORT}`);
  console.log(`  From your phone (via Tailscale): http://<your-machine-name>:${PORT}`);
});
