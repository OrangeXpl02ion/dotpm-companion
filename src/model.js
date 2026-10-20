"use strict";
// Pure calculations. No Obsidian imports, so this file is unit-tested in Node.

const NO_TYPE = "__none";
const DEFAULT_MULTIPLIER = 2;

// ---------- dates (YYYY-MM-DD strings, UTC day arithmetic) ----------
const DAY = 86400000;
function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// Frontmatter dates may arrive as "2026-11-24", 2026-11-24T00:00:00Z, a Date object, or "".
function normDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "string") { const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }
  return null;
}
function toDay(s) { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; }
function fromDay(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
function addDays(s, n) { return fromDay(toDay(s) + n); }
function diffDays(a, b) { return toDay(b) - toDay(a); }
function mondayOf(s) { const n = toDay(s); const dow = (new Date(n * DAY).getUTCDay() + 6) % 7; return fromDay(n - dow); }
function isoWeek(s) {
  const d = new Date(toDay(s) * DAY);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- dotpm config ----------
function readDotpmConfig(data) {
  data = data || {};
  const statuses = Array.isArray(data.statuses) && data.statuses.length ? data.statuses : [
    { id: "todo", label: "To Do" }, { id: "in-progress", label: "In Progress" }, { id: "blocked", label: "Blocked" },
    { id: "review", label: "In Review" }, { id: "done", label: "Done", complete: true }, { id: "cancelled", label: "Cancelled", complete: true }];
  const priorities = Array.isArray(data.priorities) && data.priorities.length ? data.priorities : [
    { id: "critical", label: "Critical" }, { id: "high", label: "High" }, { id: "medium", label: "Medium" }, { id: "low", label: "Low" }];
  const wt = (data.customFields || []).find(f => f && f.name === "work-type");
  return {
    projectsFolder: String(data.projectsFolder || "Project/").replace(/\/?$/, "/"),
    statuses, priorities,
    workTypeFieldId: wt ? wt.id : null,
    workTypes: wt && Array.isArray(wt.options) ? wt.options.slice() : [],
  };
}
function isComplete(cfg, status) { const s = cfg.statuses.find(x => x.id === status); return !!(s && s.complete); }
function doneStatusId(cfg) { const s = cfg.statuses.find(x => x.complete && /done/i.test(x.id)) || cfg.statuses.find(x => x.complete); return s ? s.id : "done"; }
function priorityRank(cfg, p) { const i = cfg.priorities.findIndex(x => x.id === p); return i === -1 ? cfg.priorities.length : i; }
function label(list, id) { const x = list.find(v => v.id === id); return x ? x.label : (id || ""); }

// ---------- task parsing ----------
function linkText(v) {
  if (typeof v !== "string") return "";
  const m = v.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
  return m ? (m[2] || m[1].split("/").pop()) : v;
}
function parseChecklist(body) {
  if (typeof body !== "string") return null;
  const lines = body.split(/\r?\n/);
  let i = lines.findIndex(l => /^##\s+Done when\s*$/i.test(l.trim()));
  if (i === -1) return null;
  let done = 0, total = 0;
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,2}\s/.test(l)) break;
    const m = l.match(/^\s*[-*+]\s+\[( |x|X)\]/);
    if (m) { total++; if (m[1] !== " ") done++; }
  }
  return total ? { done, total } : null;
}
function checklistProgress(cl) { return cl && cl.total ? Math.round((cl.done / cl.total) * 100) : null; }

