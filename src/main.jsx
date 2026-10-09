import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// The app was originally built for Claude.ai, which provides a window.storage
// API. This shim recreates it on top of the local server's /api/storage
// endpoints, which save to data.json on the computer running the server —
// so your laptop and phone always see the same data.
window.storage = {
  async get(key) {
    const r = await fetch(`/api/storage/${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error("Key not found");
    const { value } = await r.json();
    return { key, value, shared: false };
  },
  async set(key, value) {
    const r = await fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!r.ok) throw new Error("Save failed");
    return { key, value, shared: false };
  },
  async delete(key) {
    await fetch(`/api/storage/${encodeURIComponent(key)}`, { method: "DELETE" });
    return { key, deleted: true, shared: false };
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
