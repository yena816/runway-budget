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

// All dates (keys) a paycheck lands on within [from, to], expanding repeats.
// startDate/endDate (set when an amount edit splits a paycheck into a past
// segment and a fresh ongoing one) bound which occurrences count without
// disturbing the underlying day-of-week/day-of-month cadence.
function paycheckOccurrences(p, from, to) {
  const out = [];
  let d = fromKey(p.date);
  const startFrom = p.startDate ? fromKey(p.startDate) : null;
  const endBefore = p.endDate ? fromKey(p.endDate) : null;
  if (p.repeat === "none") {
    if (d >= from && d <= to) out.push(toKey(d));
    return out;
  }
  const step = p.repeat === "weekly" ? 7 : p.repeat === "biweekly" ? 14 : 0;
  const anchorDay = d.getDate();
  let guard = 0;
  while (d <= to && guard < 600) {
    const inBounds = (!startFrom || d >= startFrom) && (!endBefore || d < endBefore);
    if (inBounds && d >= from) out.push(toKey(d));
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

// Combines every repeating paycheck's occurrences (within [from, to]) into
// one chronological timeline and pairs consecutive paydays into "paycheck
// periods" — the span from one payday (inclusive) up to the day before the
// next. The last period in the window has no known end yet (end: null) —
// it's the currently-open period. One-time income isn't a period boundary,
// matching "Amount of paycheck left" 's paycheck-only scope.
function paycheckPeriods(data, from, to) {
  const amounts = new Map();
  const sources = new Map();
  for (const p of data.paychecks) {
    if (p.repeat === "none") continue;
    for (const key of paycheckOccurrences(p, from, to)) {
      const ov = findOverride(data.paycheckOverrides, p.id, key);
      const amt = ov ? ov.amount : p.amount;
      amounts.set(key, (amounts.get(key) || 0) + amt);
      if (!sources.has(key)) sources.set(key, new Set());
      sources.get(key).add(p.source || "Paycheck");
    }
  }
  const dates = [...amounts.keys()].sort();
  return dates.map((start, i) => ({
    start,
    end: dates[i + 1] || null,
    income: amounts.get(start),
    source: [...sources.get(start)].join(" + "),
  }));
}

// A short "Sep 26 – Oct 9" style label for a paycheck period; an open
// (still-ongoing) period reads as "Sep 26 – today".
function periodLabel(period) {
  const short = (key) => fromKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (!period.end) return `${short(period.start)} – today`;
  return `${short(period.start)} – ${short(toKey(addDays(fromKey(period.end), -1)))}`;
}

// Every recurring-bill occurrence landing within an arbitrary [from, to] day
// range (Date objects, inclusive) — used for paycheck-period spans that
// don't line up with calendar month boundaries. Handles both "monthly"
// (day-of-month) and "weekly"/"biweekly" (stepped from an anchor date) bills.
function recurringOccurrencesBetween(recurring, from, to) {
  const out = [];
  for (const bill of recurring) {
    const startFrom = bill.startDate ? fromKey(bill.startDate) : null;
    const endBefore = bill.endDate ? fromKey(bill.endDate) : null;
    const inBounds = (d) => (!startFrom || d >= startFrom) && (!endBefore || d < endBefore);
    const repeat = bill.repeat || "monthly";
    if (repeat === "monthly") {
      let y = from.getFullYear(), m = from.getMonth();
      const endY = to.getFullYear(), endM = to.getMonth();
      let guard = 0;
      while ((y < endY || (y === endY && m <= endM)) && guard < 36) {
        const occ = new Date(y, m, Math.min(bill.day, daysInMonth(y, m)));
        if (occ >= from && occ <= to && inBounds(occ)) out.push({ bill, date: toKey(occ) });
        m++; if (m > 11) { m = 0; y++; }
        guard++;
      }
    } else {
      const step = repeat === "weekly" ? 7 : 14;
      let d = fromKey(bill.date);
      if (d < from) {
        const diffDays = Math.round((from - d) / 86400000);
        d = addDays(d, Math.ceil(diffDays / step) * step);
      }
      let guard = 0;
      while (d <= to && guard < 60) {
        if (inBounds(d)) out.push({ bill, date: toKey(d) });
        d = addDays(d, step);
        guard++;
      }
    }
  }
  return out;
}

// A monthly bill's raw amount already is its monthly cost. A weekly or
// biweekly bill isn't — it lands roughly 4.35 or 2.17 times a month on
// average — so totals that add up "cost per month" (the Monthly bills stat,
// "Total per month" below) need this instead of the raw per-occurrence amount.
function monthlyEquivalent(bill) {
  const repeat = bill.repeat || "monthly";
  if (repeat === "monthly") return bill.amount;
  const step = repeat === "weekly" ? 7 : 14;
  return bill.amount * (30.4375 / step);
}

// Every one-time purchase, card purchase, and recurring-bill occurrence
// falling inside a paycheck period (or everywhere, if period is null for
// "all time" — recurring bills are skipped there, since there's no clean
// lifetime total for an ongoing bill). Each row carries both its raw amount
// and its reimbursement-netted amount.
//
// By default the still-open (current) period runs through its natural end
// (the next payday), same as viewing "this month" used to show any
// future-planned entries later in the month. Pass `capToday: true` to
// instead stop at today — for "how much have I actually spent so far,"
// where a not-yet-happened planned expense shouldn't count yet.
function periodTransactionRows(data, period, todayStr, { capToday = false } = {}) {
  const isOpenAndCurrent = !!period && period.start <= todayStr && (!period.end || period.end > todayStr);
  const capNow = isOpenAndCurrent && capToday;
  const inRange = (d) => {
    if (!period) return true;
    if (d < period.start) return false;
    if (capNow) return d <= todayStr;
    return period.end ? d < period.end : true;
  };
  const rows = [];
  for (const e of data.expenses) {
    if (inRange(e.date)) rows.push({ kind: "expense", id: e.id, date: e.date, category: e.category, label: e.description || e.category, amount: e.amount, net: netAmount(e, "expense", data.reimbursements) });
  }
  for (const t of data.cardTransactions) {
    if (inRange(t.date)) rows.push({ kind: "cardTransaction", id: t.id, date: t.date, category: t.category, label: t.description || t.category, amount: t.amount, net: netAmount(t, "cardTransaction", data.reimbursements) });
  }
  if (period) {
    const billFrom = fromKey(period.start);
    const billTo = capNow ? fromKey(todayStr) : (period.end ? addDays(fromKey(period.end), -1) : fromKey(todayStr));
    for (const { bill, date } of recurringOccurrencesBetween(data.recurring, billFrom, billTo)) {
      const cat = bill.category || "Uncategorized";
      rows.push({ kind: "recurring", id: bill.id, date, category: cat, label: bill.name, amount: bill.amount, net: netAmount(bill, "recurring", data.reimbursements) });
    }
  }
  return rows;
}

/* ---------------- projection engine ---------------- */

// Looks up a per-occurrence actual-amount override for a recurring bill or
// paycheck on a specific date, if the user has recorded that the real
// amount differed from the rule's usual amount.
function findOverride(overrides, sourceId, dateKey) {
  return overrides?.find((o) => o.sourceId === sourceId && o.date === dateKey) || null;
}

// Expands paychecks (with repeats), recurring bills, and future one-time
// expenses into a per-day delta map, then walks forward from the anchor
// balance to produce a projected balance for every day in the horizon.
// Also walks recurring bills backward from the anchor (pastDays) so the
// calendar can show — and let the user correct — bills that already went out.
function buildProjection(data, horizonDays = 210, pastDays = 400) {
  if (!data.balanceAsOf) return { byDay: {}, pastByDay: {}, start: null, end: null };
  const start = fromKey(data.balanceAsOf);
  const end = addDays(start, horizonDays);
  const rangeStart = addDays(start, -pastDays);
  const deltas = {};
  const add = (key, amt, label, extra) => {
    if (!deltas[key]) deltas[key] = { net: 0, items: [] };
    deltas[key].net += amt;
    deltas[key].items.push({ amt, label, ...extra });
  };
  // Same as `add`, but doesn't touch the day's running balance — for
  // transactions that don't move money out of the *bank* account (a credit
  // card purchase, Venmo activity) but should still show up on that day.
  const addInfo = (key, amt, label, extra) => {
    if (!deltas[key]) deltas[key] = { net: 0, items: [] };
    deltas[key].items.push({ amt, label, informational: true, ...extra });
  };
  const pastDeltas = {};
  const addPast = (key, amt, label, extra) => {
    if (!pastDeltas[key]) pastDeltas[key] = [];
    pastDeltas[key].push({ amt, label, ...extra });
  };
  const addPastInfo = (key, amt, label, extra) => {
    if (!pastDeltas[key]) pastDeltas[key] = [];
    pastDeltas[key].push({ amt, label, informational: true, ...extra });
  };

  // Recurring bills: "monthly" ones hit their day-of-month each month
  // (clamped to month length); "weekly"/"biweekly" ones step forward every
  // 7/14 days from an anchor date (bill.date), same pattern as paychecks.
  // Both skip any occurrence before an optional startDate or on/after an
  // optional endDate (used when an amount edit is split into a past segment
  // and a future one).
  for (const r of data.recurring) {
    const startFrom = r.startDate ? fromKey(r.startDate) : null;
    const endBefore = r.endDate ? fromKey(r.endDate) : null;
    const repeat = r.repeat || "monthly";
    const emit = (d) => {
      if (d < rangeStart || d > end) return;
      if ((startFrom && d < startFrom) || (endBefore && d >= endBefore)) return;
      const key = toKey(d);
      const ov = findOverride(data.recurringOverrides, r.id, key);
      const amt = ov ? ov.amount : r.amount;
      const extra = { sourceType: "recurring", sourceId: r.id, overridden: !!ov };
      if (d > start) add(key, -amt, r.name, extra);
      else if (d < start) addPast(key, -amt, r.name, extra);
    };
    if (repeat === "monthly") {
      let y = rangeStart.getFullYear(), m = rangeStart.getMonth();
      for (let i = 0; i < Math.ceil((horizonDays + pastDays) / 28) + 3; i++) {
        emit(new Date(y, m, Math.min(r.day, daysInMonth(y, m))));
        m++; if (m > 11) { m = 0; y++; }
      }
    } else {
      const step = repeat === "weekly" ? 7 : 14;
      let d = fromKey(r.date);
      if (d < rangeStart) {
        const diffDays = Math.round((rangeStart - d) / 86400000);
        d = addDays(d, Math.ceil(diffDays / step) * step);
      }
      let guard = 0;
      while (d <= end && guard < 200) {
        emit(d);
        d = addDays(d, step);
        guard++;
      }
    }
  }

  // Paychecks: one-time or repeating (weekly / biweekly / monthly). Repeating
  // ones support the same past-day actual-amount overrides as recurring bills
  // (e.g. a paycheck that came in higher or lower than usual), and the same
  // startDate/endDate split when the amount itself changes — the cadence
  // anchor (p.date) never changes, only which occurrences count.
  for (const p of data.paychecks) {
    let d = fromKey(p.date);
    const startFrom = p.startDate ? fromKey(p.startDate) : null;
    const endBefore = p.endDate ? fromKey(p.endDate) : null;
    if (p.repeat === "none") {
      if (d > start && d <= end) add(toKey(d), p.amount, p.source || "Paycheck");
    } else {
      const step = p.repeat === "weekly" ? 7 : p.repeat === "biweekly" ? 14 : 0;
      let guard = 0;
      while (d <= end && guard < 400) {
        const inBounds = (!startFrom || d >= startFrom) && (!endBefore || d < endBefore);
        if (inBounds && d >= rangeStart) {
          const key = toKey(d);
          const ov = findOverride(data.paycheckOverrides, p.id, key);
          const amt = ov ? ov.amount : p.amount;
          const extra = { sourceType: "paycheck", sourceId: p.id, overridden: !!ov };
          if (d > start) add(key, amt, p.source || "Paycheck", extra);
          else if (d < start) addPast(key, amt, p.source || "Paycheck", extra);
        }
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

  // One-time expenses
  for (const e of data.expenses) {
    const d = fromKey(e.date);
    const label = e.description || e.category;
    if (d > start && d <= end) add(e.date, -e.amount, label);
    else if (d < start) addPast(e.date, -e.amount, label);
  }

  // Credit card payments: money leaving the bank account to pay down a card
  for (const pay of data.cardPayments) {
    const d = fromKey(pay.date);
    const card = data.creditCards.find((c) => c.id === pay.cardId);
    const label = `Payment to ${card ? card.name : "credit card"}`;
    if (d > start && d <= end) add(pay.date, -pay.amount, label);
    else if (d < start) addPast(pay.date, -pay.amount, label);
  }

  // Credit card purchases: shown for visibility since they're real spending
  // that happened that day, but a purchase doesn't leave the bank account
  // yet — only a later payment does — so it doesn't affect the day's
  // balance, just the day's transaction list.
  for (const t of data.cardTransactions) {
    const d = fromKey(t.date);
    const card = data.creditCards.find((c) => c.id === t.cardId);
    const label = `${t.description || t.category} (${card ? card.name : "card"})`;
    if (d > start && d <= end) addInfo(t.date, -t.amount, label);
    else if (d < start) addPastInfo(t.date, -t.amount, label);
  }

  // Venmo transfers: money moving between the bank account and Venmo
  for (const t of data.venmoTransfers || []) {
    const d = fromKey(t.date);
    const amt = t.direction === "toBank" ? t.amount : -t.amount;
    const label = t.direction === "toBank" ? "Transfer from Venmo" : "Transfer to Venmo";
    if (d > start && d <= end) add(t.date, amt, label);
    else if (d < start) addPast(t.date, amt, label);
  }

  // Venmo activity: money moving through Venmo directly (not a transfer
  // to/from the bank) — informational only, same reasoning as card purchases.
  for (const v of data.venmoTransactions || []) {
    const d = fromKey(v.date);
    const amt = v.direction === "in" ? v.amount : -v.amount;
    const label = `${v.description || (v.direction === "in" ? "Money in" : "Money out")} (Venmo)`;
    if (d > start && d <= end) addInfo(v.date, amt, label);
    else if (d < start) addPastInfo(v.date, amt, label);
  }

  const byDay = {};
  let bal = data.balance;
  for (let i = 0; i <= horizonDays; i++) {
    const key = toKey(addDays(start, i));
    if (deltas[key]) bal += deltas[key].net;
    byDay[key] = { balance: bal, items: deltas[key]?.items || [] };
  }

  // Past days have no running balance (that's already baked into the anchor
  // balance) but still expose their recurring-bill items so the user can
  // correct one that actually went out for a different amount.
  const pastByDay = {};
  for (const [key, items] of Object.entries(pastDeltas)) pastByDay[key] = { items };

  return { byDay, pastByDay, start: toKey(start), end: toKey(end) };
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

// Projects the Venmo balance forward: unlike a credit card, money moves both
// ways — money in (from a venmoTransaction or a transfer from the bank)
// raises the balance, money out lowers it.
function buildVenmoProjection(venmo, venmoTransactions, venmoTransfers, horizonDays = 210) {
  if (!venmo?.balanceAsOf) return { byDay: {}, start: null, end: null };
  const start = fromKey(venmo.balanceAsOf);
  const end = addDays(start, horizonDays);
  const deltas = {};
  const add = (key, amt) => { deltas[key] = (deltas[key] || 0) + amt; };

  for (const t of venmoTransactions) {
    const d = fromKey(t.date);
    if (d >= start && d <= end) add(t.date, t.direction === "in" ? t.amount : -t.amount);
  }
  for (const t of venmoTransfers) {
    const d = fromKey(t.date);
    if (d >= start && d <= end) add(t.date, t.direction === "toVenmo" ? t.amount : -t.amount);
  }

  const byDay = {};
  let bal = venmo.balance;
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
  balance: 0, balanceAsOf: null, recurring: [], recurringOverrides: [], expenses: [], paychecks: [], paycheckOverrides: [],
  creditCards: [], cardTransactions: [], cardPayments: [],
  venmo: { balance: 0, balanceAsOf: null }, venmoTransactions: [], venmoTransfers: [],
  reimbursements: [],
  categoryGroups: {},
};

// Buckets a category can be sorted into on the Categories tab, and how the
// dashboard's Wants/Needs/Savings chart labels/colors each one.
const BUDGET_GROUPS = [
  { id: "needs", label: "Needs", color: "#38BDF8" },
  { id: "wants", label: "Wants", color: "#FB923C" },
  { id: "savings", label: "Savings", color: "#34D399" },
];
const BUDGET_GROUP_META = {
  needs: BUDGET_GROUPS[0], wants: BUDGET_GROUPS[1], savings: BUDGET_GROUPS[2],
  unassigned: { id: "unassigned", label: "Unsorted", color: "#78716c" },
};

// A reimbursement links an income-side entry (a one-time paycheck or Venmo
// "money in") to an expense/card purchase it's paying back — e.g. a friend's
// Venmo covering part of a shared Airbnb. The underlying entries never
// change; this only lets dashboard analytics show the *net* cost.
function reimbursedAmount(reimbursements, targetKind, targetId) {
  return (reimbursements || [])
    .filter((r) => r.targetKind === targetKind && r.targetId === targetId)
    .reduce((s, r) => s + r.amount, 0);
}
function netAmount(item, targetKind, reimbursements) {
  return Math.max(0, item.amount - reimbursedAmount(reimbursements, targetKind, item.id));
}

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
    { id: "categories", label: "Categories" },
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
        {tab === "dashboard" && <Dashboard data={data} update={update} projection={projection} goTo={setTab} />}
        {tab === "money" && <MoneyTab data={data} update={update} />}
        {tab === "categories" && <CategoriesTab data={data} update={update} />}
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

function Dashboard({ data, update, projection, goTo }) {
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  // Net of any linked reimbursements (a Venmo/Zelle payback for a shared
  // expense) — the raw entries are untouched, only these dashboard views
  // treat the pair as netting down to what it actually cost you.
  const monthExpenses = data.expenses.filter((e) => e.date.startsWith(thisMonthPrefix))
    .map((e) => ({ ...e, net: netAmount(e, "expense", data.reimbursements) }));
  const monthCardTx = data.cardTransactions.filter((t) => t.date.startsWith(thisMonthPrefix))
    .map((t) => ({ ...t, net: netAmount(t, "cardTransaction", data.reimbursements) }));
  const monthSpend = monthExpenses.reduce((s, e) => s + e.net, 0) + monthCardTx.reduce((s, t) => s + t.net, 0);
  const monthPurchaseCount = monthExpenses.length + monthCardTx.length;
  const activeRecurring = data.recurring.filter((r) => !r.endDate || r.endDate > todayKey());
  const recurringTotal = activeRecurring.reduce((s, r) => s + monthlyEquivalent(r), 0);

  const todayStr = todayKey();

  // All paycheck periods (payday-to-payday spans, combining every repeating
  // paycheck into one timeline) within a wide window — shared by the
  // category chart, its drill-down, the "last 6 paychecks" chart, and
  // "Amount of paycheck left" so none of them can disagree with each other.
  const periods = paycheckPeriods(data, addDays(now, -400), addDays(now, 120));
  const currentPeriod = periods.length === 0 ? null : ([...periods].reverse().find((p) => p.start <= todayStr) || periods[0]);

  // Category totals — spending for whichever paycheck period is selected
  // here (independent of the "this month" stat tiles above), filterable by
  // payment source.
  const hasCards = data.creditCards.length > 0;
  const [spendSource, setSpendSource] = useState("both"); // 'bank' | 'card' | 'both'
  const [periodSel, setPeriodSel] = useState(currentPeriod); // null = all time; a period object = one paycheck period
  const selectedPeriod = periodSel;
  const navPeriod = (dir) => {
    setPeriodSel((sel) => {
      const base = sel || currentPeriod;
      if (!base) return sel;
      const idx = periods.findIndex((p) => p.start === base.start);
      const target = periods[idx + dir];
      return target || base;
    });
  };
  const toggleAllTimePeriod = () => setPeriodSel((sel) => (sel === null ? currentPeriod : null));

  const periodRows = periodTransactionRows(data, selectedPeriod, todayStr);
  const filteredRows = periodRows.filter((r) => (
    spendSource === "bank" ? r.kind !== "cardTransaction" : spendSource === "card" ? r.kind === "cardTransaction" : true
  ));
  const catTotals = {};
  for (const r of filteredRows) catTotals[r.category] = (catTotals[r.category] || 0) + r.net;
  const pieData = Object.entries(catTotals).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  // Clicking a category slice/legend drills into the actual transactions
  // behind it — same source mix (Account/Card/Both) as the total itself, so
  // the list always adds up to the slice you clicked.
  const [selectedCategory, setSelectedCategory] = useState(null);
  const categoryRows = selectedCategory
    ? filteredRows.filter((r) => r.category === selectedCategory).sort((a, b) => b.date.localeCompare(a.date))
    : [];

  // Same category totals, regrouped into Needs/Wants/Savings via whatever
  // mapping was set up on the Categories tab. Anything not yet sorted lands
  // under "Unsorted" rather than being silently dropped.
  const groupTotals = {};
  for (const [cat, amt] of Object.entries(catTotals)) {
    const g = data.categoryGroups?.[cat] || "unassigned";
    groupTotals[g] = (groupTotals[g] || 0) + amt;
  }
  const groupPieData = Object.entries(groupTotals)
    .filter(([, value]) => value > 0)
    .map(([id, value]) => ({ id, name: BUDGET_GROUP_META[id].label, value }))
    .sort((a, b) => b.value - a.value);
  const groupTotalSum = groupPieData.reduce((s, g) => s + g.value, 0);

  const categoryPeriodLabel = selectedPeriod ? `in ${periodLabel(selectedPeriod)}` : "yet";
  const categoryEmptyMsg = {
    bank: `No bank account spending logged ${categoryPeriodLabel}. Add purchases or bills under Money in & out.`,
    card: `No credit card purchases logged ${categoryPeriodLabel}. Add them under Money in & out → Credit cards.`,
    both: `No spending logged ${categoryPeriodLabel}. Add purchases or bills under Money in & out.`,
  }[hasCards ? spendSource : "bank"];

  // Last 6 paycheck periods (the current one and the 5 before it — not
  // future ones the lookahead window also generated): spending (one-time
  // purchases + card purchases + recurring bills, net of reimbursements) vs
  // the paycheck that started each period.
  const recentPeriods = periods.filter((p) => p.start <= todayStr).slice(-6).map((period) => {
    const rows = periodTransactionRows(data, period, todayStr);
    const spend = rows.reduce((s, r) => s + r.net, 0);
    return {
      label: fromKey(period.start).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      Spending: +spend.toFixed(2),
      Income: +period.income.toFixed(2),
    };
  });
  const hasHistory = recentPeriods.some((m) => m.Spending > 0 || m.Income > 0);

  // Amount left from the most recently received paycheck — reuses the same
  // currentPeriod as the chart above, so the two figures can never disagree.
  // Capped at today: a planned-but-not-yet-happened expense later in the
  // pay period shouldn't already count against what's left right now.
  const lastPaycheck = currentPeriod;
  const spendSinceLastPaycheck = lastPaycheck
    ? periodTransactionRows(data, lastPaycheck, todayStr, { capToday: true }).reduce((s, r) => s + r.net, 0)
    : 0;
  const paycheckLeft = lastPaycheck ? lastPaycheck.income - spendSinceLastPaycheck : 0;

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
        <Stat label="Monthly bills" value={fmtMoney(recurringTotal)} sub={`${activeRecurring.length} recurring`} />
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
          title="Spending by category"
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
          <div className="mb-3 flex items-center justify-center gap-2">
            <button className={btnGhost} onClick={() => navPeriod(-1)} disabled={!selectedPeriod} aria-label="Previous paycheck period">←</button>
            <span className="min-w-[170px] text-center text-sm font-medium text-stone-300">
              {selectedPeriod ? periodLabel(selectedPeriod) : "All time"}
            </span>
            <button className={btnGhost} onClick={() => navPeriod(1)} disabled={!selectedPeriod} aria-label="Next paycheck period">→</button>
            <button className={btnGhost} onClick={toggleAllTimePeriod}>
              {selectedPeriod ? "All time" : "By paycheck"}
            </button>
          </div>
          {pieData.length === 0 ? (
            <Empty>{categoryEmptyMsg}</Empty>
          ) : (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                      cursor="pointer"
                      onClick={(d) => setSelectedCategory((prev) => (prev === d.name ? null : d.name))}
                    >
                      {pieData.map((entry, i) => (
                        <Cell
                          key={i}
                          fill={CHART_COLORS[i % CHART_COLORS.length]}
                          opacity={selectedCategory && selectedCategory !== entry.name ? 0.35 : 1}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }} itemStyle={{ color: "#e7e5e4" }} />
                    <Legend
                      wrapperStyle={{ fontSize: 12, color: "#d6d3d1", cursor: "pointer" }}
                      onClick={(entry) => setSelectedCategory((prev) => (prev === entry.value ? null : entry.value))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-center text-xs text-stone-500">Click a slice or legend item to see its transactions.</p>

              {selectedCategory && (
                <div className="mt-3 border-t border-stone-800 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-stone-200">{selectedCategory}</h4>
                    <button className={btnGhost} onClick={() => setSelectedCategory(null)}>Close</button>
                  </div>
                  {categoryRows.length === 0 ? (
                    <p className="text-sm text-stone-400">No transactions in this category for the selected period.</p>
                  ) : (
                    <ul className="max-h-96 divide-y divide-stone-800 overflow-y-auto pr-1">
                      {categoryRows.map((row) => (
                        <li key={`${row.kind}-${row.id}`} className="py-2">
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{row.label}</div>
                              <div className="text-xs text-stone-400">
                                {row.date ? niceDate(row.date) : "Recurring bill"}
                                {row.kind === "cardTransaction" && <span className="ml-1 text-stone-500">· card</span>}
                              </div>
                            </div>
                            <Mono className="shrink-0 text-sm font-semibold text-red-400">{fmtMoney(-row.amount, true)}</Mono>
                          </div>
                          <ReimbursementManager targetKind={row.kind} targetId={row.id} amount={row.amount} data={data} update={update} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Income vs spending · last 6 paychecks">
          {!hasHistory ? (
            <Empty>Once you log a repeating paycheck and some purchases, per-paycheck totals show up here.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={recentPeriods} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#a8a29e" }} />
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

      <Card title="Spending by budget type" action={<span className="text-xs text-stone-500">{selectedPeriod ? periodLabel(selectedPeriod) : "All time"}</span>}>
        {groupPieData.length === 0 ? (
          <Empty>{categoryEmptyMsg}</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="h-56 sm:w-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={groupPieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {groupPieData.map((g) => <Cell key={g.id} fill={BUDGET_GROUP_META[g.id].color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }} itemStyle={{ color: "#e7e5e4" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="space-y-2">
              {groupPieData.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <i className="h-2.5 w-2.5 rounded-full" style={{ background: BUDGET_GROUP_META[g.id].color }} />
                    {g.name}
                    {g.id === "unassigned" && <span className="text-xs text-stone-500">(sort these under Categories)</span>}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <Mono className="font-semibold text-stone-200">{fmtMoney(g.value)}</Mono>
                    <span className="text-xs text-stone-500">{groupTotalSum > 0 ? Math.round((g.value / groupTotalSum) * 100) : 0}%</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Amount of paycheck left">
        {!lastPaycheck ? (
          <p className="text-sm text-stone-400">Add a repeating paycheck under Money in &amp; out to see this.</p>
        ) : (
          <>
            <Mono className={`text-3xl font-bold ${paycheckLeft < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtMoney(paycheckLeft, true)}</Mono>
            <p className="mt-1 text-xs text-stone-400">
              {fmtMoney(lastPaycheck.income)} received {niceDate(lastPaycheck.start)} ({lastPaycheck.source}) − {fmtMoney(spendSinceLastPaycheck)} spent since (purchases, card, and bills).
            </p>
          </>
        )}
      </Card>
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

/* ---------------- categories ---------------- */

function allCategoriesUsed(data) {
  return [...new Set([...data.expenses, ...data.cardTransactions, ...data.recurring].map((e) => e.category).filter(Boolean))].sort();
}

function CategoriesTab({ data, update }) {
  const categories = useMemo(() => allCategoriesUsed(data), [data.expenses, data.cardTransactions, data.recurring]);
  const groups = data.categoryGroups || {};

  const usageCount = useMemo(() => {
    const counts = {};
    const bump = (cat) => { if (cat) counts[cat] = (counts[cat] || 0) + 1; };
    data.expenses.forEach((e) => bump(e.category));
    data.cardTransactions.forEach((t) => bump(t.category));
    data.recurring.forEach((r) => bump(r.category));
    return counts;
  }, [data.expenses, data.cardTransactions, data.recurring]);

  const setGroup = (cat, groupId) => {
    update((d) => {
      const next = { ...(d.categoryGroups || {}) };
      if (groupId) next[cat] = groupId; else delete next[cat];
      return { ...d, categoryGroups: next };
    });
  };

  return (
    <Card
      title="Categories"
      action={<span className="text-xs text-stone-500">{categories.filter((c) => groups[c]).length}/{categories.length} sorted</span>}
    >
      <p className="mb-4 text-sm text-stone-400">
        Sort each category you've used into Needs, Wants, or Savings — click a selected one again to unsort it. This feeds the "Spending by budget type" chart on the dashboard.
      </p>
      {categories.length === 0 ? (
        <Empty>No categories yet. Add a category to a purchase, card transaction, or recurring bill under Money in & out, then come back here to sort it.</Empty>
      ) : (
        <ul className="divide-y divide-stone-800">
          {categories.map((cat) => (
            <li key={cat} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{cat}</div>
                <div className="text-xs text-stone-500">used in {usageCount[cat] || 0} {usageCount[cat] === 1 ? "entry" : "entries"}</div>
              </div>
              <div className="flex gap-1 rounded-lg border border-stone-800 bg-stone-800/60 p-0.5">
                {BUDGET_GROUPS.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setGroup(cat, groups[cat] === g.id ? null : g.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      groups[cat] === g.id ? "bg-stone-700 shadow-sm" : "text-stone-500 hover:text-stone-200"
                    }`}
                    style={groups[cat] === g.id ? { color: g.color } : undefined}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- money in & out ---------------- */

// `viewMonth` is `{ y, m }` to show one calendar month, or `null` for "all
// time". Repeating rules (recurring bills, repeating paychecks) ignore it —
// they're ongoing, not tied to a single month — only dated one-off entries
// (expenses, card purchases/payments, Venmo activity, one-time income) do.
function inViewMonth(dateStr, viewMonth) {
  if (!viewMonth) return true;
  return dateStr.startsWith(`${viewMonth.y}-${pad(viewMonth.m + 1)}`);
}
function shiftViewMonth(vm, dir) {
  if (!vm) return vm;
  const nm = vm.m + dir;
  return { y: vm.y + (nm > 11 ? 1 : nm < 0 ? -1 : 0), m: (nm + 12) % 12 };
}

function MoneyMonthNav({ viewMonth, setViewMonth }) {
  const now = new Date();
  const nav = (dir) => setViewMonth((vm) => shiftViewMonth(vm, dir));

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className={btnGhost} onClick={() => nav(-1)} disabled={!viewMonth} aria-label="Previous month">← Prev</button>
          <h2 className="min-w-[150px] text-center text-sm font-semibold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {viewMonth ? monthLabel(viewMonth.y, viewMonth.m) : "All time"}
          </h2>
          <button className={btnGhost} onClick={() => nav(1)} disabled={!viewMonth} aria-label="Next month">Next →</button>
        </div>
        <button
          className={btnGhost}
          onClick={() => setViewMonth(viewMonth ? null : { y: now.getFullYear(), m: now.getMonth() })}
        >
          {viewMonth ? "View all transactions" : "Back to monthly view"}
        </button>
      </div>
    </Card>
  );
}

function MoneyTab({ data, update }) {
  const now = new Date();
  const [viewMonth, setViewMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const categories = useMemo(
    () => [...new Set([...data.expenses, ...data.cardTransactions, ...data.recurring].map((e) => e.category).filter(Boolean))].sort(),
    [data.expenses, data.cardTransactions, data.recurring]
  );

  return (
    <div className="space-y-5">
      <StatementImportPanel data={data} update={update} />
      <MoneyMonthNav viewMonth={viewMonth} setViewMonth={setViewMonth} />
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-5">
          <RecurringSection data={data} update={update} categories={categories} />
          <PaycheckSection data={data} update={update} viewMonth={viewMonth} />
        </div>
        <ExpenseSection data={data} update={update} categories={categories} viewMonth={viewMonth} />
      </div>
      <CreditCardsSection data={data} update={update} categories={categories} viewMonth={viewMonth} />
      <VenmoSection data={data} update={update} viewMonth={viewMonth} />
    </div>
  );
}

/* ---------------- statement import ---------------- */

const CARD_TYPE_OPTIONS = [
  { value: "purchase", label: "Purchase" },
  { value: "payment", label: "Payment received" },
  { value: "refund", label: "Refund / credit" },
];
const IMPORT_TYPE_OPTIONS = {
  bank: [
    { value: "expense", label: "Expense" },
    { value: "income", label: "Income" },
    { value: "transferToVenmo", label: "Transfer to Venmo" },
  ],
  venmo: [
    { value: "in", label: "Money in" },
    { value: "out", label: "Money out" },
    { value: "transferFromBank", label: "Transfer from bank" },
    { value: "transferToBank", label: "Transfer to bank" },
  ],
};

function typeOptionsFor(account) {
  if (account.startsWith("card:")) return CARD_TYPE_OPTIONS;
  return IMPORT_TYPE_OPTIONS[account] || [];
}

function defaultTypeFor(account, direction) {
  if (account === "bank") return direction === "credit" ? "income" : "expense";
  if (account.startsWith("card:")) return direction === "credit" ? "payment" : "purchase";
  if (account === "venmo") return direction === "credit" ? "in" : "out";
  return null;
}

function normalizeDateStr(s) {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? todayKey() : toKey(d);
}

// Picks a sensible default account for a parsed statement based on the AI's
// guess, matching against existing credit cards by name where possible.
function guessDefaultAccount(stmt, data) {
  if (stmt.accountGuess === "bank") return "bank";
  if (stmt.accountGuess === "venmo") return "venmo";
  if (stmt.accountGuess === "credit_card") {
    const guess = (stmt.accountNameGuess || "").toLowerCase();
    const match = guess && data.creditCards.find((c) => guess.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(guess));
    if (match) return `card:${match.id}`;
    if (data.creditCards.length === 1) return `card:${data.creditCards[0].id}`;
  }
  return "skip";
}

// Flags a parsed row as a likely duplicate if it matches (same date within a
// day, same amount) another row earlier in this same upload batch, or an
// entry already saved under its default target account — this is how the
// app avoids double-counting a payment that shows up on two statements.
function findDuplicateNote(row, allRows, data) {
  const closeDate = (dateStr) => Math.abs(fromKey(dateStr) - fromKey(row.date)) <= 86400000;
  const closeAmt = (amt) => Math.abs(amt - row.amount) < 0.01;

  const earlier = allRows.find((o) => o !== row && o.batchIndex < row.batchIndex && closeDate(o.date) && closeAmt(o.amount));
  if (earlier) return `matches "${earlier.description || earlier.fileName}" (${niceDate(earlier.date)}) elsewhere in this upload`;

  if (row.account === "bank") {
    const exp = data.expenses.find((e) => closeDate(e.date) && closeAmt(e.amount));
    if (exp) return `matches an expense you already logged: "${exp.description || exp.category}" (${niceDate(exp.date)})`;
    const pc = data.paychecks.find((p) => closeDate(p.date) && closeAmt(p.amount));
    if (pc) return `matches income you already logged: "${pc.source}" (${niceDate(pc.date)})`;
  } else if (row.account.startsWith("card:")) {
    const cardId = row.account.slice(5);
    const tx = data.cardTransactions.find((t) => t.cardId === cardId && closeDate(t.date) && closeAmt(t.amount));
    if (tx) return `matches a purchase you already logged: "${tx.description || tx.category}" (${niceDate(tx.date)})`;
    const pay = data.cardPayments.find((p) => p.cardId === cardId && closeDate(p.date) && closeAmt(p.amount));
    if (pay) return `matches a payment you already logged (${niceDate(pay.date)})`;
  } else if (row.account === "venmo") {
    const tx = (data.venmoTransactions || []).find((t) => closeDate(t.date) && closeAmt(t.amount));
    if (tx) return `matches Venmo activity you already logged: "${tx.description || "money " + tx.direction}" (${niceDate(tx.date)})`;
    const tr = (data.venmoTransfers || []).find((t) => closeDate(t.date) && closeAmt(t.amount));
    if (tr) return `matches a transfer you already logged (${niceDate(tr.date)})`;
  }
  return null;
}

function buildImportRows(parsed, data) {
  const rows = [];
  let batchIndex = 0;
  for (const stmt of parsed.statements || []) {
    const account = guessDefaultAccount(stmt, data);
    for (const t of stmt.transactions || []) {
      const direction = t.direction === "credit" ? "credit" : "debit";
      rows.push({
        id: uid(),
        batchIndex: batchIndex++,
        fileName: stmt.fileName,
        date: normalizeDateStr(t.date),
        description: t.description || "",
        amount: Math.abs(Number(t.amount) || 0),
        direction,
        account,
        type: defaultTypeFor(account, direction),
        include: account !== "skip",
        duplicateOf: null,
      });
    }
  }
  for (const row of rows) {
    const dup = findDuplicateNote(row, rows, data);
    if (dup) { row.duplicateOf = dup; row.include = false; }
  }
  return rows;
}

function StatementImportPanel({ data, update }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState(null);

  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    reader.onerror = () => reject(reader.error || new Error(`Couldn't read ${file.name}`));
    if (isPdf) {
      reader.onload = () => resolve({ name: file.name, kind: "pdf", content: String(reader.result).split(",")[1] || "" });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ name: file.name, kind: "csv", content: String(reader.result) });
      reader.readAsText(file);
    }
  });

  const onFilesSelected = async (e) => {
    const fileList = Array.from(e.target.files || []);
    e.target.value = "";
    if (fileList.length === 0) return;
    const tooBig = fileList.find((f) => f.size > 15 * 1024 * 1024);
    if (tooBig) { setError(`"${tooBig.name}" is over 15MB — split it or upload it separately.`); return; }

    setError(""); setUploading(true); setRows(null);
    try {
      const files = await Promise.all(fileList.map(readFile));
      const response = await fetch("/api/parse-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      const result = await response.json();
      if (result?.error) throw new Error(result.error.message || "Couldn't parse those statements.");
      setRows(buildImportRows(result, data));
    } catch (err) {
      setError(err.message || "Something went wrong reading those files.");
    } finally {
      setUploading(false);
    }
  };

  const commit = (finalRows) => {
    const included = finalRows.filter((r) => r.include && r.account !== "skip");
    update((d) => {
      const next = {
        ...d,
        expenses: [...d.expenses], paychecks: [...d.paychecks],
        cardTransactions: [...d.cardTransactions], cardPayments: [...d.cardPayments],
        venmoTransactions: [...(d.venmoTransactions || [])], venmoTransfers: [...(d.venmoTransfers || [])],
      };
      for (const r of included) {
        if (r.account === "bank") {
          if (r.type === "expense") next.expenses.push({ id: uid(), description: r.description, amount: r.amount, category: "Imported", date: r.date, note: "" });
          else if (r.type === "income") next.paychecks.push({ id: uid(), source: r.description || "Imported income", amount: r.amount, date: r.date, repeat: "none" });
          else if (r.type === "transferToVenmo") next.venmoTransfers.push({ id: uid(), amount: r.amount, date: r.date, direction: "toVenmo", note: r.description });
        } else if (r.account.startsWith("card:")) {
          const cardId = r.account.slice(5);
          if (r.type === "purchase") next.cardTransactions.push({ id: uid(), cardId, description: r.description, amount: r.amount, category: "Imported", date: r.date, note: "" });
          else if (r.type === "payment") next.cardPayments.push({ id: uid(), cardId, amount: r.amount, date: r.date, note: r.description });
          else if (r.type === "refund") next.cardTransactions.push({ id: uid(), cardId, description: r.description, amount: -r.amount, category: "Imported", date: r.date, note: "" });
        } else if (r.account === "venmo") {
          if (r.type === "in" || r.type === "out") next.venmoTransactions.push({ id: uid(), description: r.description, amount: r.amount, direction: r.type, date: r.date, note: "" });
          else if (r.type === "transferFromBank") next.venmoTransfers.push({ id: uid(), amount: r.amount, date: r.date, direction: "toVenmo", note: r.description });
          else if (r.type === "transferToBank") next.venmoTransfers.push({ id: uid(), amount: r.amount, date: r.date, direction: "toBank", note: r.description });
        }
      }
      return next;
    });
    setRows(null);
  };

  return (
    <Card title="Import statements">
      <p className="mb-3 text-sm text-stone-400">
        Upload bank, credit card, or Venmo statements — CSV and PDF, any mix, multiple at once — and Claude will read out the transactions for you to review before anything is saved.
      </p>
      <input ref={fileInputRef} type="file" accept=".csv,.pdf" multiple className="hidden" onChange={onFilesSelected} />
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnPrimary} disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "Reading statements…" : "Upload statements"}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
      {rows && <ImportReviewQueue rows={rows} setRows={setRows} data={data} onCommit={commit} onCancel={() => setRows(null)} />}
    </Card>
  );
}

function ImportReviewQueue({ rows, setRows, data, onCommit, onCancel }) {
  const accountOptions = [
    { value: "bank", label: "Bank account" },
    ...data.creditCards.map((c) => ({ value: `card:${c.id}`, label: c.name })),
    { value: "venmo", label: "Venmo" },
    { value: "skip", label: "Skip" },
  ];

  const updateRow = (id, patch) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      if (patch.account && patch.account !== r.account) next.type = defaultTypeFor(patch.account, r.direction);
      return next;
    }));
  };

  const includedCount = rows.filter((r) => r.include && r.account !== "skip").length;
  const files = [...new Set(rows.map((r) => r.fileName))];

  return (
    <div className="mt-4 border-t border-stone-800 pt-4">
      {files.map((fileName) => (
        <div key={fileName} className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">{fileName}</div>
          <ul className="divide-y divide-stone-800">
            {rows.filter((r) => r.fileName === fileName).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <input type="checkbox" checked={r.include} onChange={(e) => updateRow(r.id, { include: e.target.checked })} className="h-4 w-4 shrink-0 accent-emerald-600" />
                <div className="min-w-[160px] flex-1">
                  <div className="truncate">{r.description || "(no description)"}</div>
                  <div className="text-xs text-stone-500">{niceDate(r.date)}</div>
                  {r.duplicateOf && <div className="mt-0.5 text-xs text-amber-400">⚠ possible duplicate — {r.duplicateOf}</div>}
                </div>
                <Mono className={r.direction === "credit" ? "text-emerald-400" : "text-red-400"}>{fmtMoney(r.direction === "credit" ? r.amount : -r.amount, true)}</Mono>
                <select className={inputCls + " w-36"} value={r.account} onChange={(e) => updateRow(r.id, { account: e.target.value })}>
                  {accountOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {r.account !== "skip" && (
                  <select className={inputCls + " w-40"} value={r.type} onChange={(e) => updateRow(r.id, { type: e.target.value })}>
                    {typeOptionsFor(r.account).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button className={btnPrimary} disabled={includedCount === 0} onClick={() => onCommit(rows)}>
          Import {includedCount} transaction{includedCount === 1 ? "" : "s"}
        </button>
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// A recurring bill's "when" caption: day-of-month for monthly, or the
// cadence + anchor date for weekly/biweekly ones.
function recurringScheduleLabel(r) {
  const repeat = r.repeat || "monthly";
  if (repeat === "monthly") return `day ${r.day} of each month`;
  return `${repeat === "weekly" ? "every week" : "every 2 weeks"} from ${niceDate(r.date)}`;
}

function RecurringSection({ data, update, categories }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [repeat, setRepeat] = useState("monthly");
  const [day, setDay] = useState("1");
  const [date, setDate] = useState(todayKey());
  const [startDate, setStartDate] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const valid = name.trim() && parseFloat(amount) > 0 && (repeat === "monthly" ? (+day >= 1 && +day <= 31) : !!date);

  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editRepeat, setEditRepeat] = useState("monthly");
  const [editDay, setEditDay] = useState("1");
  const [editDate, setEditDate] = useState(todayKey());
  const [editStartDate, setEditStartDate] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editNote, setEditNote] = useState("");
  const editValid = editName.trim() && parseFloat(editAmount) > 0 && (editRepeat === "monthly" ? (+editDay >= 1 && +editDay <= 31) : !!editDate);

  // Bills whose amount was edited get split into a past segment (endDate set)
  // and a fresh ongoing one — only the ongoing one is shown for management.
  const activeRecurring = data.recurring.filter((r) => !r.endDate || r.endDate > todayKey());

  const addItem = () => {
    update((d) => ({
      ...d,
      recurring: [...d.recurring, {
        id: uid(), name: name.trim(), amount: parseFloat(amount), repeat,
        day: repeat === "monthly" ? +day : null,
        date: repeat === "monthly" ? null : date,
        startDate: repeat === "monthly" ? (startDate || null) : null,
        category: category.trim(), note: note.trim(),
      }],
    }));
    setName(""); setAmount(""); setStartDate(""); setCategory(""); setNote("");
  };

  const startEdit = (r) => {
    const rep = r.repeat || "monthly";
    setEditingId(r.id); setEditName(r.name); setEditAmount(String(r.amount)); setEditRepeat(rep);
    setEditDay(String(r.day || 1)); setEditDate(r.date || todayKey()); setEditStartDate(r.startDate || "");
    setEditCategory(r.category || ""); setEditNote(r.note || "");
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (id) => {
    update((d) => {
      const original = d.recurring.find((x) => x.id === id);
      const newAmount = parseFloat(editAmount);
      const edited = {
        name: editName.trim(), amount: newAmount, repeat: editRepeat,
        day: editRepeat === "monthly" ? +editDay : null,
        date: editRepeat === "monthly" ? null : editDate,
        startDate: editRepeat === "monthly" ? (editStartDate || null) : null,
        category: editCategory.trim(), note: editNote.trim(),
      };

      // Changing the amount only affects payments from today onward — past
      // occurrences already happened at the old amount. So instead of
      // mutating the rule in place, cap the old rule at today and start a
      // fresh one (with the new amount) from today, unless the bill hasn't
      // started yet, in which case there's no history to preserve.
      const origRepeat = original ? (original.repeat || "monthly") : "monthly";
      const anchorPassed = !original || origRepeat === "monthly" || original.date <= todayKey();
      const hasHistory = original && anchorPassed && (!original.startDate || original.startDate <= todayKey());
      if (original && newAmount !== original.amount && hasHistory) {
        return {
          ...d,
          recurring: [
            ...d.recurring.map((x) => x.id === id ? { ...x, endDate: todayKey() } : x),
            // The new segment always gets startDate: todayKey() here, regardless
            // of what `edited.startDate` holds — for a non-monthly bill that's
            // null (reserved for this split mechanism), and it must be set to
            // today or the new segment would also regenerate the same past
            // occurrences the old (now-capped) segment already covers.
            { id: uid(), ...edited, startDate: todayKey(), endDate: null },
          ],
        };
      }

      return { ...d, recurring: d.recurring.map((x) => x.id === id ? { ...x, ...edited } : x) };
    });
    setEditingId(null);
  };

  // Cancelling a bill (e.g. ending a membership) should stop future payments
  // without erasing the ones that already happened — so this caps it at
  // today rather than deleting the record, unless it never actually started.
  const cancelItem = (r) => {
    const repeat = r.repeat || "monthly";
    const anchorPassed = repeat === "monthly" || r.date <= todayKey();
    const hasHistory = anchorPassed && (!r.startDate || r.startDate <= todayKey());
    update((d) => ({
      ...d,
      recurring: hasHistory
        ? d.recurring.map((x) => x.id === r.id ? { ...x, endDate: todayKey() } : x)
        : d.recurring.filter((x) => x.id !== r.id),
    }));
  };

  return (
    <Card title="Recurring bills">
      <div className="mb-4 space-y-2">
        <Field label="Bill"><input className={inputCls} placeholder="Rent, Netflix, car insurance…" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[100px_120px_120px_130px_auto] sm:items-end">
          <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Repeats">
            <select className={inputCls} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="weekly">Every week</option>
            </select>
          </Field>
          {repeat === "monthly" ? (
            <Field label="Day"><input className={inputCls} type="number" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          ) : (
            <Field label="Next due date"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          )}
          <Field label="Category (optional)">
            <input className={inputCls} list="recurring-cat-options" placeholder="Housing, Subscriptions…" value={category} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="recurring-cat-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <button className={btnPrimary} disabled={!valid} onClick={addItem}>Add bill</button>
          {repeat === "monthly" && (
            <div className="sm:col-span-2">
              <Field label="Starts on (optional)">
                <input className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
            </div>
          )}
        </div>
        <NoteField value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {activeRecurring.length === 0 ? (
        <Empty>No recurring bills yet. Rent, subscriptions, insurance — anything that goes out every month or every 2 weeks.</Empty>
      ) : (
        <ul className="divide-y divide-stone-800">
          {[...activeRecurring]
            .sort((a, b) => ((a.repeat && a.repeat !== "monthly") ? fromKey(a.date).getDate() : a.day) - ((b.repeat && b.repeat !== "monthly") ? fromKey(b.date).getDate() : b.day))
            .map((r) => (
            <li key={r.id} className="py-2">
              {editingId === r.id ? (
                <div className="space-y-2">
                  <Field label="Bill"><input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[100px_120px_120px_130px_auto] sm:items-end">
                    <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></Field>
                    <Field label="Repeats">
                      <select className={inputCls} value={editRepeat} onChange={(e) => setEditRepeat(e.target.value)}>
                        <option value="monthly">Monthly</option>
                        <option value="biweekly">Every 2 weeks</option>
                        <option value="weekly">Every week</option>
                      </select>
                    </Field>
                    {editRepeat === "monthly" ? (
                      <Field label="Day"><input className={inputCls} type="number" min="1" max="31" value={editDay} onChange={(e) => setEditDay(e.target.value)} /></Field>
                    ) : (
                      <Field label="Next due date"><input className={inputCls} type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></Field>
                    )}
                    <Field label="Category (optional)">
                      <input className={inputCls} list="recurring-cat-options" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
                    </Field>
                    <div className="flex gap-2">
                      <button className={btnPrimary} disabled={!editValid} onClick={() => saveEdit(r.id)}>Save</button>
                      <button className={btnGhost} onClick={cancelEdit}>Cancel</button>
                    </div>
                    {editRepeat === "monthly" && (
                      <div className="sm:col-span-2">
                        <Field label="Starts on (optional)">
                          <input className={inputCls} type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} />
                        </Field>
                      </div>
                    )}
                  </div>
                  <NoteField value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.name}</div>
                    <div className="text-xs text-stone-400">
                      {r.category && <span className="mr-1 inline-block rounded bg-emerald-900/40 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">{r.category}</span>}
                      {recurringScheduleLabel(r)}
                      {(r.repeat || "monthly") === "monthly"
                        ? (r.startDate && r.startDate > todayKey() && <span className="ml-1 text-amber-400">· starts {niceDate(r.startDate)}</span>)
                        : (r.date > todayKey() && <span className="ml-1 text-amber-400">· starts {niceDate(r.date)}</span>)}
                    </div>
                    <NoteLine note={r.note} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Mono className="text-sm font-semibold text-red-400">{fmtMoney(-r.amount, true)}</Mono>
                    <button className={btnGhost} onClick={() => startEdit(r)}>Edit</button>
                    <button className={btnGhost} title="Stop future payments — past ones stay on your record" onClick={() => cancelItem(r)}>End bill</button>
                    <button
                      className={btnGhost}
                      title="Delete this bill completely, including past history — use this only if you added it by mistake"
                      onClick={() => update((d) => ({
                        ...d,
                        recurring: d.recurring.filter((x) => x.id !== r.id),
                        reimbursements: (d.reimbursements || []).filter((rb) => !(rb.targetKind === "recurring" && rb.targetId === r.id)),
                      }))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
              {editingId !== r.id && <ReimbursementManager targetKind="recurring" targetId={r.id} amount={r.amount} data={data} update={update} />}
            </li>
          ))}
          <li className="flex items-center justify-between pt-3 text-sm font-semibold">
            <span>Total per month</span>
            <Mono>{fmtMoney(activeRecurring.reduce((s, r) => s + monthlyEquivalent(r), 0))}</Mono>
          </li>
        </ul>
      )}
    </Card>
  );
}

function PaycheckSection({ data, update, viewMonth }) {
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
    update((d) => {
      const original = d.paychecks.find((x) => x.id === id);
      const newAmount = parseFloat(editAmount);
      const edited = { source: editSource.trim() || "Paycheck", amount: newAmount, date: editDate, repeat: editRepeat, note: editNote.trim() };

      // Changing the amount on a repeating paycheck (e.g. a raise) only
      // affects payments from today onward — past ones already happened at
      // the old amount. Same split used for recurring bills; skipped for
      // one-time entries, which are just a single dated record.
      const hasHistory = original && original.repeat !== "none" && original.date <= todayKey()
        && (!original.startDate || original.startDate <= todayKey());
      if (original && newAmount !== original.amount && hasHistory) {
        return {
          ...d,
          paychecks: [
            ...d.paychecks.map((x) => x.id === id ? { ...x, endDate: todayKey() } : x),
            { id: uid(), ...edited, startDate: todayKey() },
          ],
        };
      }

      return { ...d, paychecks: d.paychecks.map((x) => x.id === id ? { ...x, ...edited } : x) };
    });
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
      {(() => {
        // Repeating paychecks are ongoing rules, not tied to one month, so
        // they always show (unless superseded by a later amount split);
        // only one-time income is filtered by viewMonth.
        const visible = data.paychecks.filter((p) => p.repeat !== "none"
          ? (!p.endDate || p.endDate > todayKey())
          : inViewMonth(p.date, viewMonth));
        if (data.paychecks.length === 0) return <Empty>Add your paychecks — repeating ones power the balance calendar and projections.</Empty>;
        if (visible.length === 0) return <Empty>No one-time income this month.</Empty>;
        return (
        <ul className="divide-y divide-stone-800">
          {[...visible].sort((a, b) => a.date.localeCompare(b.date)).map((p) => (
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
                    <button
                      className={btnGhost}
                      onClick={() => update((d) => ({
                        ...d,
                        paychecks: d.paychecks.filter((x) => x.id !== p.id),
                        reimbursements: (d.reimbursements || []).filter((r) => !(r.sourceKind === "paycheck" && r.sourceId === p.id)),
                      }))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        );
      })()}
    </Card>
  );
}

// Candidate income-side entries that can reimburse an expense/card purchase:
// one-time paychecks (which already covers things like a Zelle transfer
// logged as income) and Venmo "money in" entries.
function reimbursementSources(data) {
  const paychecks = data.paychecks
    .filter((p) => p.repeat === "none")
    .map((p) => ({ sourceKind: "paycheck", sourceId: p.id, label: p.source || "Paycheck", amount: p.amount, date: p.date }));
  const venmoIn = (data.venmoTransactions || [])
    .filter((t) => t.direction === "in")
    .map((t) => ({ sourceKind: "venmoTransaction", sourceId: t.id, label: t.description || "Venmo", amount: t.amount, date: t.date }));
  return [...paychecks, ...venmoIn].sort((a, b) => b.date.localeCompare(a.date));
}

// Lets an expense or card purchase be linked to one or more reimbursement
// sources (a friend's Venmo, a Zelle payback) — the entries themselves never
// change, this only feeds the dashboard's net-of-reimbursement views.
function ReimbursementManager({ targetKind, targetId, amount, data, update }) {
  const [expanded, setExpanded] = useState(false);
  const [sourceKey, setSourceKey] = useState("");
  const [linkAmount, setLinkAmount] = useState("");

  const links = (data.reimbursements || []).filter((r) => r.targetKind === targetKind && r.targetId === targetId);
  const linkedTotal = links.reduce((s, r) => s + r.amount, 0);
  const net = Math.max(0, amount - linkedTotal);
  const sources = useMemo(() => reimbursementSources(data), [data]);

  const removeLink = (id) => update((d) => ({ ...d, reimbursements: (d.reimbursements || []).filter((r) => r.id !== id) }));

  const onSourcePick = (key) => {
    setSourceKey(key);
    const src = sources.find((s) => `${s.sourceKind}:${s.sourceId}` === key);
    if (src) setLinkAmount(String(Math.min(src.amount, net > 0 ? net : amount)));
  };

  const addLink = () => {
    const [sourceKind, sourceId] = sourceKey.split(":");
    const amt = parseFloat(linkAmount);
    if (!sourceKind || !sourceId || !(amt > 0)) return;
    update((d) => ({
      ...d,
      reimbursements: [...(d.reimbursements || []), { id: uid(), targetKind, targetId, sourceKind, sourceId, amount: amt }],
    }));
    setSourceKey(""); setLinkAmount("");
  };

  if (!expanded && links.length === 0) {
    return (
      <button className="mt-1 text-xs text-stone-500 underline decoration-dotted hover:text-emerald-400" onClick={() => setExpanded(true)}>
        + mark as reimbursed
      </button>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-stone-800 bg-stone-950/40 p-2">
      {links.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-stone-400">Reimbursed:</span>
          {links.map((r) => {
            const src = sources.find((s) => s.sourceKind === r.sourceKind && s.sourceId === r.sourceId);
            return (
              <span key={r.id} className="flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-emerald-300">
                {fmtMoney(r.amount)} via {src?.label || "linked entry"}
                <button className="text-emerald-400 hover:text-emerald-200" onClick={() => removeLink(r.id)} title="Remove this link">×</button>
              </span>
            );
          })}
          <span className="text-stone-400">→ net <Mono className="text-stone-200">{fmtMoney(net)}</Mono></span>
        </div>
      )}
      {expanded ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Reimbursed by">
            <select className={inputCls + " w-56"} value={sourceKey} onChange={(e) => onSourcePick(e.target.value)}>
              <option value="">Choose a Venmo or income entry…</option>
              {sources.map((s) => (
                <option key={`${s.sourceKind}:${s.sourceId}`} value={`${s.sourceKind}:${s.sourceId}`}>
                  {(s.sourceKind === "venmoTransaction" ? "Venmo: " : "Income: ") + s.label + ` — ${fmtMoney(s.amount)} (${niceDate(s.date)})`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount"><input className={inputCls + " w-24"} type="number" min="0" step="0.01" value={linkAmount} onChange={(e) => setLinkAmount(e.target.value)} /></Field>
          <button className={btnGhost} disabled={!sourceKey || !(parseFloat(linkAmount) > 0)} onClick={addLink}>Link</button>
          <button className={btnGhost} onClick={() => setExpanded(false)}>Done</button>
        </div>
      ) : (
        <button className="text-xs text-stone-500 underline decoration-dotted hover:text-emerald-400" onClick={() => setExpanded(true)}>+ add another</button>
      )}
    </div>
  );
}

function ExpenseSection({ data, update, categories, viewMonth }) {
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

  const sorted = data.expenses.filter((e) => inViewMonth(e.date, viewMonth)).sort((a, b) => b.date.localeCompare(a.date));

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
        <Empty>{data.expenses.length === 0 ? "Log any spending here with your own category names — charts group by whatever categories you invent." : "No purchases logged this month."}</Empty>
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
                <>
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
                      <button
                        className={btnGhost}
                        onClick={() => update((d) => ({
                          ...d,
                          expenses: d.expenses.filter((x) => x.id !== e.id),
                          reimbursements: (d.reimbursements || []).filter((r) => !(r.targetKind === "expense" && r.targetId === e.id)),
                        }))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <ReimbursementManager targetKind="expense" targetId={e.id} amount={e.amount} data={data} update={update} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- credit cards ---------------- */

function CreditCardsSection({ data, update, categories, viewMonth }) {
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
            <CreditCardPanel key={card.id} card={card} data={data} update={update} categories={categories} viewMonth={viewMonth} onRemoveCard={() => removeCard(card.id)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CreditCardPanel({ card, data, update, categories, viewMonth, onRemoveCard }) {
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

      <CardTransactionsList cardId={card.id} data={data} update={update} categories={categories} viewMonth={viewMonth} />
      <CardPaymentsList cardId={card.id} data={data} update={update} viewMonth={viewMonth} />
    </div>
  );
}

function CardTransactionsList({ cardId, data, update, categories, viewMonth }) {
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
  const sorted = data.cardTransactions.filter((t) => t.cardId === cardId && inViewMonth(t.date, viewMonth)).sort((a, b) => b.date.localeCompare(a.date));

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
        <Empty>{data.cardTransactions.some((t) => t.cardId === cardId) ? "No purchases on this card this month." : "No purchases logged on this card yet."}</Empty>
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
                <>
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
                      <button
                        className={btnGhost}
                        onClick={() => update((d) => ({
                          ...d,
                          cardTransactions: d.cardTransactions.filter((x) => x.id !== t.id),
                          reimbursements: (d.reimbursements || []).filter((r) => !(r.targetKind === "cardTransaction" && r.targetId === t.id)),
                        }))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <ReimbursementManager targetKind="cardTransaction" targetId={t.id} amount={t.amount} data={data} update={update} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardPaymentsList({ cardId, data, update, viewMonth }) {
  const sorted = data.cardPayments.filter((p) => p.cardId === cardId && inViewMonth(p.date, viewMonth)).sort((a, b) => b.date.localeCompare(a.date));
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

/* ---------------- venmo ---------------- */

function VenmoBalanceChip({ venmo, update }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  if (editing || !venmo.balanceAsOf) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number" step="0.01" placeholder="Venmo balance"
          value={val} onChange={(e) => setVal(e.target.value)}
          className="w-40 rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          autoFocus={editing}
        />
        <button
          className={btnPrimary}
          disabled={val === "" || isNaN(parseFloat(val))}
          onClick={() => { update((d) => ({ ...d, venmo: { balance: parseFloat(val), balanceAsOf: todayKey() } })); setEditing(false); setVal(""); }}
        >
          Set Venmo balance
        </button>
        {editing && <button className={btnGhost} onClick={() => setEditing(false)}>Cancel</button>}
      </div>
    );
  }

  return (
    <button
      onClick={() => { setVal(String(venmo.balance)); setEditing(true); }}
      className="group flex items-center gap-2 rounded-xl border border-stone-800 bg-stone-800 px-3 py-1.5 text-left hover:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors"
      title="Update your Venmo balance"
    >
      <div>
        <div className="text-[10px] uppercase tracking-wider text-stone-500">Venmo balance · {niceDate(venmo.balanceAsOf)}</div>
        <Mono className="text-lg font-semibold text-emerald-400">{fmtMoney(venmo.balance)}</Mono>
      </div>
      <span className="text-xs text-stone-500 group-hover:text-emerald-400">edit</span>
    </button>
  );
}

function VenmoTransactionForm({ update }) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState("in");
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState("");
  const valid = parseFloat(amount) > 0 && date;

  const addItem = () => {
    update((d) => ({
      ...d,
      venmoTransactions: [...(d.venmoTransactions || []), { id: uid(), description: description.trim(), amount: parseFloat(amount), direction, date, note: note.trim() }],
    }));
    setDescription(""); setAmount(""); setNote("");
  };

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">Log Venmo activity</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_130px_140px_auto] sm:items-end">
        <Field label="What was it? (optional)"><input className={inputCls} placeholder="Yerin paid me back…" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Direction">
          <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
        </Field>
        <Field label="Date"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <button className={btnPrimary} disabled={!valid} onClick={addItem}>Add</button>
        <div className="sm:col-span-5"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </div>
  );
}

function VenmoTransferForm({ update }) {
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState("toVenmo");
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState("");
  const valid = parseFloat(amount) > 0 && date;

  const addItem = () => {
    update((d) => ({
      ...d,
      venmoTransfers: [...(d.venmoTransfers || []), { id: uid(), amount: parseFloat(amount), direction, date, note: note.trim() }],
    }));
    setAmount(""); setNote("");
  };

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">Transfer between bank &amp; Venmo</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_160px_140px_auto] sm:items-end">
        <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Direction">
          <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="toVenmo">Bank → Venmo</option>
            <option value="toBank">Venmo → Bank</option>
          </select>
        </Field>
        <Field label="Date"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <button className={btnPrimary} disabled={!valid} onClick={addItem}>Add transfer</button>
        <div className="sm:col-span-4"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </div>
  );
}

function VenmoLedgerRow({ row, update }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(row.amount));
  const [direction, setDirection] = useState(row.direction);
  const [date, setDate] = useState(row.date);
  const [description, setDescription] = useState(row.description || "");
  const [note, setNote] = useState(row.note || "");
  const editValid = parseFloat(amount) > 0 && date;

  const listKey = row.kind === "transaction" ? "venmoTransactions" : "venmoTransfers";
  const remove = () => update((d) => ({
    ...d,
    [listKey]: d[listKey].filter((x) => x.id !== row.id),
    reimbursements: (d.reimbursements || []).filter((r) => !(r.sourceKind === "venmoTransaction" && r.sourceId === row.id)),
  }));
  const save = () => {
    update((d) => ({
      ...d,
      [listKey]: d[listKey].map((x) => x.id === row.id
        ? row.kind === "transaction"
          ? { ...x, description: description.trim(), amount: parseFloat(amount), direction, date, note: note.trim() }
          : { ...x, amount: parseFloat(amount), direction, date, note: note.trim() }
        : x),
    }));
    setEditing(false);
  };

  const isPositive = row.kind === "transaction" ? row.direction === "in" : row.direction === "toBank";
  const label = row.kind === "transaction"
    ? (row.description || (row.direction === "in" ? "Money in" : "Money out"))
    : (row.direction === "toVenmo" ? "Transfer to Venmo" : "Transfer from Venmo");

  if (editing) {
    return (
      <li className="py-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_140px_140px_auto] sm:items-end">
          {row.kind === "transaction" && (
            <Field label="What was it?"><input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          )}
          <Field label="Amount"><input className={inputCls} type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Direction">
            <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value)}>
              {row.kind === "transaction" ? (
                <><option value="in">Money in</option><option value="out">Money out</option></>
              ) : (
                <><option value="toVenmo">Bank → Venmo</option><option value="toBank">Venmo → Bank</option></>
              )}
            </select>
          </Field>
          <Field label="Date"><input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <div className="flex gap-2">
            <button className={btnPrimary} disabled={!editValid} onClick={save}>Save</button>
            <button className={btnGhost} onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <div className="sm:col-span-5"><NoteField value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-stone-400">
          {niceDate(row.date)}
          {row.kind === "transfer" && <span className="ml-1 text-stone-500">· transfer</span>}
        </div>
        <NoteLine note={row.note} />
      </div>
      <div className="flex items-center gap-3">
        <Mono className={`text-sm font-semibold ${isPositive ? "text-emerald-400" : "text-red-400"}`}>{fmtMoney(isPositive ? row.amount : -row.amount, true)}</Mono>
        <button className={btnGhost} onClick={() => setEditing(true)}>Edit</button>
        <button className={btnGhost} onClick={remove}>Remove</button>
      </div>
    </li>
  );
}

function VenmoLedger({ transactions, transfers, update, viewMonth }) {
  const rows = [
    ...transactions.map((t) => ({ ...t, kind: "transaction" })),
    ...transfers.map((t) => ({ ...t, kind: "transfer" })),
  ].filter((r) => inViewMonth(r.date, viewMonth)).sort((a, b) => b.date.localeCompare(a.date));

  if (rows.length === 0) {
    return <Empty>{transactions.length === 0 && transfers.length === 0 ? "No Venmo activity logged yet." : "No Venmo activity this month."}</Empty>;
  }

  return (
    <ul className="divide-y divide-stone-800">
      {rows.map((r) => <VenmoLedgerRow key={`${r.kind}-${r.id}`} row={r} update={update} />)}
    </ul>
  );
}

function VenmoSection({ data, update, viewMonth }) {
  const venmo = data.venmo || { balance: 0, balanceAsOf: null };
  const transactions = data.venmoTransactions || [];
  const transfers = data.venmoTransfers || [];
  const daysSinceAnchor = venmo.balanceAsOf
    ? Math.ceil((fromKey(todayKey()) - fromKey(venmo.balanceAsOf)) / 86400000)
    : 0;
  const horizonDays = Math.max(210, daysSinceAnchor + 30);
  const projection = useMemo(
    () => buildVenmoProjection(venmo, transactions, transfers, horizonDays),
    [venmo, transactions, transfers, horizonDays]
  );
  const currentBalance = venmo.balanceAsOf ? (projection.byDay[todayKey()] ?? venmo.balance) : venmo.balance;

  return (
    <Card title="Venmo">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <VenmoBalanceChip venmo={venmo} update={update} />
        {venmo.balanceAsOf && (
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-stone-500">Today</div>
            <Mono className="text-lg font-semibold text-emerald-400">{fmtMoney(currentBalance)}</Mono>
          </div>
        )}
      </div>
      <VenmoTransactionForm update={update} />
      <VenmoTransferForm update={update} />
      <VenmoLedger transactions={transactions} transfers={transfers} update={update} viewMonth={viewMonth} />
    </Card>
  );
}

/* ---------------- balance calendar ---------------- */

// Which data-key holds the override list for a given occurrence source.
const OVERRIDE_KEY = { recurring: "recurringOverrides", paycheck: "paycheckOverrides" };

// One line item in a calendar day's detail panel. Recurring-bill and
// repeating-paycheck occurrences (items carrying a sourceId) can be corrected
// in place if the actual amount that moved differed from the usual amount —
// this only records an override for that specific date, it never touches the
// underlying recurring rule.
function OccurrenceRow({ it, dateKey, update }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(Math.abs(it.amt)));
  const overridesKey = OVERRIDE_KEY[it.sourceType];

  const saveOverride = () => {
    const amount = parseFloat(val);
    if (!(amount > 0)) return;
    update((d) => ({
      ...d,
      [overridesKey]: [
        ...(d[overridesKey] || []).filter((o) => !(o.sourceId === it.sourceId && o.date === dateKey)),
        { id: uid(), sourceId: it.sourceId, date: dateKey, amount },
      ],
    }));
    setEditing(false);
  };
  const clearOverride = () => {
    update((d) => ({
      ...d,
      [overridesKey]: (d[overridesKey] || []).filter((o) => !(o.sourceId === it.sourceId && o.date === dateKey)),
    }));
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{it.label}</span>
        <input className={inputCls + " w-24"} type="number" min="0" step="0.01" autoFocus value={val} onChange={(e) => setVal(e.target.value)} />
        <button className={btnGhost} onClick={saveOverride}>Save</button>
        <button className={btnGhost} onClick={() => setEditing(false)}>Cancel</button>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{it.label}</span>
        {it.overridden && <span className="shrink-0 rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">edited</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Mono className={it.informational ? "text-stone-400" : it.amt < 0 ? "text-red-400" : "text-emerald-400"}>{fmtMoney(it.amt, true)}</Mono>
        {overridesKey && (
          <>
            <button className={btnGhost} onClick={() => { setVal(String(Math.abs(it.amt))); setEditing(true); }}>{it.overridden ? "Edit" : "Actual…"}</button>
            {it.overridden && <button className={btnGhost} onClick={clearOverride}>Reset</button>}
          </>
        )}
      </span>
    </li>
  );
}

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
    return { key, proj: projection.byDay[key] || projection.pastByDay?.[key] };
  };

  const toneFor = (bal) => bal < 0
    ? "bg-red-950/40 text-red-300 border-red-800"
    : bal < 250
    ? "bg-amber-950/40 text-amber-300 border-amber-800"
    : "bg-emerald-950/40 text-emerald-300 border-emerald-800";
  const pastTone = "bg-stone-800/70 text-stone-300 border-stone-700";

  const selKey = selected;
  const sel = selKey ? { key: selKey, proj: projection.byDay[selKey] || projection.pastByDay?.[selKey] } : null;

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
                  proj ? (proj.balance != null ? toneFor(proj.balance) : pastTone) + " hover:brightness-125" : "border-stone-800 bg-stone-800/40 text-stone-600"
                } ${isSel ? "ring-2 ring-emerald-500" : ""}`}
              >
                <div className={`text-[11px] font-semibold ${isToday ? "inline-block rounded bg-emerald-600 px-1 text-white" : ""}`}>{d}</div>
                {proj && (
                  <>
                    {proj.balance != null && (
                      <Mono className="mt-0.5 block truncate text-[11px] font-semibold sm:text-xs">{fmtShort(proj.balance)}</Mono>
                    )}
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
          {sel.proj.balance != null ? (
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-sm text-stone-400">Projected end-of-day balance</span>
              <Mono className={`text-2xl font-bold ${sel.proj.balance < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtMoney(sel.proj.balance)}</Mono>
            </div>
          ) : (
            <p className="mb-2 text-sm text-stone-400">This already happened. If a bill went out for a different amount, edit it below — it won't change your recurring bill going forward.</p>
          )}
          {sel.proj.items.length > 0 ? (
            <>
              <ul className="divide-y divide-stone-800">
                {sel.proj.items.map((it, i) => (
                  <OccurrenceRow key={i} it={it} dateKey={sel.key} update={update} />
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between border-t border-stone-700 pt-3 text-sm font-semibold">
                <span>Net for the day (bank account)</span>
                {(() => {
                  const net = sel.proj.items.filter((it) => !it.informational).reduce((s, it) => s + it.amt, 0);
                  return <Mono className={net < 0 ? "text-red-400" : "text-emerald-400"}>{fmtMoney(net, true)}</Mono>;
                })()}
              </div>
              {sel.proj.items.some((it) => it.informational) && (
                <>
                  <div className="mt-1.5 flex items-center justify-between text-sm font-semibold">
                    <span className="text-stone-400">Total activity (incl. card &amp; Venmo)</span>
                    {(() => {
                      const total = sel.proj.items.reduce((s, it) => s + it.amt, 0);
                      return <Mono className={total < 0 ? "text-red-400" : "text-emerald-400"}>{fmtMoney(total, true)}</Mono>;
                    })()}
                  </div>
                  <p className="mt-2 text-xs text-stone-500">
                    Card and Venmo activity above (shown in gray) doesn't count toward your bank balance until it's paid off or transferred — "Total activity" includes it anyway, for a full picture of the day's spending.
                  </p>
                </>
              )}
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
    recurringBills: data.recurring
      .filter((r) => !r.endDate || r.endDate > todayKey())
      .map((r) => ({
        name: r.name, amount: r.amount, repeats: r.repeat || "monthly",
        ...(((r.repeat || "monthly") === "monthly") ? { dayOfMonth: r.day, startsOn: r.startDate || "immediately" } : { anchorDate: r.date }),
        note: r.note || undefined,
      })),
    incomeEntries: data.paychecks
      .filter((p) => !p.endDate || p.endDate > todayKey())
      .map((p) => ({ source: p.source, amount: p.amount, startDate: p.date, repeats: p.repeat, note: p.note || undefined })),
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

const isBulletLine = (l) => /^\s*[-*]\s+/.test(l);
const isNumberedLine = (l) => /^\s*\d+\.\s+/.test(l);
const isHeaderLine = (l) => /^#{1,6}\s+/.test(l);
const isHrLine = (l) => /^\s*([-*_])\1{2,}\s*$/.test(l);
const isQuoteLine = (l) => /^\s*>\s?/.test(l);
const isBlockStartLine = (l) => isBulletLine(l) || isNumberedLine(l) || isHeaderLine(l) || isHrLine(l) || isQuoteLine(l);

function MessageContent({ text }) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    if (isHeaderLine(lines[i])) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      const level = m[1].length;
      blocks.push(
        <div key={blocks.length} className={`${level <= 2 ? "text-base" : "text-sm"} mt-3 mb-1 font-bold first:mt-0`}>
          {renderInline(m[2])}
        </div>
      );
      i++;
    } else if (isHrLine(lines[i])) {
      blocks.push(<hr key={blocks.length} className="my-2 border-stone-600/60" />);
      i++;
    } else if (isQuoteLine(lines[i])) {
      const items = [];
      while (i < lines.length && isQuoteLine(lines[i])) { items.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={blocks.length} className="my-1 border-l-2 border-stone-600 pl-3 italic text-stone-400 first:mt-0 last:mb-0">
          {items.map((l, idx) => <div key={idx}>{renderInline(l)}</div>)}
        </blockquote>
      );
    } else if (isBulletLine(lines[i])) {
      const items = [];
      while (i < lines.length && isBulletLine(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(
        <ul key={blocks.length} className="my-1 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0">
          {items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ul>
      );
    } else if (isNumberedLine(lines[i])) {
      const items = [];
      while (i < lines.length && isNumberedLine(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(
        <ol key={blocks.length} className="my-1 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0">
          {items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ol>
      );
    } else {
      const paraLines = [];
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStartLine(lines[i])) {
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
  const textareaRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  // Grow the textarea to fit what's typed (up to a cap, then it scrolls
  // internally) — runs whenever the text changes, including the resets
  // after sending or restoring a failed message, so it shrinks back too.
  // When empty, skip the scrollHeight measurement entirely and let the
  // rows={1} default take over — Chrome factors the (long, wrapping)
  // placeholder text into an empty textarea's scrollHeight, which would
  // otherwise make the box look already-grown before anything is typed.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) { el.style.height = ""; return; }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

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

      <div className="mt-3 flex items-end gap-2 border-t border-stone-800 pt-3">
        <textarea
          ref={textareaRef}
          rows={1}
          className={`${inputCls} resize-none overflow-y-auto leading-snug`}
          placeholder='Try: "I want to buy a $250 jacket — do I have enough?"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={busy}
        />
        <button className={btnPrimary} onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </Card>
  );
}