function parseTask(path, fm, body, cfg) {
  if (!fm || fm["pm-task"] !== true) return null;
  const logs = Array.isArray(fm.timeLogs) ? fm.timeLogs
    .filter(l => l && typeof l.hours === "number" && isFinite(l.hours))
    .map(l => ({ date: normDate(l.date), hours: l.hours })) : [];
  const cf = fm.customFields && typeof fm.customFields === "object" ? fm.customFields : {};
  const wt = cfg.workTypeFieldId ? cf[cfg.workTypeFieldId] : undefined;
  const est = typeof fm.timeEstimate === "number" && isFinite(fm.timeEstimate) ? fm.timeEstimate : null;
  return {
    path,
    id: String(fm.id || path),
    title: String(fm.title || path.split("/").pop().replace(/\.md$/, "")),
    project: linkText(fm.projectId),
    type: fm.type === "milestone" ? "milestone" : fm.type === "subtask" ? "subtask" : "task",
    status: String(fm.status || "todo"),
    priority: String(fm.priority || ""),
    start: normDate(fm.start),
    due: normDate(fm.due),
    estimate: est,
    logged: logs.reduce((a, l) => a + l.hours, 0),
    logs,
    workType: typeof wt === "string" && wt ? wt : null,
    progress: typeof fm.progress === "number" ? fm.progress : 0,
    checklist: parseChecklist(body),
    completed: normDate(fm.completed),
    deps: Array.isArray(fm.dependencies) ? fm.dependencies.map(linkTarget).filter(Boolean) : [],
  };
}
// "[[kettle-3d-print|Kettle 3D print]]" -> "kettle-3d-print" (the note's file name)
function linkTarget(v) {
  if (typeof v !== "string") return null;
  const m = v.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
  return (m ? m[1] : v).split("/").pop().replace(/\.md$/, "") || null;
}
function baseName(path) { return path.split("/").pop().replace(/\.md$/, ""); }
// A task is ready when every dependency that exists in the vault is complete.
function isReady(t, byName, cfg) { return (t.deps || []).every(d => { const x = byName.get(d); return !x || isComplete(cfg, x.status); }); }

// ---------- multipliers ----------
function typeKey(t) { return t.workType || NO_TYPE; }
function multiplierFor(mults, key) { const v = mults && mults[key]; return typeof v === "number" && v > 0 ? v : DEFAULT_MULTIPLIER; }
function remaining(t) { return Math.max(0, (t.estimate || 0) - t.logged); }
function adjusted(t, mults) { return remaining(t) * multiplierFor(mults, typeKey(t)); }

// Append a history point; one point per type per day (a same-day change replaces it).
function recordMultiplier(history, date, key, value) {
  const h = history.filter(p => !(p.date === date && p.type === key));
  h.push({ date, type: key, value });
  h.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return h;
}
function ensureMultipliers(settings, keys, today) {
  settings.multipliers = settings.multipliers || {};
  settings.multiplierHistory = settings.multiplierHistory || [];
  let changed = false;
  for (const k of keys) {
    if (typeof settings.multipliers[k] !== "number") {
      settings.multipliers[k] = DEFAULT_MULTIPLIER;
      settings.multiplierHistory = recordMultiplier(settings.multiplierHistory, today, k, DEFAULT_MULTIPLIER);
      changed = true;
    }
  }
  return changed;
}
// Value of a type's multiplier on a given date, from its history (step function).
function multiplierOn(history, key, date) {
  let v = null;
  for (const p of history) if (p.type === key && p.date <= date) v = p.value;
  return v;
}
// Measured actual ÷ estimate over done tasks that have both.
function measured(tasks, cfg) {
  const acc = {};
  for (const t of tasks) {
    if (!isComplete(cfg, t.status) || !(t.estimate > 0) || !(t.logged > 0)) continue;
    const k = typeKey(t);
    acc[k] = acc[k] || { logged: 0, estimate: 0, n: 0 };
    acc[k].logged += t.logged; acc[k].estimate += t.estimate; acc[k].n++;
  }
  const out = {};
  for (const k in acc) out[k] = { factor: acc[k].logged / acc[k].estimate, n: acc[k].n };
  return out;
}

// Measured factor over time: cumulative logged ÷ estimate over tasks done by each completion date.
function measuredSeries(tasks, cfg) {
  const by = {};
  for (const t of tasks) {
    if (!isComplete(cfg, t.status) || !(t.estimate > 0) || !(t.logged > 0)) continue;
    const date = t.completed || t.logs.map(l => l.date).filter(Boolean).sort().pop();
    if (!date) continue;
    (by[typeKey(t)] = by[typeKey(t)] || []).push({ date, logged: t.logged, estimate: t.estimate });
  }
  const out = {};
  for (const k in by) {
    let L = 0, E = 0, n = 0;
    const pts = [];
    for (const x of by[k].sort((a, b) => a.date.localeCompare(b.date))) {
      L += x.logged; E += x.estimate; n++;
      if (pts.length && pts[pts.length - 1].date === x.date) pts.pop();
      pts.push({ date: x.date, value: L / E, n });
    }
    out[k] = pts;
  }
  return out;
}

