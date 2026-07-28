import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, CartesianGrid, LineChart, Line, ReferenceLine,
} from "recharts";

/* ---------------- date utilities (all local, no timezone drift) ---------------- */

const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const todayKey = () => toKey(new Date());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const monthLabel = (y, m) =>
  new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const fmtMoney = (n, showSign = false) => {
  const sign = n < 0 ? "-" : showSign ? "+" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtShort = (n) => {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k` : abs.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const niceDate = (key) =>
  fromKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const uid = () => Math.random().toString(36).slice(2, 10);

// All dates (keys) a paycheck lands on within [from, to], expanding repeats
function paycheckOccurrences(p, from, to) {
  const out = [];
  let d = fromKey(p.date);
  if (p.repeat === "none") {
    if (d >= from && d <= to) out.push(toKey(d));
    return out;
  }
  const step = p.repeat === "weekly" ? 7 : p.repeat === "biweekly" ? 14 : 0;
  const anchorDay = d.getDate();
  let guard = 0;
  while (d <= to && guard < 600) {
    if (d >= from) out.push(toKey(d));
    if (step) d = addDays(d, step);
    else {
      const nm = d.getMonth() + 1;
      const y = d.getFullYear() + (nm > 11 ? 1 : 0), m = nm % 12;
      d = new Date(y, m, Math.min(anchorDay, daysInMonth(y, m)));
    }
    guard++;
  }
  return out;
}

/* ---------------- projection engine ---------------- */

// Expands paychecks (with repeats), recurring bills, and future one-time
// expenses into a per-day delta map, then walks forward from the anchor
// balance to produce a projected balance for every day in the horizon.
function buildProjection(data, horizonDays = 210) {
  if (!data.balanceAsOf) return { byDay: {}, start: null, end: null };
  const start = fromKey(data.balanceAsOf);
  const end = addDays(start, horizonDays);
  const deltas = {};
  const add = (key, amt, label) => {
    if (!deltas[key]) deltas[key] = { net: 0, items: [] };
    deltas[key].net += amt;
    deltas[key].items.push({ amt, label });
  };

  // Recurring bills: hit their day-of-month each month (clamped to month length),
  // skipping any occurrence before an optional future startDate
  for (const r of data.recurring) {
    const startFrom = r.startDate ? fromKey(r.startDate) : null;
    let y = start.getFullYear(), m = start.getMonth();
    for (let i = 0; i < Math.ceil(horizonDays / 28) + 2; i++) {
      const day = Math.min(r.day, daysInMonth(y, m));
      const d = new Date(y, m, day);
      if (d > start && d <= end && (!startFrom || d >= startFrom)) add(toKey(d), -r.amount, r.name);
      m++; if (m > 11) { m = 0; y++; }
    }
  }

  // Paychecks: one-time or repeating (weekly / biweekly / monthly)
  for (const p of data.paychecks) {
    let d = fromKey(p.date);
    if (p.repeat === "none") {
      if (d > start && d <= end) add(toKey(d), p.amount, p.source || "Paycheck");
    } else {
      const step = p.repeat === "weekly" ? 7 : p.repeat === "biweekly" ? 14 : 0;
      let guard = 0;
      while (d <= end && guard < 400) {
        if (d > start) add(toKey(d), p.amount, p.source || "Paycheck");
        if (step) d = addDays(d, step);
        else { // monthly: same day-of-month, clamped
          const nm = d.getMonth() + 1;
          const y = d.getFullYear() + (nm > 11 ? 1 : 0), m = nm % 12;
          d = new Date(y, m, Math.min(fromKey(p.date).getDate(), daysInMonth(y, m)));
        }
        guard++;
      }
    }
  }

  // One-time expenses dated after the balance anchor count against the future
  for (const e of data.expenses) {
    const d = fromKey(e.date);
    if (d > start && d <= end) add(e.date, -e.amount, e.description || e.category);
  }

  // Credit card payments: money leaving the bank account to pay down a card
  for (const pay of data.cardPayments) {
    const d = fromKey(pay.date);
    if (d > start && d <= end) {
      const card = data.creditCards.find((c) => c.id === pay.cardId);
      add(pay.date, -pay.amount, `Payment to ${card ? card.name : "credit card"}`);
    }
  }

  const byDay = {};
  let bal = data.balance;
  for (let i = 0; i <= horizonDays; i++) {
    const key = toKey(addDays(start, i));
    if (deltas[key]) bal += deltas[key].net;
    byDay[key] = { balance: bal, items: deltas[key]?.items || [] };
  }
  return { byDay, start: toKey(start), end: toKey(end) };
}

// Projects a single credit card's balance owed forward: card purchases increase
// it, payments from the bank account decrease it. Mirrors buildProjection but
// scoped to one card and without recurring bills or income.
function buildCardProjection(card, cardTransactions, cardPayments, horizonDays = 210) {
  if (!card.balanceAsOf) return { byDay: {}, start: null, end: null };
  const start = fromKey(card.balanceAsOf);
  const end = addDays(start, horizonDays);
  const deltas = {};
  const add = (key, amt) => { deltas[key] = (deltas[key] || 0) + amt; };

  for (const t of cardTransactions) {
    const d = fromKey(t.date);
    if (d >= start && d <= end) add(t.date, t.amount);
  }
  for (const p of cardPayments) {
    const d = fromKey(p.date);
    if (d >= start && d <= end) add(p.date, -p.amount);
  }

  const byDay = {};
  let bal = card.balance;
  for (let i = 0; i <= horizonDays; i++) {
    const key = toKey(addDays(start, i));
    if (deltas[key]) bal += deltas[key];
    byDay[key] = bal;
  }
  return { byDay, start: toKey(start), end: toKey(end) };
}

/* ---------------- storage ---------------- */

const STORE_KEY = "budget-app-v1";
const EMPTY = {
  balance: 0, balanceAsOf: null, recurring: [], expenses: [], paychecks: [],
  creditCards: [], cardTransactions: [], cardPayments: [],
};

async function loadData() {
  try {
    const res = await window.storage.get(STORE_KEY);
    if (res?.value) return { ...EMPTY, ...JSON.parse(res.value) };
  } catch (e) { /* first run — nothing saved yet */ }
  return { ...EMPTY };
}
async function saveData(data) {
  try { await window.storage.set(STORE_KEY, JSON.stringify(data)); }
  catch (e) { console.error("Save failed", e); }
}

/* ---------------- shared bits ---------------- */

const CHART_COLORS = ["#34D399", "#38BDF8", "#FB923C", "#A78BFA", "#F87171", "#2DD4BF", "#FBBF24", "#60A5FA", "#F472B6", "#A3E635"];

const inputCls = "w-full rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500";
const btnPrimary = "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-stone-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const btnGhost = "rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-xs font-medium text-stone-300 hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors";

function Card({ title, children, action, className = "" }) {
  return (
    <div className={`rounded-2xl border border-stone-800 bg-stone-900 p-5 shadow-sm shadow-black/20 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-400">{label}</span>
      {children}
    </label>
  );
}

