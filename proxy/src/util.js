"use strict";

/** Evaluate a arithmetic expression via shunting-yard. No eval, no globals. */
function calc(expr) {
  const s = String(expr).replace(/,/g, "");
  if (!/^[0-9+\-*/().\s]+$/.test(s) || !/\d/.test(s)) return null;

  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const n = parseFloat(s.slice(i, j));
      if (!Number.isFinite(n)) return null;
      toks.push(n);
      i = j;
      continue;
    }
    if ("+-*/()".includes(c)) {
      toks.push(c);
      i++;
      continue;
    }
    i++;
  }

  const prec = { "+": 1, "-": 1, "*": 2, "/": 2 };
  const out = [];
  const ops = [];
  for (const t of toks) {
    if (typeof t === "number") out.push(t);
    else if (t === "(") ops.push(t);
    else if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
      if (!ops.length) return null; // unbalanced
      ops.pop();
    } else {
      while (ops.length && ops[ops.length - 1] !== "(" && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop());
      ops.push(t);
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === "(") return null; // unbalanced
    out.push(op);
  }

  const st = [];
  for (const x of out) {
    if (typeof x === "number") {
      st.push(x);
      continue;
    }
    const b = st.pop();
    const a = st.pop();
    if (a == null || b == null) return null;
    st.push(x === "+" ? a + b : x === "-" ? a - b : x === "*" ? a * b : a / b);
  }
  return st.length === 1 && Number.isFinite(st[0]) ? st[0] : null;
}

const UNITS = {
  m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.34, ft: 0.3048, in: 0.0254, yd: 0.9144,
  kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495,
  l: 1, ml: 0.001, gal: 3.78541,
};
// Unit families must not cross: "5 kg to mi" is nonsense, not 0.0000031.
const FAMILY = {
  m: "len", km: "len", cm: "len", mm: "len", mi: "len", ft: "len", in: "len", yd: "len",
  kg: "mass", g: "mass", lb: "mass", oz: "mass",
  l: "vol", ml: "vol", gal: "vol",
};

function convert(q) {
  const m = String(q).match(/(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s+(?:to|in)\s+([a-zA-Z]+)/);
  if (!m) return null;
  const v = Number(m[1]);
  const a = m[2].toLowerCase();
  const b = m[3].toLowerCase();
  if (a === "c" && b === "f") return { v: (v * 9) / 5 + 32, u: "F" };
  if (a === "f" && b === "c") return { v: ((v - 32) * 5) / 9, u: "C" };
  if (UNITS[a] && UNITS[b] && FAMILY[a] === FAMILY[b]) return { v: (v * UNITS[a]) / UNITS[b], u: b };
  return null;
}

const fmt = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
const enc = (s) => encodeURIComponent(s == null ? "" : s);

const gcalFmt = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "T" + p(d.getHours()) + p(d.getMinutes()) + "00"
  );
};

const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** Best-effort natural-language time. Falls back to "an hour from now". */
function parseWhen(input, now = new Date()) {
  const d = new Date(now.getTime());
  const low = String(input).toLowerCase();

  if (/\btomorrow\b/.test(low)) d.setDate(d.getDate() + 1);
  else if (/\bnext week\b/.test(low)) d.setDate(d.getDate() + 7);

  const dayM = low.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (dayM) {
    let diff = (DAYS[dayM[1]] - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
  }

  const tM = String(input).match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (tM) {
    let h = Number(tM[1]);
    const min = Number(tM[2] || 0);
    const ap = (tM[3] || "").toLowerCase();
    if (h > 23 || min > 59) return new Date(now.getTime() + 3600000);
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, min, 0, 0);
  } else {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  }
  return d;
}

module.exports = { calc, convert, fmt, enc, gcalFmt, parseWhen, UNITS };