// ---------- capacity ----------
function parseCapacity(md) {
  const map = {};
  if (typeof md !== "string") return map;
  const rows = md.split(/\r?\n/).filter(l => /^\s*\|/.test(l));
  if (rows.length < 2) return map;
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const head = cells(rows[0]).map(c => c.toLowerCase());
  const wi = head.findIndex(c => c.includes("week"));
  const hi = head.findIndex(c => c.includes("available") || c.includes("hours"));
  if (wi === -1 || hi === -1) return map;
  for (const r of rows.slice(1)) {
    const c = cells(r);
    if (c.every(x => /^:?-+:?$/.test(x) || x === "")) continue;
    const wk = c[wi], hrs = parseFloat(c[hi]);
    if (!isFinite(hrs)) continue;
    if (/^\d{4}-W\d{2}$/.test(wk)) map[wk] = hrs;
    else if (isDate(wk)) map[isoWeek(wk)] = hrs;
  }
  return map;
}
function capacityTemplate(rangeStart, rangeEnd, hours) {
  const lines = ["# Capacity", "", "Available hours per week for planning. The dotpm Companion reads this table.", "",
    "| Week | Starts | Available hours | Notes |", "| --- | --- | --- | --- |"];
  for (let m = mondayOf(rangeStart); m <= rangeEnd; m = addDays(m, 7)) lines.push(`| ${isoWeek(m)} | ${m} | ${hours} |  |`);
  return lines.join("\n") + "\n";
}
function weeksInRange(rangeStart, rangeEnd) {
  const out = [];
  for (let m = mondayOf(rangeStart); m <= rangeEnd; m = addDays(m, 7)) out.push({ week: isoWeek(m), start: m, end: addDays(m, 6) });
  return out;
}
function availableOnDay(cap, date, fallbackWeekly) {
  const w = isoWeek(date);
  return (w in cap ? cap[w] : fallbackWeekly) / 7;
}

// Spread rule: remaining hours spread evenly over each day from max(start, today) to due.
// Overdue: everything lands today. No due date: unscheduled (null).
function spread(t, hours, today) {
  if (!t.due || hours <= 0) return null;
  const from = t.start && t.start > today ? t.start : today;
  const to = t.due < from ? from : t.due;
  const n = diffDays(from, to) + 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push([addDays(from, i), hours / n]);
  return out;
}

function compute(tasks, cfg, settings, today) {
  const mults = settings.multipliers || {};
  const cap = settings.capacity || {};
  const fallback = settings.defaultWeeklyHours;
  const open = tasks.filter(t => !isComplete(cfg, t.status));
  const weeks = weeksInRange(settings.rangeStart, settings.rangeEnd).map(w => ({
    ...w, raw: 0, adj: 0, available: w.week in cap ? cap[w.week] : fallback, fromFile: w.week in cap,
    byType: {}, rawByType: {}, tasks: [],
  }));
  const byWeek = Object.fromEntries(weeks.map(w => [w.week, w]));
  const unscheduled = [], beyond = [];
  for (const t of open) {
    const raw = remaining(t), adj = adjusted(t, mults);
    if (raw <= 0) continue;
    const s = spread(t, raw, today);
    if (!s) { unscheduled.push(t); continue; }
    const k = typeKey(t);
    const per = {};
    for (const [d, h] of s) {
      const w = byWeek[isoWeek(d)];
      if (!w) { if (!beyond.includes(t)) beyond.push(t); continue; }
      const a = h * (adj / raw);
      w.raw += h; w.adj += a;
      w.byType[k] = (w.byType[k] || 0) + a;
      w.rawByType[k] = (w.rawByType[k] || 0) + h;
      per[w.week] = (per[w.week] || { raw: 0, adj: 0 });
      per[w.week].raw += h; per[w.week].adj += a;
    }
    for (const wk in per) byWeek[wk].tasks.push({ task: t, raw: per[wk].raw, adj: per[wk].adj });
  }
  const threshold = (settings.overloadPct || 85) / 100;
  for (const w of weeks) {
    w.pct = w.available > 0 ? w.adj / w.available : (w.adj > 0 ? Infinity : 0);
    w.overloaded = w.pct >= threshold;
    w.isCurrent = today >= w.start && today <= w.end;
    w.isPast = w.end < today;
    w.tasks.sort((a, b) => b.adj - a.adj);
  }
  // At risk: adjusted remaining hours exceed the hours available between today and the due date.
  const risk = {};
  for (const t of open) {
    const adj = adjusted(t, mults);
    if (!t.due || adj <= 0) continue;
    const overdue = t.due < today;
    let avail = 0;
    if (!overdue) for (let d = today; d <= t.due; d = addDays(d, 1)) avail += availableOnDay(cap, d, fallback);
    if (overdue || adj > avail) risk[t.path] = { overdue, need: adj, available: avail, days: overdue ? 0 : diffDays(today, t.due) + 1 };
  }
  // Priority queue: open, not starting in the future; priority, then due, then remaining hours (largest first).
  const queue = open
    .filter(t => !(t.start && t.start > today))
    .sort((a, b) =>
      priorityRank(cfg, a.priority) - priorityRank(cfg, b.priority) ||
      (a.due || "9999") .localeCompare(b.due || "9999") ||
      adjusted(b, mults) - adjusted(a, mults) ||
      a.title.localeCompare(b.title));
  const upcoming = open.filter(t => t.start && t.start > today).length;
  const byName = new Map(tasks.map(t => [baseName(t.path), t]));
  const ready = t => isReady(t, byName, cfg);
  // Next tasks you could pull forward: not started yet, dependencies done, best priority first.
  const candidates = open.filter(t => t.start && t.start > today && ready(t))
    .sort((a, b) => priorityRank(cfg, a.priority) - priorityRank(cfg, b.priority) || a.start.localeCompare(b.start) || (a.due || "9999").localeCompare(b.due || "9999"));
  const doneToday = tasks.filter(t => isComplete(cfg, t.status) && t.completed === today).sort((a, b) => a.title.localeCompare(b.title));
  const blocked = new Set(open.filter(t => !ready(t)).map(t => t.path));
  return { today, weeks, risk, queue, upcoming, unscheduled, beyond, measured: measured(tasks, cfg), measuredSeries: measuredSeries(tasks, cfg),
    candidates, doneToday, blocked, board: board(open, cfg, settings, weeks, today) };
}