function Mono({ children, className = "" }) {
  return <span className={`font-mono tabular-nums ${className}`} style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}>{children}</span>;
}

function Empty({ children }) {
  return <p className="rounded-lg border border-dashed border-stone-700 bg-stone-800/40 px-4 py-6 text-center text-sm text-stone-500">{children}</p>;
}

function NoteField({ value, onChange, className = "" }) {
  return (
    <Field label="Note (optional)">
      <input className={inputCls + " " + className} placeholder="Any extra detail…" value={value} onChange={onChange} />
    </Field>
  );
}

function NoteLine({ note }) {
  if (!note) return null;
  return <div className="mt-0.5 truncate text-xs italic text-stone-500">{note}</div>;
}

/* ---------------- main app ---------------- */

export default function BudgetApp() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [chatMessages, setChatMessages] = useState([]);

  useEffect(() => { loadData().then(setData); }, []);

  const update = (patch) => {
    setData((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      saveData(next);
      return next;
    });
  };

  const projection = useMemo(() => (data ? buildProjection(data) : null), [data]);

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-950">
        <p className="text-sm text-stone-400">Loading your budget…</p>
      </div>
    );
  }

  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "money", label: "Money in & out" },
    { id: "calendar", label: "Balance calendar" },
    { id: "chat", label: "Ask Claude" },
  ];

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap');`}</style>

      <header className="sticky top-0 z-20 border-b border-stone-800 bg-stone-900">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Runway</h1>
            <span className="hidden text-xs text-stone-500 sm:inline">your money, day by day</span>
          </div>
          <CurrentBalanceDisplay data={data} projection={projection} goTo={setTab} />
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                tab === t.id ? "border-emerald-500 text-emerald-400" : "border-transparent text-stone-500 hover:text-stone-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === "dashboard" && <Dashboard data={data} projection={projection} goTo={setTab} />}
        {tab === "money" && <MoneyTab data={data} update={update} />}
        {tab === "calendar" && <CalendarTab data={data} update={update} projection={projection} />}
        {tab === "chat" && <ChatTab data={data} projection={projection} messages={chatMessages} setMessages={setChatMessages} />}
      </main>
    </div>
  );
}

/* ---------------- balance chip ---------------- */

// Read-only display for the header: the live balance, projected forward from
// the starting balance (set on the Balance calendar tab) through today's
// transactions — never edited directly.
function CurrentBalanceDisplay({ data, projection, goTo }) {
  if (!data.balanceAsOf) {
    return (
      <button
        onClick={() => goTo("calendar")}
        className="rounded-xl border border-stone-800 bg-stone-800 px-3 py-1.5 text-left text-xs text-stone-400 hover:border-emerald-500 hover:text-stone-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors"
      >
        Set a starting balance in Balance calendar →
      </button>
    );
  }

  const balance = projection?.byDay?.[todayKey()]?.balance ?? data.balance;

  return (
    <button
      onClick={() => goTo("calendar")}
      className="flex items-center gap-2 rounded-xl border border-stone-800 bg-stone-800 px-3 py-1.5 text-left hover:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors"
      title="Updates automatically from your bills, income, and purchases — set the starting point in Balance calendar"
    >
      <div>
        <div className="text-[10px] uppercase tracking-wider text-stone-500">Balance today</div>
        <Mono className="text-lg font-semibold text-emerald-400">{fmtMoney(balance)}</Mono>
      </div>
    </button>
  );
}

// Editable starting-balance anchor, lives on the Balance calendar tab: sets
// the balance/date the projection engine walks forward from.
function BalanceChip({ data, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  if (editing || !data.balanceAsOf) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="number" step="0.01" placeholder="Starting balance"
          value={val} onChange={(e) => setVal(e.target.value)}
          className="w-44 rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          autoFocus={editing}
        />
        <button
          className={btnPrimary}
          disabled={val === "" || isNaN(parseFloat(val))}
          onClick={() => { onSave({ balance: parseFloat(val), balanceAsOf: todayKey() }); setEditing(false); setVal(""); }}
        >
          Set starting balance
        </button>
        {editing && <button className={btnGhost} onClick={() => setEditing(false)}>Cancel</button>}
      </div>
    );
  }

  return (
    <button
      onClick={() => { setVal(String(data.balance)); setEditing(true); }}
      className="group flex items-center gap-2 rounded-xl border border-stone-800 bg-stone-800 px-3 py-1.5 text-left hover:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors"
      title="Update your starting balance"
    >
      <div>
        <div className="text-[10px] uppercase tracking-wider text-stone-500">Starting balance · {niceDate(data.balanceAsOf)}</div>
        <Mono className="text-lg font-semibold text-emerald-400">{fmtMoney(data.balance)}</Mono>
      </div>
      <span className="text-xs text-stone-500 group-hover:text-emerald-400">edit</span>
    </button>
  );
}

/* ---------------- dashboard ---------------- */