// Board columns. By week: the week a task is due (overdue, this week onward, later, no due date).
function board(open, cfg, settings, weeks, today) {
  const mults = settings.multipliers || {};
  const order = (a, b) => priorityRank(cfg, a.priority) - priorityRank(cfg, b.priority) || (a.due || "9999").localeCompare(b.due || "9999") || adjusted(b, mults) - adjusted(a, mults) || a.title.localeCompare(b.title);
  const live = weeks.filter(w => !w.isPast);
  const cols = [{ key: "overdue", label: "Overdue", tasks: [] },
    ...live.map(w => ({ key: w.week, label: w.isCurrent ? "This week" : w.week.slice(5), week: w, tasks: [] })),
    { key: "later", label: "Later", tasks: [] }, { key: "none", label: "No due date", tasks: [] }];
  const byKey = Object.fromEntries(cols.map(c => [c.key, c]));
  const last = live.length ? live[live.length - 1].end : today;
  for (const t of open) {
    const k = !t.due ? "none" : t.due < today ? "overdue" : t.due > last ? "later" : isoWeek(t.due);
    (byKey[k] || byKey.later).tasks.push(t);
  }
  for (const c of cols) c.tasks.sort(order);
  return cols.filter(c => c.tasks.length || c.week);
}
// New start/due when a task is moved to another week: shift both by whole weeks; no due date -> Friday of that week.
function shiftToWeek(t, weekStart) {
  if (!t.due) return { due: addDays(weekStart, 4) };
  const shift = diffDays(mondayOf(t.due), weekStart);
  if (!shift) return null;
  const out = { due: addDays(t.due, shift) };
  if (t.start) out.start = addDays(t.start, shift);
  return out;
}

// ---------- file text ----------
function bodyOf(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}
// Replace (or add) top-level `key: value` lines inside the frontmatter only; nothing else in the file changes.
function setFrontmatterLines(text, fields) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = m[1].split(/\r?\n/);
  for (const k in fields) {
    const i = lines.findIndex(l => l.startsWith(k + ":"));
    const line = `${k}: ${fields[k]}`;
    if (i === -1) lines.push(line); else lines[i] = line;
  }
  return `---${nl}${lines.join(nl)}${nl}---` + text.slice(m[0].length);
}

module.exports = {
  bodyOf, setFrontmatterLines,
  NO_TYPE, DEFAULT_MULTIPLIER,
  isDate, normDate, toDay, fromDay, addDays, diffDays, mondayOf, isoWeek, localToday,
  readDotpmConfig, isComplete, doneStatusId, priorityRank, label,
  linkText, parseChecklist, checklistProgress, parseTask,
  typeKey, multiplierFor, remaining, adjusted, recordMultiplier, ensureMultipliers, multiplierOn, measured,
  parseCapacity, capacityTemplate, weeksInRange, spread, compute,
  linkTarget, baseName, isReady, measuredSeries, board, shiftToWeek,
};