function Dashboard({ data, projection, goTo }) {
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  const monthExpenses = data.expenses.filter((e) => e.date.startsWith(thisMonthPrefix));
  const monthCardTx = data.cardTransactions.filter((t) => t.date.startsWith(thisMonthPrefix));
  const monthSpend = monthExpenses.reduce((s, e) => s + e.amount, 0) + monthCardTx.reduce((s, t) => s + t.amount, 0);
  const monthPurchaseCount = monthExpenses.length + monthCardTx.length;
  const recurringTotal = data.recurring.reduce((s, r) => s + r.amount, 0);

  // Category totals — this month's one-time spending, filterable by payment source
  const hasCards = data.creditCards.length > 0;
  const [spendSource, setSpendSource] = useState("both"); // 'bank' | 'card' | 'both'
  const categorySource = !hasCards ? monthExpenses
    : spendSource === "bank" ? monthExpenses
    : spendSource === "card" ? monthCardTx
    : [...monthExpenses, ...monthCardTx];
  const catTotals = {};
  for (const e of categorySource) catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
  const pieData = Object.entries(catTotals).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const categoryEmptyMsg = {
    bank: "No bank account purchases logged this month yet. Add them under Money in & out.",
    card: "No credit card purchases logged this month yet. Add them under Money in & out → Credit cards.",
    both: "No purchases logged this month yet. Add them under Money in & out.",
  }[hasCards ? spendSource : "bank"];

  // Last 6 months: spending (one-time + recurring assumed paid) vs income received
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prefix = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const spend = data.expenses.filter((e) => e.date.startsWith(prefix)).reduce((s, e) => s + e.amount, 0);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth()));
    const income = data.paychecks.reduce(
      (s, p) => s + paycheckOccurrences(p, monthStart, monthEnd > now ? now : monthEnd).length * p.amount, 0
    );
    months.push({ month: d.toLocaleDateString("en-US", { month: "short" }), Spending: +spend.toFixed(2), Income: +income.toFixed(2) });
  }
  const hasHistory = months.some((m) => m.Spending > 0 || m.Income > 0);

  // Runway: projected balance next 90 days + minimum point
  let runway = [], minPoint = null;
  if (projection?.start) {
    const start = fromKey(projection.start);
    for (let i = 0; i <= 90; i++) {
      const key = toKey(addDays(start, i));
      const p = projection.byDay[key];
      if (!p) break;
      runway.push({ day: fromKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" }), balance: +p.balance.toFixed(2) });
      if (!minPoint || p.balance < minPoint.balance) minPoint = { key, balance: p.balance };
    }
  }

  const nothingYet = !data.balanceAsOf && data.expenses.length === 0 && data.recurring.length === 0 && data.paychecks.length === 0;

  return (
    <div className="space-y-5">
      {nothingYet && (
        <Card>
          <h2 className="mb-1 text-lg font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Welcome to Runway</h2>
          <p className="mb-3 text-sm text-stone-300">
            Three steps to get a picture of your money: set your current bank balance (top right), then add your
            recurring bills and paychecks under <b>Money in &amp; out</b>. The dashboard, calendar, and chat all build from there.
          </p>
          <button className={btnPrimary} onClick={() => goTo("money")}>Add money in &amp; out</button>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Spent this month" value={fmtMoney(monthSpend)} sub={`${monthPurchaseCount} purchase${monthPurchaseCount === 1 ? "" : "s"}`} />
        <Stat label="Monthly bills" value={fmtMoney(recurringTotal)} sub={`${data.recurring.length} recurring`} />
        <Stat
          label="Lowest projected (90d)"
          value={minPoint ? fmtMoney(minPoint.balance) : "—"}
          sub={minPoint ? `on ${niceDate(minPoint.key)}` : "set a balance to project"}
          tone={minPoint ? (minPoint.balance < 0 ? "bad" : minPoint.balance < 250 ? "warn" : "good") : undefined}
        />
        <Stat
          label="Balance in 30 days"
          value={projection?.start ? fmtMoney(projection.byDay[toKey(addDays(fromKey(projection.start), 30))]?.balance ?? 0) : "—"}
          sub="projected"
        />
      </div>

      {runway.length > 1 && (
        <Card title="90-day runway">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runway} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#a8a29e" }} interval={13} />
                <YAxis tick={{ fontSize: 11, fill: "#a8a29e" }} tickFormatter={fmtShort} width={52} />
                <Tooltip formatter={(v) => fmtMoney(v)} labelStyle={{ fontWeight: 600, color: "#e7e5e4" }} contentStyle={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }} itemStyle={{ color: "#e7e5e4" }} />
                <ReferenceLine y={0} stroke="#F87171" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="balance" name="Projected balance" stroke="#34D399" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title={`Spending by category · ${now.toLocaleDateString("en-US", { month: "long" })}`}
          action={hasCards ? (
            <div className="flex gap-0.5 rounded-lg border border-stone-800 bg-stone-800/60 p-0.5">
              {[
                { id: "both", label: "Both" },
                { id: "bank", label: "Account" },
                { id: "card", label: "Card" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setSpendSource(opt.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    spendSource === opt.id ? "bg-stone-700 text-emerald-400 shadow-sm" : "text-stone-500 hover:text-stone-200"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : undefined}
        >
          {pieData.length === 0 ? (
            <Empty>{categoryEmptyMsg}</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {pieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }} itemStyle={{ color: "#e7e5e4" }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#d6d3d1" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Income vs spending · last 6 months">
          {!hasHistory ? (
            <Empty>Once you log purchases and paychecks, monthly totals show up here.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={months} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#a8a29e" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#a8a29e" }} tickFormatter={fmtShort} width={52} />
                  <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }} itemStyle={{ color: "#e7e5e4" }} labelStyle={{ color: "#e7e5e4" }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#d6d3d1" }} />
                  <Bar dataKey="Income" fill="#34D399" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Spending" fill="#F87171" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const toneCls = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-400" : tone === "good" ? "text-emerald-400" : "text-stone-100";
  return (
    <div className="rounded-2xl border border-stone-800 bg-stone-900 p-4 shadow-sm shadow-black/20">
      <div className="text-[11px] font-medium uppercase tracking-wider text-stone-500">{label}</div>
      <Mono className={`mt-1 block text-xl font-semibold ${toneCls}`}>{value}</Mono>
      {sub && <div className="mt-0.5 text-xs text-stone-400">{sub}</div>}
    </div>
  );
}

/* ---------------- money in & out ---------------- */

function MoneyTab({ data, update }) {
  const categories = useMemo(
    () => [...new Set([...data.expenses, ...data.cardTransactions].map((e) => e.category))].sort(),
    [data.expenses, data.cardTransactions]
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-5">
          <RecurringSection data={data} update={update} />
          <PaycheckSection data={data} update={update} />
        </div>
        <ExpenseSection data={data} update={update} categories={categories} />
      </div>
      <CreditCardsSection data={data} update={update} categories={categories} />
    </div>
  );
}

function RecurringSection({ data, update }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("1");
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const valid = name.trim() && parseFloat(amount) > 0 && +day >= 1 && +day <= 31;

  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDay, setEditDay] = useState("1");
  const [editStartDate, setEditStartDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const editValid = editName.trim() && parseFloat(editAmount) > 0 && +editDay >= 1 && +editDay <= 31;

  const addItem = () => {
    update((d) => ({
      ...d,
      recurring: [...d.recurring, { id: uid(), name: name.trim(), amount: parseFloat(amount), day: +day, startDate: startDate || null, note: note.trim() }],
    }));
    setName(""); setAmount(""); setStartDate(""); setNote("");
  };

  const startEdit = (r) => {
    setEditingId(r.id); setEditName(r.name); setEditAmount(String(r.amount)); setEditDay(String(r.day)); setEditStartDate(r.startDate || ""); setEditNote(r.note || "");
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (id) => {
    update((d) => ({
      ...d,
      recurring: d.recurring.map((x) => x.id === id
        ? { ...x, name: editName.trim(), amount: parseFloat(editAmount), day: +editDay, startDate: editStartDate || null, note: editNote.trim() }
        : x),
    }));
    setEditingId(null);
  };

  return (
    <Card title="Recurring monthly bills">
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_90px_140px_auto] sm:items-end">
        <Field label="Bill"><input className={inputCls} placeholder="Rent, Netflix, car insurance…" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Day of month"><input className={inputCls} type="number" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Starts on (optional)">
          <input className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <button className={btnPrimary} disabled={!valid} onClick={addItem}>Add bill</button>
        <div className="sm:col-span-5"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      {data.recurring.length === 0 ? (
        <Empty>No recurring bills yet. Rent, subscriptions, insurance — anything that goes out every month.</Empty>
      ) : (
        <ul className="divide-y divide-stone-800">
          {[...data.recurring].sort((a, b) => a.day - b.day).map((r) => (
            <li key={r.id} className="py-2">
              {editingId === r.id ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_90px_140px_auto] sm:items-end">
                  <Field label="Bill"><input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
                  <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></Field>
                  <Field label="Day of month"><input className={inputCls} type="number" min="1" max="31" value={editDay} onChange={(e) => setEditDay(e.target.value)} /></Field>
                  <Field label="Starts on (optional)">
                    <input className={inputCls} type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} />
                  </Field>
                  <div className="flex gap-2">
                    <button className={btnPrimary} disabled={!editValid} onClick={() => saveEdit(r.id)}>Save</button>
                    <button className={btnGhost} onClick={cancelEdit}>Cancel</button>
                  </div>
                  <div className="sm:col-span-5"><NoteField value={editNote} onChange={(e) => setEditNote(e.target.value)} /></div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.name}</div>
                    <div className="text-xs text-stone-400">
                      day {r.day} of each month
                      {r.startDate && r.startDate > todayKey() && <span className="ml-1 text-amber-400">· starts {niceDate(r.startDate)}</span>}
                    </div>
                    <NoteLine note={r.note} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Mono className="text-sm font-semibold text-red-400">{fmtMoney(-r.amount, true)}</Mono>
                    <button className={btnGhost} onClick={() => startEdit(r)}>Edit</button>
                    <button className={btnGhost} onClick={() => update((d) => ({ ...d, recurring: d.recurring.filter((x) => x.id !== r.id) }))}>Remove</button>
                  </div>
                </div>
              )}
            </li>
          ))}
          <li className="flex items-center justify-between pt-3 text-sm font-semibold">
            <span>Total per month</span>
            <Mono>{fmtMoney(data.recurring.reduce((s, r) => s + r.amount, 0))}</Mono>
          </li>
        </ul>
      )}
    </Card>
  );
}

function PaycheckSection({ data, update }) {
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayKey());
  const [repeat, setRepeat] = useState("biweekly");
  const [note, setNote] = useState("");
  const valid = parseFloat(amount) > 0 && date;

  const [editingId, setEditingId] = useState(null);
  const [editSource, setEditSource] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editRepeat, setEditRepeat] = useState("biweekly");
  const [editNote, setEditNote] = useState("");
  const editValid = parseFloat(editAmount) > 0 && editDate;

  const addItem = () => {
    update((d) => ({ ...d, paychecks: [...d.paychecks, { id: uid(), source: source.trim() || "Paycheck", amount: parseFloat(amount), date, repeat, note: note.trim() }] }));
    setSource(""); setAmount(""); setNote("");
  };

  const startEdit = (p) => {
    setEditingId(p.id); setEditSource(p.source); setEditAmount(String(p.amount)); setEditDate(p.date); setEditRepeat(p.repeat); setEditNote(p.note || "");
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (id) => {
    update((d) => ({
      ...d,
      paychecks: d.paychecks.map((x) => x.id === id
        ? { ...x, source: editSource.trim() || "Paycheck", amount: parseFloat(editAmount), date: editDate, repeat: editRepeat, note: editNote.trim() }
        : x),
    }));
    setEditingId(null);
  };

  const repeatLabel = { none: "one-time", weekly: "every week", biweekly: "every 2 weeks", monthly: "every month" };

  return (
    <Card title="Paychecks & income">
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Source (optional)"><input className={inputCls} placeholder="Main job, side gig…" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date (first or next payday)"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Repeats">
          <select className={inputCls} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
            <option value="none">One-time</option>
            <option value="weekly">Every week</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Every month</option>
          </select>
        </Field>
        <div className="sm:col-span-2"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <button className={`${btnPrimary} mb-4 w-full sm:w-auto`} disabled={!valid} onClick={addItem}>Add income</button>
      {data.paychecks.length === 0 ? (
        <Empty>Add your paychecks — repeating ones power the balance calendar and projections.</Empty>
      ) : (
        <ul className="divide-y divide-stone-800">
          {[...data.paychecks].sort((a, b) => a.date.localeCompare(b.date)).map((p) => (
            <li key={p.id} className="py-2">
              {editingId === p.id ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Source (optional)"><input className={inputCls} value={editSource} onChange={(e) => setEditSource(e.target.value)} /></Field>
                  <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></Field>
                  <Field label="Date"><input className={inputCls} type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></Field>
                  <Field label="Repeats">
                    <select className={inputCls} value={editRepeat} onChange={(e) => setEditRepeat(e.target.value)}>
                      <option value="none">One-time</option>
                      <option value="weekly">Every week</option>
                      <option value="biweekly">Every 2 weeks</option>
                      <option value="monthly">Every month</option>
                    </select>
                  </Field>
                  <div className="sm:col-span-2"><NoteField value={editNote} onChange={(e) => setEditNote(e.target.value)} /></div>
                  <div className="flex gap-2 sm:col-span-2">
                    <button className={btnPrimary} disabled={!editValid} onClick={() => saveEdit(p.id)}>Save</button>
                    <button className={btnGhost} onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{p.source}</div>
                    <div className="text-xs text-stone-400">{niceDate(p.date)} · {repeatLabel[p.repeat]}</div>
                    <NoteLine note={p.note} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Mono className="text-sm font-semibold text-emerald-400">{fmtMoney(p.amount, true)}</Mono>
                    <button className={btnGhost} onClick={() => startEdit(p)}>Edit</button>
                    <button className={btnGhost} onClick={() => update((d) => ({ ...d, paychecks: d.paychecks.filter((x) => x.id !== p.id) }))}>Remove</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ExpenseSection({ data, update, categories }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState("");
  const valid = parseFloat(amount) > 0 && category.trim() && date;

  const [editingId, setEditingId] = useState(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const editValid = parseFloat(editAmount) > 0 && editCategory.trim() && editDate;

  const addItem = () => {
    update((d) => ({
      ...d,
      expenses: [...d.expenses, { id: uid(), description: desc.trim(), amount: parseFloat(amount), category: category.trim(), date, note: note.trim() }],
    }));
    setDesc(""); setAmount(""); setNote("");
  };

  const startEdit = (e) => {
    setEditingId(e.id); setEditDesc(e.description); setEditAmount(String(e.amount)); setEditCategory(e.category); setEditDate(e.date); setEditNote(e.note || "");
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (id) => {
    update((d) => ({
      ...d,
      expenses: d.expenses.map((x) => x.id === id
        ? { ...x, description: editDesc.trim(), amount: parseFloat(editAmount), category: editCategory.trim(), date: editDate, note: editNote.trim() }
        : x),
    }));
    setEditingId(null);
  };

  const sorted = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Card title="One-time purchases">
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="What was it? (optional)"><input className={inputCls} placeholder="Groceries at Wegmans…" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Category — type your own">
          <input className={inputCls} list="category-options" placeholder="Groceries, Fun, Gas…" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="category-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Date (future = planned spend)"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="sm:col-span-2"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <button className={`${btnPrimary} mb-4 w-full sm:w-auto`} disabled={!valid} onClick={addItem}>Add purchase</button>
      {sorted.length === 0 ? (
        <Empty>Log any spending here with your own category names — charts group by whatever categories you invent.</Empty>
      ) : (
        <ul className="max-h-[520px] divide-y divide-stone-800 overflow-y-auto pr-1">
          {sorted.map((e) => (
            <li key={e.id} className="py-2">
              {editingId === e.id ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="What was it? (optional)"><input className={inputCls} value={editDesc} onChange={(ev) => setEditDesc(ev.target.value)} /></Field>
                  <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={editAmount} onChange={(ev) => setEditAmount(ev.target.value)} /></Field>
                  <Field label="Category — type your own">
                    <input className={inputCls} list="category-options" value={editCategory} onChange={(ev) => setEditCategory(ev.target.value)} />
                  </Field>
                  <Field label="Date"><input className={inputCls} type="date" value={editDate} onChange={(ev) => setEditDate(ev.target.value)} /></Field>
                  <div className="sm:col-span-2"><NoteField value={editNote} onChange={(ev) => setEditNote(ev.target.value)} /></div>
                  <div className="flex gap-2 sm:col-span-2">
                    <button className={btnPrimary} disabled={!editValid} onClick={() => saveEdit(e.id)}>Save</button>
                    <button className={btnGhost} onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{e.description || e.category}</div>
                    <div className="text-xs text-stone-400">
                      <span className="mr-1 inline-block rounded bg-emerald-900/40 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">{e.category}</span>
                      {niceDate(e.date)}{e.date > todayKey() && <span className="ml-1 text-amber-400">· planned</span>}
                    </div>
                    <NoteLine note={e.note} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Mono className="text-sm font-semibold text-red-400">{fmtMoney(-e.amount, true)}</Mono>
                    <button className={btnGhost} onClick={() => startEdit(e)}>Edit</button>
                    <button className={btnGhost} onClick={() => update((d) => ({ ...d, expenses: d.expenses.filter((x) => x.id !== e.id) }))}>Remove</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- credit cards ---------------- */

function CreditCardsSection({ data, update, categories }) {
  const [name, setName] = useState("");
  const [startBalance, setStartBalance] = useState("");
  const [startDate, setStartDate] = useState(todayKey());
  const valid = name.trim() && startDate;

  const addCard = () => {
    update((d) => ({
      ...d,
      creditCards: [...d.creditCards, { id: uid(), name: name.trim(), balance: parseFloat(startBalance) || 0, balanceAsOf: startDate }],
    }));
    setName(""); setStartBalance(""); setStartDate(todayKey());
  };

  const removeCard = (id) => {
    update((d) => ({
      ...d,
      creditCards: d.creditCards.filter((c) => c.id !== id),
      cardTransactions: d.cardTransactions.filter((t) => t.cardId !== id),
      cardPayments: d.cardPayments.filter((p) => p.cardId !== id),
    }));
  };

  return (
    <Card title="Credit cards">
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_140px_auto] sm:items-end">
        <Field label="Card name"><input className={inputCls} placeholder="Chase Sapphire, Amex…" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Balance owed"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={startBalance} onChange={(e) => setStartBalance(e.target.value)} /></Field>
        <Field label="As of"><input className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <button className={btnPrimary} disabled={!valid} onClick={addCard}>Add card</button>
      </div>
      <p className="mb-4 -mt-2 text-xs text-stone-400">
        Set "as of" to a past date if you want to start logging transactions from before today — anything dated after it will be added to the balance shown below.
      </p>
      {data.creditCards.length === 0 ? (
        <Empty>Add a credit card to track its balance, log purchases on it, and record payments from your bank account.</Empty>
      ) : (
        <div className="space-y-5">
          {data.creditCards.map((card) => (
            <CreditCardPanel key={card.id} card={card} data={data} update={update} categories={categories} onRemoveCard={() => removeCard(card.id)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CreditCardPanel({ card, data, update, categories, onRemoveCard }) {
  const transactions = data.cardTransactions.filter((t) => t.cardId === card.id);
  const payments = data.cardPayments.filter((p) => p.cardId === card.id);
  // Widen the horizon if the anchor date is further back than the default
  // window, so "today" is always covered even when backdating the balance.
  const daysSinceAnchor = card.balanceAsOf
    ? Math.ceil((fromKey(todayKey()) - fromKey(card.balanceAsOf)) / 86400000)
    : 0;
  const horizonDays = Math.max(210, daysSinceAnchor + 30);
  const projection = useMemo(() => buildCardProjection(card, transactions, payments, horizonDays), [card, transactions, payments, horizonDays]);
  const currentBalance = projection.byDay[todayKey()] ?? card.balance;

  const [editingBalance, setEditingBalance] = useState(false);
  const [balVal, setBalVal] = useState("");
  const [balDate, setBalDate] = useState("");
  const balValid = balVal !== "" && !isNaN(parseFloat(balVal)) && balDate;

  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(todayKey());
  const [payNote, setPayNote] = useState("");
  const payValid = parseFloat(payAmount) > 0 && payDate;

  const makePayment = () => {
    update((d) => ({ ...d, cardPayments: [...d.cardPayments, { id: uid(), cardId: card.id, amount: parseFloat(payAmount), date: payDate, note: payNote.trim() }] }));
    setPayAmount(""); setPayNote("");
  };

  return (
    <div className="rounded-xl border border-stone-800 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{card.name}</div>
          {editingBalance ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Balance">
                <input
                  type="number" step="0.01" autoFocus
                  className="w-32 rounded-lg border border-stone-700 bg-stone-800 px-2 py-1.5 text-sm text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  value={balVal} onChange={(e) => setBalVal(e.target.value)}
                />
              </Field>
              <Field label="As of">
                <input
                  type="date"
                  className="rounded-lg border border-stone-700 bg-stone-800 px-2 py-1.5 text-sm text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  value={balDate} onChange={(e) => setBalDate(e.target.value)}
                />
              </Field>
              <button
                className={btnPrimary}
                disabled={!balValid}
                onClick={() => {
                  update((d) => ({ ...d, creditCards: d.creditCards.map((c) => c.id === card.id ? { ...c, balance: parseFloat(balVal), balanceAsOf: balDate } : c) }));
                  setEditingBalance(false);
                }}
              >
                Set
              </button>
              <button className={btnGhost} onClick={() => setEditingBalance(false)}>Cancel</button>
            </div>
          ) : (
            <button
              className="mt-1 flex items-baseline gap-2 text-left hover:opacity-80"
              onClick={() => { setBalVal(String(currentBalance)); setBalDate(card.balanceAsOf); setEditingBalance(true); }}
            >
              <Mono className="text-lg font-semibold text-red-400">{fmtMoney(currentBalance)}</Mono>
              <span className="text-xs text-stone-500">owed today · edit</span>
            </button>
          )}
        </div>
        <button className={btnGhost} onClick={onRemoveCard}>Remove card</button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[140px_160px_auto] sm:items-end">
        <Field label="Payment amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></Field>
        <Field label="Date"><input className={inputCls} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
        <button className={btnPrimary} disabled={!payValid} onClick={makePayment}>Pay from bank</button>
        <div className="sm:col-span-3"><NoteField value={payNote} onChange={(e) => setPayNote(e.target.value)} /></div>
      </div>

      <CardTransactionsList cardId={card.id} data={data} update={update} categories={categories} />
      <CardPaymentsList cardId={card.id} data={data} update={update} />
    </div>
  );
}

function CardTransactionsList({ cardId, data, update, categories }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState("");
  const valid = parseFloat(amount) > 0 && category.trim() && date;

  const [editingId, setEditingId] = useState(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const editValid = parseFloat(editAmount) > 0 && editCategory.trim() && editDate;

  const addItem = () => {
    update((d) => ({
      ...d,
      cardTransactions: [...d.cardTransactions, { id: uid(), cardId, description: desc.trim(), amount: parseFloat(amount), category: category.trim(), date, note: note.trim() }],
    }));
    setDesc(""); setAmount(""); setNote("");
  };

  const startEdit = (t) => {
    setEditingId(t.id); setEditDesc(t.description); setEditAmount(String(t.amount)); setEditCategory(t.category); setEditDate(t.date); setEditNote(t.note || "");
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (id) => {
    update((d) => ({
      ...d,
      cardTransactions: d.cardTransactions.map((x) => x.id === id
        ? { ...x, description: editDesc.trim(), amount: parseFloat(editAmount), category: editCategory.trim(), date: editDate, note: editNote.trim() }
        : x),
    }));
    setEditingId(null);
  };

  const listId = `card-cat-${cardId}`;
  const sorted = data.cardTransactions.filter((t) => t.cardId === cardId).sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">Purchases on this card</div>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="What was it? (optional)"><input className={inputCls} placeholder="Groceries at Wegmans…" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Category — type your own">
          <input className={inputCls} list={listId} placeholder="Groceries, Fun, Gas…" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Date"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="sm:col-span-2"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <button className={`${btnPrimary} mb-3 w-full sm:w-auto`} disabled={!valid} onClick={addItem}>Add purchase</button>
      {sorted.length === 0 ? (
        <Empty>No purchases logged on this card yet.</Empty>
      ) : (
        <ul className="max-h-72 divide-y divide-stone-800 overflow-y-auto pr-1">
          {sorted.map((t) => (
            <li key={t.id} className="py-2">
              {editingId === t.id ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="What was it? (optional)"><input className={inputCls} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} /></Field>
                  <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></Field>
                  <Field label="Category — type your own">
                    <input className={inputCls} list={listId} value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
                  </Field>
                  <Field label="Date"><input className={inputCls} type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></Field>
                  <div className="sm:col-span-2"><NoteField value={editNote} onChange={(e) => setEditNote(e.target.value)} /></div>
                  <div className="flex gap-2 sm:col-span-2">
                    <button className={btnPrimary} disabled={!editValid} onClick={() => saveEdit(t.id)}>Save</button>
                    <button className={btnGhost} onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.description || t.category}</div>
                    <div className="text-xs text-stone-400">
                      <span className="mr-1 inline-block rounded bg-emerald-900/40 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">{t.category}</span>
                      {niceDate(t.date)}
                    </div>
                    <NoteLine note={t.note} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Mono className="text-sm font-semibold text-red-400">{fmtMoney(-t.amount, true)}</Mono>
                    <button className={btnGhost} onClick={() => startEdit(t)}>Edit</button>
                    <button className={btnGhost} onClick={() => update((d) => ({ ...d, cardTransactions: d.cardTransactions.filter((x) => x.id !== t.id) }))}>Remove</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardPaymentsList({ cardId, data, update }) {
  const sorted = data.cardPayments.filter((p) => p.cardId === cardId).sort((a, b) => b.date.localeCompare(a.date));
  if (sorted.length === 0) return null;

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">Payments made</div>
      <ul className="divide-y divide-stone-800">
        {sorted.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="text-xs text-stone-400">{niceDate(p.date)}</div>
              <NoteLine note={p.note} />
            </div>
            <div className="flex items-center gap-3">
              <Mono className="text-sm font-semibold text-emerald-400">{fmtMoney(p.amount)}</Mono>
              <button className={btnGhost} onClick={() => update((d) => ({ ...d, cardPayments: d.cardPayments.filter((x) => x.id !== p.id) }))}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- balance calendar ---------------- */

function CalendarTab({ data, update, projection }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(null);

  if (!data.balanceAsOf) {
    return (
      <Card>
        <Empty>Set your starting balance below and the calendar will project your balance for every upcoming day.</Empty>
        <div className="mt-4 flex justify-center">
          <BalanceChip data={data} onSave={update} />
        </div>
      </Card>
    );
  }

  const first = new Date(ym.y, ym.m, 1);
  const startPad = first.getDay();
  const total = daysInMonth(ym.y, ym.m);
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);

  const nav = (dir) => {
    setSelected(null);
    setYm(({ y, m }) => {
      const nm = m + dir;
      return { y: y + (nm > 11 ? 1 : nm < 0 ? -1 : 0), m: (nm + 12) % 12 };
    });
  };

  const cellFor = (d) => {
    const key = `${ym.y}-${pad(ym.m + 1)}-${pad(d)}`;
    return { key, proj: projection.byDay[key] };
  };

  const toneFor = (bal) => bal < 0
    ? "bg-red-950/40 text-red-300 border-red-800"
    : bal < 250
    ? "bg-amber-950/40 text-amber-300 border-amber-800"
    : "bg-emerald-950/40 text-emerald-300 border-emerald-800";

  const sel = selected ? { key: selected, proj: projection.byDay[selected] } : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-4 flex justify-end">
          <BalanceChip data={data} onSave={update} />
        </div>
        <div className="mb-4 flex items-center justify-between">
          <button className={btnGhost} onClick={() => nav(-1)} aria-label="Previous month">← Prev</button>
          <h2 className="text-base font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{monthLabel(ym.y, ym.m)}</h2>
          <button className={btnGhost} onClick={() => nav(1)} aria-label="Next month">Next →</button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-stone-500">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={`pad-${i}`} />;
            const { key, proj } = cellFor(d);
            const isToday = key === todayKey();
            const isSel = key === selected;
            return (
              <button
                key={key}
                onClick={() => proj && setSelected(key)}
                className={`min-h-[58px] rounded-lg border p-1 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:min-h-[68px] ${
                  proj ? toneFor(proj.balance) + " hover:brightness-125" : "border-stone-800 bg-stone-800/40 text-stone-600"
                } ${isSel ? "ring-2 ring-emerald-500" : ""}`}
              >
                <div className={`text-[11px] font-semibold ${isToday ? "inline-block rounded bg-emerald-600 px-1 text-white" : ""}`}>{d}</div>
                {proj && (
                  <>
                    <Mono className="mt-0.5 block truncate text-[11px] font-semibold sm:text-xs">{fmtShort(proj.balance)}</Mono>
                    {proj.items.length > 0 && <div className="mt-0.5 h-1 w-1 rounded-full bg-current opacity-60" title="Money moves this day" />}
                  </>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-stone-400">
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-emerald-900 border border-emerald-700 inline-block" /> comfortable</span>
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-amber-900 border border-amber-700 inline-block" /> under $250</span>
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-red-900 border border-red-700 inline-block" /> negative</span>
          <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-stone-400 inline-block" /> money moves that day</span>
        </div>
      </Card>

      {sel?.proj && (
        <Card title={niceDate(sel.key)}>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-sm text-stone-400">Projected end-of-day balance</span>
            <Mono className={`text-2xl font-bold ${sel.proj.balance < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtMoney(sel.proj.balance)}</Mono>
          </div>
          {sel.proj.items.length > 0 ? (
            <>
              <ul className="divide-y divide-stone-800">
                {sel.proj.items.map((it, i) => (
                  <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{it.label}</span>
                    <Mono className={it.amt < 0 ? "text-red-400" : "text-emerald-400"}>{fmtMoney(it.amt, true)}</Mono>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between border-t border-stone-700 pt-3 text-sm font-semibold">
                <span>Net for the day</span>
                {(() => {
                  const net = sel.proj.items.reduce((s, it) => s + it.amt, 0);
                  return <Mono className={net < 0 ? "text-red-400" : "text-emerald-400"}>{fmtMoney(net, true)}</Mono>;
                })()}
              </div>
            </>
          ) : (
            <p className="text-sm text-stone-400">No scheduled money in or out on this day.</p>
          )}
        </Card>
      )}
    </div>
  );
}

/* ---------------- AI chat ---------------- */

function buildFinancialContext(data, projection) {
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const monthExpenses = data.expenses.filter((e) => e.date.startsWith(thisMonthPrefix));
  const catTotals = {};
  for (const e of monthExpenses) catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;

  let checkpoints = [], minPoint = null;
  if (projection?.start) {
    const start = fromKey(projection.start);
    for (let i = 0; i <= 120; i++) {
      const key = toKey(addDays(start, i));
      const p = projection.byDay[key];
      if (!p) break;
      if (i % 7 === 0) checkpoints.push({ date: key, balance: +p.balance.toFixed(2) });
      if (!minPoint || p.balance < minPoint.balance) minPoint = { date: key, balance: +p.balance.toFixed(2) };
    }
  }

  const creditCards = data.creditCards.map((c) => {
    const cardTx = data.cardTransactions.filter((t) => t.cardId === c.id);
    const cardPay = data.cardPayments.filter((p) => p.cardId === c.id);
    const proj = buildCardProjection(c, cardTx, cardPay);
    const currentBalance = proj.byDay[todayKey()] ?? c.balance;
    return { name: c.name, balanceOwed: +currentBalance.toFixed(2) };
  });

  const purchases = [
    ...data.expenses.map((e) => ({ ...e, paidWith: "bank account" })),
    ...data.cardTransactions.map((t) => ({
      ...t,
      paidWith: data.creditCards.find((c) => c.id === t.cardId)?.name || "credit card",
    })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);

  return {
    today: todayKey(),
    currentBalance: data.balanceAsOf ? { amount: data.balance, asOf: data.balanceAsOf } : null,
    recurringMonthlyBills: data.recurring.map((r) => ({ name: r.name, amount: r.amount, dayOfMonth: r.day, startsOn: r.startDate || "immediately", note: r.note || undefined })),
    incomeEntries: data.paychecks.map((p) => ({ source: p.source, amount: p.amount, startDate: p.date, repeats: p.repeat, note: p.note || undefined })),
    creditCards,
    recentAndPlannedPurchases: purchases,
    thisMonthSpendingByCategory: catTotals,
    projectedBalanceWeeklyCheckpoints: checkpoints,
    lowestProjectedBalanceNext120Days: minPoint,
  };
}

// Minimal markdown for chat replies: bold, italic, inline code, bullet/numbered
// lists, and paragraphs. Claude's answers commonly use this subset even though
// the prompt asks for plain prose, so raw "**"/"- " were leaking into the UI.
function renderInline(text) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*|_(.+?)_/g;
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) parts.push(<strong key={key++}>{match[1]}</strong>);
    else if (match[2] !== undefined) parts.push(<code key={key++} className="rounded bg-black/20 px-1 py-0.5 text-[0.85em]">{match[2]}</code>);
    else parts.push(<em key={key++}>{match[3] ?? match[4]}</em>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function MessageContent({ text }) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    if (/^\s*[-*]\s+/.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(
        <ul key={blocks.length} className="my-1 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0">
          {items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ul>
      );
    } else if (/^\s*\d+\.\s+/.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(
        <ol key={blocks.length} className="my-1 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0">
          {items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ol>
      );
    } else {
      const paraLines = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        paraLines.push(lines[i]); i++;
      }
      blocks.push(
        <p key={blocks.length} className="my-1 first:mt-0 last:mb-0">
          {paraLines.map((l, idx) => (
            <React.Fragment key={idx}>
              {idx > 0 && <br />}
              {renderInline(l)}
            </React.Fragment>
          ))}
        </p>
      );
    }
  }
  return <>{blocks}</>;
}

function ChatTab({ data, projection, messages, setMessages }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    setError(null);
    const nextMessages = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);

    const context = buildFinancialContext(data, projection);
    const apiMessages = [
      {
        role: "user",
        content:
          `You are the assistant inside a personal budgeting app. Answer using ONLY the financial data below. ` +
          `Today is ${context.today}. Be concise and concrete: cite specific numbers and dates from the data. ` +
          `When asked "can I afford X", check the projected balance checkpoints and the lowest projected balance — ` +
          `affording something means the balance stays comfortably above $0 after buying it, accounting for upcoming bills. ` +
          `If the data is insufficient (e.g. no balance set), say what's missing. Keep answers under 150 words unless asked for detail.\n\n` +
          `FINANCIAL DATA:\n${JSON.stringify(context, null, 2)}`,
      },
      ...nextMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });
      const result = await response.json();
      if (result?.error) throw new Error(result.error.message || "API error");
      const reply = (result.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!reply) throw new Error("Empty response");
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
    } catch (e) {
      console.error(e);
      setError(e.message && e.message !== "Failed to fetch" ? `Assistant error: ${e.message}` : "Couldn't reach the assistant. Check your connection and try again.");
      setMessages((m) => m.slice(0, -1));
      setInput(question);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [
    "Can I afford a $400 purchase this week?",
    "What's my biggest spending category this month?",
    "When is my balance at its lowest in the next 3 months?",
    "How much do my monthly bills add up to?",
  ];

  return (
    <Card className="flex h-[70vh] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-8 text-center">
            <h2 className="text-lg font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Ask about your money</h2>
            <p className="mt-1 text-sm text-stone-400">
              The assistant sees your balance, bills, income, purchases, and day-by-day projections — so it can answer things like:
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {suggestions.map((s) => (
                <button key={s} className="rounded-xl border border-stone-800 bg-stone-800/60 px-3 py-2 text-sm text-stone-300 hover:border-emerald-500 hover:text-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              m.role === "user" ? "whitespace-pre-wrap bg-emerald-600 text-white" : "border border-stone-800 bg-stone-800 text-stone-200"
            }`}>
              {m.role === "user" ? m.content : <MessageContent text={m.content} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-stone-800 bg-stone-800 px-4 py-2.5 text-sm text-stone-500">Checking your numbers…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2 border-t border-stone-800 pt-3">
        <input
          className={inputCls}
          placeholder='Try: "I want to buy a $250 jacket — do I have enough?"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          disabled={busy}
        />
        <button className={btnPrimary} onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </Card>
  );
}
