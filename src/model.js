"use strict";
// Pure calculations. No Obsidian imports, so this file is unit-tested in Node.

const NO_TYPE = "__none";
const NO_PROJECT = "__noproject";
// dotpm's own default sort, and the companion's replacement (due date, then priority; dotpm ranks priority by list order).
const DUE_SORT = [{ key: "due", dir: "asc" }, { key: "priority", dir: "asc" }];
function isDefaultSort(sort) { return !Array.isArray(sort) || !sort.length || (sort.length === 1 && sort[0] && sort[0].key === "status" && sort[0].dir !== "desc"); }
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
    .map(l => ({ date: normDate(l.date), hours: l.hours, start: normClock(l.start), end: normClock(l.end) })) : [];
  const cf = fm.customFields && typeof fm.customFields === "object" ? fm.customFields : {};
  // Normally keyed by dotpm's field id; if that id differs on this device (dotpm settings not synced),
  // fall back to any custom-field value that is one of the work-type options.
  let wt = cfg.workTypeFieldId ? cf[cfg.workTypeFieldId] : undefined;
  if (wt == null && cfg.workTypes.length) wt = Object.values(cf).find(v => typeof v === "string" && cfg.workTypes.includes(v));
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
    customFields: { ...cf },
    deps: Array.isArray(fm.dependencies) ? fm.dependencies.map(linkTarget).filter(Boolean) : [],
  };
}
// "[[toaster-3d-print|Toaster 3D print]]" -> "toaster-3d-print" (the note's file name)
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
// Raw hours left: estimate − logged (no multiplier).
function remaining(t) { return Math.max(0, (t.estimate || 0) - t.logged); }
// Real hours left: the multiplier turns the estimate into real hours; logged hours are already real,
// so they come off after multiplying (estimate × multiplier − logged), never before.
function adjusted(t, mults) { return Math.max(0, (t.estimate || 0) * multiplierFor(mults, typeKey(t)) - t.logged); }
// Logged time has reached estimate × multiplier but the task isn't done: the estimate needs revising.
function overBudget(t, mults) { return t.estimate > 0 && t.logged > 0 && t.logged >= t.estimate * multiplierFor(mults, typeKey(t)); }

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
function cellsOf(l) { return l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.trim()); }
function isRule(c) { return c.every(x => /^:?-+:?$/.test(x) || x === ""); }
// Markdown tables in a file: [{ start, head (lower-case cells), rows: [{ line, cells }] }], line = index in lines.
function tablesOf(lines) {
  const out = []; let cur = null;
  lines.forEach((l, i) => {
    if (!/^\s*\|/.test(l)) { cur = null; return; }
    const c = cellsOf(l);
    if (!cur) { cur = { start: i, head: c.map(x => x.toLowerCase()), rows: [] }; out.push(cur); return; }
    if (isRule(c)) return;
    cur.rows.push({ line: i, cells: c });
  });
  return out;
}
function weekTable(tables) {
  for (const t of tables) {
    const wi = t.head.findIndex(c => /^week\b/.test(c) || /\bweek$/.test(c));
    const hi = t.head.findIndex(c => c.includes("available") || c.includes("hours"));
    if (wi !== -1 && hi !== -1) return { ...t, wi, hi };
  }
  return null;
}
// Daily table written by the capacity script: | Day | Available hours | Usable | Notes |
function dayTable(tables) {
  for (const t of tables) {
    const di = t.head.findIndex(c => c === "day" || c === "date");
    const hi = t.head.findIndex(c => c.includes("available"));
    if (di !== -1 && hi !== -1 && !t.head.some(c => /^week\b/.test(c))) return { ...t, di, hi };
  }
  return null;
}
// Weekly hours, read from the first table that has a Week and an Available hours column.
function parseCapacity(md) {
  const map = {};
  if (typeof md !== "string") return map;
  const t = weekTable(tablesOf(md.split(/\r?\n/)));
  if (!t) return map;
  for (const r of t.rows) {
    const wk = r.cells[t.wi], hrs = parseFloat(r.cells[t.hi]);
    if (!isFinite(hrs)) continue;
    if (/^\d{4}-W\d{2}$/.test(wk)) map[wk] = hrs;
    else if (isDate(wk)) map[isoWeek(wk)] = hrs;
  }
  return map;
}
// Daily hours from the Days table, if the file has one: { "2026-10-22": 9.5 }.
function parseCapacityDays(md) {
  const map = {};
  if (typeof md !== "string") return map;
  const t = dayTable(tablesOf(md.split(/\r?\n/)));
  if (!t) return map;
  for (const r of t.rows) { const d = r.cells[t.di], h = parseFloat(r.cells[t.hi]); if (isDate(d) && isFinite(h)) map[d] = h; }
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
// A day's hours: the Days table in Capacity.md when it has the day, else a seventh of the week.
function availableOnDay(cap, date, fallbackWeekly, days) {
  if (days && typeof days[date] === "number") return days[date];
  const w = isoWeek(date);
  return (w in cap ? cap[w] : fallbackWeekly) / 7;
}
// Share of today's work window still ahead at `nowH` (hours after midnight, e.g. 20.5). Window from the
// capacity rules (weekday 09:00–23:00, weekend 10:00–22:00 by default). No time given → the whole day.
const DEFAULT_WINDOW = { weekday: ["09:00", "23:00"], weekend: ["10:00", "22:00"] };
function dayLeftShare(date, nowH, window) {
  if (typeof nowH !== "number") return 1;
  const w = (window || DEFAULT_WINDOW)[weekdayOf(date) % 6 === 0 ? "weekend" : "weekday"] || DEFAULT_WINDOW.weekday;
  const a = hm(w[0]), b = hm(w[1]);
  if (!(b > a)) return 1;
  return Math.max(0, Math.min(1, (b - nowH) / (b - a)));
}
// Hours available from today to `to` (inclusive): only what's left of today, then whole days.
function hoursUntil(settings, today, to) {
  const cap = settings.capacity || {}, days = settings.capacityDays, fb = settings.defaultWeeklyHours;
  let sum = 0;
  for (let d = today; d <= to; d = addDays(d, 1))
    sum += availableOnDay(cap, d, fb, days) * (d === today ? dayLeftShare(d, settings.nowHours, settings.workWindow) : 1);
  return sum;
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
    byType: {}, rawByType: {}, byProject: {}, rawByProject: {}, tasks: [],
  }));
  const byWeek = Object.fromEntries(weeks.map(w => [w.week, w]));
  const unscheduled = [], beyond = [];
  for (const t of open) {
    const raw = remaining(t), adj = adjusted(t, mults);
    if (raw <= 0 && adj <= 0) continue;
    const s = spread(t, 1, today); // shares of the task per day (sum to 1)
    if (!s) { unscheduled.push(t); continue; }
    const k = typeKey(t), pk = t.project || NO_PROJECT;
    const per = {};
    for (const [d, f] of s) {
      const w = byWeek[isoWeek(d)];
      if (!w) { if (!beyond.includes(t)) beyond.push(t); continue; }
      const h = raw * f, a = adj * f;
      w.raw += h; w.adj += a;
      w.byType[k] = (w.byType[k] || 0) + a;
      w.rawByType[k] = (w.rawByType[k] || 0) + h;
      w.byProject[pk] = (w.byProject[pk] || 0) + a;
      w.rawByProject[pk] = (w.rawByProject[pk] || 0) + h;
      per[w.week] = (per[w.week] || { raw: 0, adj: 0 });
      per[w.week].raw += h; per[w.week].adj += a;
    }
    for (const wk in per) byWeek[wk].tasks.push({ task: t, raw: per[wk].raw, adj: per[wk].adj });
  }
  const threshold = (settings.overloadPct || 85) / 100;
  for (const w of weeks) {
    w.isCurrent = today >= w.start && today <= w.end;
    w.isPast = w.end < today;
    // The spread puts all of this week's remaining work on today…Sunday, so compare it with the hours
    // still ahead (the rest of today, then whole days), not the whole week's total. weekAvailable keeps
    // the full figure from the capacity file for display.
    w.weekAvailable = w.available;
    if (w.isCurrent) w.available = hoursUntil(settings, today, w.end);
    w.pct = w.available > 0 ? w.adj / w.available : (w.adj > 0 ? Infinity : 0);
    w.overloaded = w.pct >= threshold;
    w.tasks.sort((a, b) => b.adj - a.adj);
  }
  // At risk: adjusted remaining hours exceed the hours available between today and the due date.
  const risk = {};
  for (const t of open) {
    const adj = adjusted(t, mults);
    if (!t.due || adj <= 0) continue;
    const overdue = t.due < today;
    const avail = overdue ? 0 : hoursUntil(settings, today, t.due);
    if (overdue || adj > avail) risk[t.path] = { overdue, need: adj, available: avail, days: overdue ? 0 : diffDays(today, t.due) + 1 };
  }
  const byName = new Map(tasks.map(t => [baseName(t.path), t]));
  const urg = urgency(open, byName, cfg, settings, today);
  // Queue: open, not starting in the future; urgency tier (now, tight, normal), then priority, then due,
  // then hours left (largest first).
  const queue = open
    .filter(t => !(t.start && t.start > today))
    .sort((a, b) => urgencyOrder(cfg, mults, urg)(a, b));
  const upcoming = open.filter(t => t.start && t.start > today).length;
  const ready = t => isReady(t, byName, cfg);
  // Next tasks you could pull forward: not started yet, dependencies done; least slack first, as the queue.
  const candidates = open.filter(t => t.start && t.start > today && ready(t)).sort(urgencyOrder(cfg, mults, urg));
  const doneToday = tasks.filter(t => isComplete(cfg, t.status) && t.completed === today).sort((a, b) => a.title.localeCompare(b.title));
  const blocked = new Set(open.filter(t => !ready(t)).map(t => t.path));
  // waiting on an overdue task: an unfinished dependency whose due date has passed
  const waiting = {};
  for (const t of open) {
    const late = (t.deps || []).map(d => byName.get(d)).filter(x => x && !isComplete(cfg, x.status) && x.due && x.due < today);
    if (late.length) waiting[t.path] = late;
  }
  // next 7 days: committed hours (× multipliers) per day against that day's share of the week
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); days.push({ date: d, adj: 0, available: hoursUntil(settings, d === today ? today : d, d) }); }
  const dayIdx = Object.fromEntries(days.map((d, i) => [d.date, i]));
  for (const t of open) {
    const adj = adjusted(t, mults); if (adj <= 0) continue;
    const s = spread(t, adj, today); if (!s) continue;
    for (const [d, hh] of s) if (d in dayIdx) days[dayIdx[d]].adj += hh;
  }
  const over = new Set(open.filter(t => overBudget(t, mults)).map(t => t.path));
  return { today, weeks, risk, queue, urgency: urg, over, upcoming, unscheduled, beyond, measured: measured(tasks, cfg), measuredSeries: measuredSeries(tasks, cfg),
    candidates, doneToday, blocked, waiting, days, board: board(open, cfg, settings, weeks, today, urg) };
}

// ---------- urgency ----------
// Slack = hours available from now to the due date − real hours left (× multiplier). Work a task waits on
// comes out of the same hours, so its slack also subtracts the hours left on its unfinished dependencies
// (all the way up the chain). A dependency gets the smallest slack of anything waiting on it, since it has
// to be done first.
// Tiers: 0 now (overdue, due today/tomorrow, or negative slack), 1 tight (needs at least tightPct % of the
// hours available), 2 normal. Order everywhere: tier, then slack (smallest first), then priority, due date.
const TIERS = ["now", "tight", "normal"];
function urgency(open, byName, cfg, settings, today) {
  const mults = settings.multipliers || {};
  const tight = (settings.tightPct || 50) / 100;
  const isOpen = new Set(open.map(t => t.path));
  const out = {};
  for (const t of open) out[t.path] = { need: adjusted(t, mults), avail: t.due && t.due >= today ? hoursUntil(settings, today, t.due) : 0 };
  // open dependencies, transitively
  const upMemo = {};
  const upstream = (t, seen = new Set()) => {
    if (upMemo[t.path]) return upMemo[t.path];
    const acc = new Set();
    for (const d of t.deps || []) {
      const x = byName.get(d);
      if (!x || !isOpen.has(x.path) || seen.has(x.path)) continue;
      acc.add(x.path); seen.add(x.path);
      for (const y of upstream(x, seen)) acc.add(y);
    }
    return (upMemo[t.path] = acc);
  };
  for (const t of open) {
    const u = out[t.path];
    if (!t.due) { Object.assign(u, { tier: 2, slack: null, reason: "No due date" }); continue; }
    const ups = [...upstream(t)], upNeed = ups.reduce((a, p) => a + out[p].need, 0);
    const slack = u.avail - u.need - upNeed, days = diffDays(today, t.due);
    let tier = 2, reason = `${fmtHours(slack)} slack`;
    if (days < 0) { tier = 0; reason = "Overdue"; }
    else if (days === 0) { tier = 0; reason = "Due today"; }
    else if (days === 1) { tier = 0; reason = "Due tomorrow"; }
    else if (slack < 0) { tier = 0; reason = `Short ${fmtHours(-slack)}${upNeed > 0 ? " with what it waits on" : ""}`; }
    else if (u.avail > 0 && u.need + upNeed >= tight * u.avail) tier = 1;
    Object.assign(u, { tier, slack: days < 0 ? -(u.need + upNeed) : slack, ownSlack: slack, upNeed, reason });
  }
  // Dependencies take the tier and slack of what waits on them, when that is more urgent.
  for (let pass = 0, changed = true; changed && pass < 20; pass++) {
    changed = false;
    for (const t of open) for (const d of t.deps || []) {
      const x = byName.get(d), ux = x && out[x.path], ut = out[t.path];
      if (!ux || !ut || ut.slack == null) continue;
      const tierUp = ut.tier < ux.tier, slackUp = ux.slack == null || ut.slack < ux.slack;
      if (!tierUp && !slackUp) continue;
      if (tierUp) ux.tier = ut.tier;
      if (slackUp) ux.slack = ut.slack;
      ux.reason = `Unblocks ${t.title}` + (ut.tier === 0 || ut.slack < 0 ? "" : ` · ${fmtHours(ux.slack)} slack`);
      ux.via = t.path; changed = true;
    }
  }
  for (const k in out) out[k].label = TIERS[out[k].tier];
  return out;
}
function urgencyOrder(cfg, mults, urg) {
  const tier = t => (urg[t.path] || {}).tier ?? 2;
  const slack = t => { const v = (urg[t.path] || {}).slack; return typeof v === "number" ? v : Infinity; };
  return (a, b) => tier(a) - tier(b) ||
    slack(a) - slack(b) ||
    priorityRank(cfg, a.priority) - priorityRank(cfg, b.priority) ||
    (a.due || "9999").localeCompare(b.due || "9999") ||
    adjusted(b, mults) - adjusted(a, mults) ||
    a.title.localeCompare(b.title);
}
function fmtHours(h) { const r = Math.round(h * 10) / 10; return `${r}h`; }

// Board columns. By week: the week a task is due (overdue, this week onward, later, no due date).
function board(open, cfg, settings, weeks, today, urg) {
  const mults = settings.multipliers || {};
  const order = urgencyOrder(cfg, mults, urg || {});
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


// ---------- projects (progress tracker) ----------
// projects: [{ path, title, icon, color, parent: "[[Project/…/X]]", description }]
function parentPath(link) { const m = typeof link === "string" && link.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/); return m ? m[1].replace(/\.md$/, "") + ".md" : null; }
function projectTree(projects) {
  const byPath = new Map(projects.map(p => [p.path, { ...p, children: [] }]));
  const roots = [];
  for (const p of byPath.values()) {
    const pp = parentPath(p.parent);
    if (pp && byPath.has(pp) && pp !== p.path) byPath.get(pp).children.push(p); else roots.push(p);
  }
  const sort = list => { list.sort((a, b) => a.title.localeCompare(b.title)); for (const x of list) sort(x.children); };
  sort(roots);
  return roots;
}
// Categories for the load chart: one group per top-level project (Studio, Portfolio, a class…), listing the
// group's own tasks first and then every sub-project depth-first. Task projects with no project note become
// their own group; tasks with no project go last.
// → [{ key, title, members: [{ key (project title), title, depth, own }] }]
function categoryGroups(projects, taskProjects) {
  const groups = [], seen = new Set();
  const walk = (node, depth, out) => {
    out.push({ key: node.title, title: node.title, depth, own: depth === 0 && node.children.length > 0 });
    seen.add(node.title);
    for (const c of node.children) walk(c, depth + 1, out);
  };
  for (const root of projectTree(projects || [])) {
    const members = [];
    walk(root, 0, members);
    groups.push({ key: root.title, title: root.title, members });
  }
  const extra = [...new Set((taskProjects || []).filter(p => p && p !== NO_PROJECT && !seen.has(p)))].sort();
  for (const p of extra) groups.push({ key: p, title: p, members: [{ key: p, title: p, depth: 0, own: false }] });
  if ((taskProjects || []).some(p => !p || p === NO_PROJECT)) groups.push({ key: NO_PROJECT, title: "No project", members: [{ key: NO_PROJECT, title: "No project", depth: 0, own: false }] });
  return groups;
}
function taskShare(t, cfg) { return isComplete(cfg, t.status) ? 1 : Math.max(0, Math.min(1, (t.progress || 0) / 100)); }
// How far along a task should be by today: share of its start→due window that has passed.
function plannedShare(t, today) {
  if (!t.due) return null;
  const s = t.start || t.due;
  if (today >= t.due) return 1;
  if (today < s) return 0;
  return (diffDays(s, today) + 1) / (diffDays(s, t.due) + 1);
}
function projectStats(node, tasks, cfg, today, risk) {
  const own = tasks.filter(t => t.project === node.title);
  const kids = node.children.map(c => projectStats(c, tasks, cfg, today, risk));
  const all = own.concat(...kids.map(k => k.all));
  const done = all.filter(t => isComplete(cfg, t.status)).length;
  const open = all.filter(t => !isComplete(cfg, t.status));
  // weights: estimate when known, else 1
  const w = t => (t.estimate > 0 ? t.estimate : 1);
  const W = all.reduce((a, t) => a + w(t), 0);
  const actual = W ? all.reduce((a, t) => a + w(t) * taskShare(t, cfg), 0) / W : 0;
  const dated = all.filter(t => t.due);
  const WD = dated.reduce((a, t) => a + w(t), 0);
  const planned = WD ? dated.reduce((a, t) => a + w(t) * plannedShare(t, today), 0) / WD : null;
  const overdue = open.filter(t => t.due && t.due < today);
  const atRisk = open.filter(t => risk && risk[t.path]);
  const milestones = all.filter(t => t.type === "milestone").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"))
    .map(t => ({ task: t, state: isComplete(cfg, t.status) ? "done" : t.due && t.due < today ? "missed" : "upcoming" }));
  const nextDue = open.filter(t => t.due && t.due >= today).sort((a, b) => a.due.localeCompare(b.due))[0] || null;
  const lastDue = dated.map(t => t.due).sort().pop() || null;
  const gap = planned == null ? 0 : actual - planned;
  const health = !all.length ? "empty" : !open.length ? "done" : overdue.length || gap < -0.25 ? "behind" : atRisk.length || gap < -0.1 ? "watch" : "on-track";
  return {
    node, own, all, kids, total: all.length, done, open: open.length, actual, planned, gap, health,
    overdue, atRisk, milestones, nextDue, lastDue,
    logged: all.reduce((a, t) => a + t.logged, 0), estimate: all.reduce((a, t) => a + (t.estimate || 0), 0),
  };
}

// ---------- quick-add ----------
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function weekdayOf(d) { return new Date(toDay(d) * DAY).getUTCDay(); }
function nextWeekday(today, idx) { const n = (idx - weekdayOf(today) + 7) % 7; return addDays(today, n); }
function dateFromMonthDay(today, m, d) {
  const y = Number(today.slice(0, 4));
  const pad = n => String(n).padStart(2, "0");
  let s = `${y}-${pad(m)}-${pad(d)}`;
  if (!isDate(s) || isNaN(toDay(s))) return null;
  if (s < addDays(today, -60)) s = `${y + 1}-${pad(m)}-${pad(d)}`; // "jan 5" in December means next year
  return s;
}
// "render toaster hero shot fri 3h p1 #cad" → { title, project, due, estimate, priority, workType, tags }
function parseQuickAdd(text, ctx) {
  const today = ctx.today, out = { title: "", project: null, due: null, start: null, estimate: null, priority: null, workType: null, tags: [] };
  let rest = " " + String(text || "").trim() + " ";
  // project: @name (fuzzy) or a full project title in the text (longest first)
  const projects = (ctx.projects || []).slice().sort((a, b) => b.length - a.length);
  const at = rest.match(/\s@([^\s]+)/);
  if (at) {
    const q = at[1].toLowerCase();
    const hit = projects.find(p => p.toLowerCase() === q) || projects.find(p => p.toLowerCase().replace(/\s+/g, "").startsWith(q)) || projects.find(p => p.toLowerCase().includes(q));
    if (hit) { out.project = hit; rest = rest.replace(at[0], " "); }
  }
  if (!out.project) for (const p of projects) {
    const re = new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s)`, "i");
    if (re.test(rest)) { out.project = p; break; } // keep the word in the title ("render toaster hero")
  }
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { const r = fn(...m); return r === false ? m[0] : " "; }); };
  take(/\s(\d+(?:\.\d+)?)\s?(h|hr|hrs|hours?)(?=\s)/i, (m, n) => { out.estimate = parseFloat(n); });
  if (out.estimate == null) take(/\s(\d+)\s?(m|min|mins|minutes?)(?=\s)/i, (m, n) => { out.estimate = Math.round(parseFloat(n) / 6) / 10; });
  take(/\sp([1-4])(?=\s)/i, (m, n) => { const p = (ctx.priorities || [])[Number(n) - 1]; if (!p) return false; out.priority = p; });
  take(/\s#([^\s#]+)/g, (m, tag) => {
    const wt = (ctx.workTypes || []).find(w => w.toLowerCase() === tag.toLowerCase());
    if (wt && !out.workType) out.workType = wt; else out.tags.push(tag);
  });
  // dates
  const setDue = d => { if (d && !out.due) out.due = d; };
  take(/\s(today|tod)(?=\s)/i, () => setDue(today));
  take(/\s(tomorrow|tmr|tom)(?=\s)/i, () => setDue(addDays(today, 1)));
  take(/\s\+(\d+)\s?([dw])(?=\s)/i, (m, n, u) => setDue(addDays(today, Number(n) * (u.toLowerCase() === "w" ? 7 : 1))));
  take(/\s(next\s+week)(?=\s)/i, () => setDue(addDays(mondayOf(addDays(today, 7)), 4)));
  take(/\s([a-z]{3,9})\.?\s+(\d{1,2})(?=\s)/i, (m, mon, d) => { const i = MONTHS3.indexOf(mon.slice(0, 3).toLowerCase()); if (i === -1) return false; const r = dateFromMonthDay(today, i + 1, Number(d)); if (!r) return false; setDue(r); });
  take(/\s(\d{1,2})\s+([a-z]{3,9})(?=\s)/i, (m, d, mon) => { const i = MONTHS3.indexOf(mon.slice(0, 3).toLowerCase()); if (i === -1) return false; const r = dateFromMonthDay(today, i + 1, Number(d)); if (!r) return false; setDue(r); });
  take(/\s(\d{1,2})\/(\d{1,2})(?=\s)/, (m, mo, d) => { const r = dateFromMonthDay(today, Number(mo), Number(d)); if (!r) return false; setDue(r); });
  take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/, (m, d) => { if (!isDate(d)) return false; setDue(d); });
  take(/\s(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?(?=\s)/i, (m, d) => setDue(nextWeekday(today, WEEKDAYS.indexOf(d.slice(0, 3).toLowerCase()))));
  // a work-type tag that names a project files the task there (#fun → Fun)
  if (!out.project && out.workType) out.project = projects.find(p => p.toLowerCase() === out.workType.toLowerCase()) || null;
  const title = rest.replace(/\s+/g, " ").trim();
  out.title = title ? title[0].toUpperCase() + title.slice(1) : "";
  return out;
}

// ---------- time log input ----------
// "2h", "1.5", "90m", "1h30m", "2h -- note", "2h fixed the hinge"
// Time log input: an amount, a time range, or both, then an optional note.
//   "1.5"  "1h30m glued legs"  "45m"            → ends now (when you log it), starts that long before
//   "2-3:30pm sanding"  "14:00-15:30"  "9am–noon" → that range; hours from the range
//   "1.5 at 2pm"  "2h from 14:00"                 → starts then, ends that much later
// `nowMin` = minutes after midnight (defaults to the whole-day case with no times).
// Returns { hours, note, start, end, dayOffset } — start/end "HH:MM"; dayOffset -1 when the work began yesterday.
const CLOCK = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)`;
function clockMin(txt, pmHint) {
  const s = String(txt).trim().toLowerCase();
  if (s === "noon") return 12 * 60;
  if (s === "midnight") return 0;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]); const mi = m[2] ? Number(m[2]) : 0;
  const ap = m[3] ? m[3][0] : pmHint || null;
  if (mi > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h * 60 + mi;
}
function hasMeridiem(txt) { return /(am|pm|a|p)\s*$/i.test(String(txt).trim()) || /^(noon|midnight)$/i.test(String(txt).trim()); }
function fmtClock(min) { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
// YAML may give "13:56", or a number if an old parser read it as base-60 (13:56 → 836).
function normClock(v) {
  if (typeof v === "number" && isFinite(v) && v >= 0 && v < 1440) return fmtClock(v);
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
function parseLogInput(text, nowMin) {
  let s = String(text || "").trim();
  let hours = null, startMin = null, endMin = null;
  // a range at the start: "2-3:30pm", "14:00–15:30", "9am to noon"
  const range = s.match(new RegExp(String.raw`^${CLOCK}\s*(?:-|–|—|to)\s*${CLOCK}(?=\s|$)\s*(?:--\s*)?`, "i"));
  if (range) {
    const [a, b] = [range[1], range[2]];
    // a bare "2-4" reads as a range only if one end has a colon or am/pm
    if (/[:apn]/i.test(a + b)) {
      const bM = hasMeridiem(b) ? (b.trim().toLowerCase().match(/(a|p)m?$/) || [])[1] : null;
      startMin = clockMin(a, hasMeridiem(a) ? null : bM);
      endMin = clockMin(b, null);
      if (startMin == null || endMin == null) return null;
      let len = endMin - startMin; if (len <= 0) len += 1440; // past midnight
      hours = len / 60;
      s = s.slice(range[0].length);
    }
  }
  if (hours == null) {
    const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in)?)?|(\d+)\s*m(?:in)?|(\d+(?:\.\d+)?))(?=\s|$)\s*/i);
    if (!m) return null;
    hours = m[1] != null ? parseFloat(m[1]) + (m[2] ? Number(m[2]) / 60 : 0) : m[3] != null ? Number(m[3]) / 60 : parseFloat(m[4]);
    s = s.slice(m[0].length);
    const at = s.match(new RegExp(String.raw`^(?:at|from|@)\s*${CLOCK}(?=\s|$)\s*`, "i"));
    if (at) { startMin = clockMin(at[1], null); if (startMin == null) return null; s = s.slice(at[0].length); }
  }
  if (!(hours > 0) || hours > 24) return null;
  hours = Math.round(hours * 100) / 100;
  const note = s.replace(/^--\s*/, "").trim();
  const out = { hours, note };
  if (startMin == null && typeof nowMin === "number") { endMin = nowMin; startMin = nowMin - hours * 60; }
  if (startMin != null) {
    if (endMin == null) endMin = startMin + hours * 60;
    out.dayOffset = startMin < 0 ? -1 : 0;
    out.start = fmtClock(startMin); out.end = fmtClock(endMin);
  }
  return out;
}
function describeLog(v) {
  if (!v) return "";
  const when = v.start ? `${v.dayOffset ? "yesterday" : "today"} ${v.start}–${v.end}` : "today";
  return `${v.hours}h, ${when}${v.note ? ` — “${v.note}”` : ""}`;
}

// ---------- quick capacity ----------
// One line that changes a day's available hours:
//   "-1.5 sleep"  "-3 thu dentist"  "+2 sat crunch"  "-45m nap"  "off fri sick"  "undo"
// Day words: today (default), tomorrow, yesterday, mon…sun (next one, today included), nov 9, 11/9, 2026-11-09.
function parseCapacityInput(text, today) {
  let rest = " " + String(text || "").trim() + " ";
  if (/^\s*undo\s*$/i.test(rest)) return { kind: "undo" };
  const out = { kind: null, hours: null, date: null, reason: "" };
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { const r = fn(...m); return r === false ? m[0] : " "; }); };
  take(/\s(off|day\s+off)(?=\s)/i, () => { out.kind = "off"; });
  if (!out.kind) {
    // -1.5, -1.5h, +2 hours, -45m, -1h30m
    take(/\s([+\-−])\s?(\d+(?:\.\d+)?)\s?(h|hrs?|hours?|m|mins?|minutes?)?(?:\s?(\d+)\s?(?:m|mins?|minutes?))?(?=\s)/i, (m, sign, n, u, n2) => {
      if (out.hours != null) return false;
      const isMin = !!u && /^m/i.test(u);
      if (isMin && n2) return false;
      if (n2 && !u) return false;
      const h = isMin ? Number(n) / 60 : parseFloat(n) + (n2 ? Number(n2) / 60 : 0);
      out.hours = h * (sign === "+" ? 1 : -1); out.kind = "adjust";
    });
  }
  if (!out.kind) return null;
  const setDate = d => { if (!d || out.date) return false; out.date = d; };
  take(/\s(today|tod)(?=\s)/i, () => setDate(today));
  take(/\s(tomorrow|tmr|tom)(?=\s)/i, () => setDate(addDays(today, 1)));
  take(/\s(yesterday|yday)(?=\s)/i, () => setDate(addDays(today, -1)));
  take(/\s([a-z]{3,9})\.?\s+(\d{1,2})(?=\s)/i, (m, mon, d) => { const i = MONTHS3.indexOf(mon.slice(0, 3).toLowerCase()); if (i === -1) return false; return setDate(dateFromMonthDay(today, i + 1, Number(d))); });
  take(/\s(\d{1,2})\/(\d{1,2})(?=\s)/, (m, mo, d) => setDate(dateFromMonthDay(today, Number(mo), Number(d))));
  take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/, (m, d) => isDate(d) ? setDate(d) : false);
  take(/\s(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?(?=\s)/i, (m, d) => setDate(nextWeekday(today, WEEKDAYS.indexOf(d.slice(0, 3).toLowerCase()))));
  out.date = out.date || today;
  out.reason = rest.replace(/\s+/g, " ").trim();
  if (out.kind === "adjust") { out.hours = Math.round(out.hours * 100) / 100; if (!out.hours || Math.abs(out.hours) > 24) return null; }
  return out;
}
// Usable hours of a day under the rules (window minus meals); the most a day can hold.
function hm(s) { const [h, m] = String(s).split(":").map(Number); return h + (m || 0) / 60; }
function dayUsable(rules, date) {
  const w = rules && rules.window && rules.window[weekdayOf(date) % 6 === 0 ? "weekend" : "weekday"];
  if (!w) return 24;
  return Math.max(0, hm(w[1]) - hm(w[0]) - (rules.mealsHours != null ? rules.mealsHours : 2));
}
const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(d) { return `${DOW3[weekdayOf(d)]} ${MON3[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`; }
function fmtH(h) { const r = Math.round(h * 100) / 100; return (r < 0 ? "−" : "") + Math.abs(r); }
function signed(h) { return (h > 0 ? "+" : h < 0 ? "−" : "") + Math.abs(Math.round(h * 100) / 100); }
// The capacity note a change leaves in Capacity.md and the script repeats on rebuild: "Thu Oct 22: −3 h dentist".
function adjustmentNote(a) { return a.kind === "off" ? `${dayLabel(a.date)}: ${a.reason || "day off"}` : `${dayLabel(a.date)}: ${signed(a.hours)} h${a.reason ? " " + a.reason : ""}`; }
// What a change does: dayBefore/dayAfter (hours that day), applied (the real change after clamping to 0…usable).
// days: parseCapacityDays result; weekly: parseCapacity result; fallbackWeekly when the week is missing.
function planAdjustment(a, ctx) {
  const week = isoWeek(a.date);
  const weekBefore = week in ctx.weekly ? ctx.weekly[week] : ctx.fallbackWeekly;
  const usable = dayUsable(ctx.rules, a.date);
  const fromDays = a.date in ctx.days;
  const dayBefore = fromDays ? ctx.days[a.date] : Math.min(usable, weekBefore / 7);
  const offAlready = ((ctx.rules && ctx.rules.holidays) || []).some(h => h.date === a.date);
  let dayAfter = a.kind === "off" ? 0 : Math.max(0, Math.min(usable, dayBefore + a.hours));
  if (offAlready) dayAfter = 0;
  const applied = Math.round((dayAfter - dayBefore) * 100) / 100;
  return { week, weekBefore, weekAfter: Math.round((weekBefore + applied) * 100) / 100, usable, dayBefore, dayAfter, applied, estimated: !fromDays, offAlready,
    clamped: a.kind === "adjust" && Math.abs(applied - a.hours) > 0.001 };
}
// Rules file entries. Script reads "adjustments" ({date, hours, reason}) and "holidays" ({date, note}); the
// extra "added" and "applied" fields let Undo find and reverse the change.
function addToRules(rules, a, applied, added) {
  const r = JSON.parse(JSON.stringify(rules || {}));
  if (a.kind === "off") (r.holidays = r.holidays || []).push({ date: a.date, note: a.reason || "day off", added, applied, by: "quick-capacity" });
  else (r.adjustments = r.adjustments || []).push({ date: a.date, hours: a.hours, reason: a.reason, added, applied });
  return r;
}
// Remove the newest entry Quick capacity added. Returns { rules, removed: { kind, date, hours, reason, applied } } or null.
function removeLastFromRules(rules) {
  const r = JSON.parse(JSON.stringify(rules || {}));
  let best = null;
  (r.adjustments || []).forEach((x, i) => { if (x.added && (!best || x.added >= best.x.added)) best = { list: "adjustments", i, x }; });
  (r.holidays || []).forEach((x, i) => { if (x.added && x.by === "quick-capacity" && (!best || x.added >= best.x.added)) best = { list: "holidays", i, x }; });
  if (!best) return null;
  r[best.list].splice(best.i, 1);
  const x = best.x;
  return { rules: r, removed: { kind: best.list === "holidays" ? "off" : "adjust", date: x.date, hours: x.hours, reason: best.list === "holidays" ? x.note : x.reason, applied: Number(x.applied) || 0 } };
}
function fmtCell(h) { return String(Math.round(h * 100) / 100); }
function noteCell(cell, add, remove) {
  let parts = String(cell || "").split(/\s*;\s*/).filter(Boolean);
  if (remove) { const i = parts.indexOf(remove); if (i !== -1) parts.splice(i, 1); }
  if (add) parts.push(add);
  return parts.join("; ");
}
// Change Capacity.md in place: the week's Available hours (and Adjusted, Notes), and the day's row in the Days
// table if there is one. delta = hours added (negative = lost). addNote / removeNote: note text for both rows.
function applyCapacityDelta(md, date, delta, addNote, removeNote) {
  const nl = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const tables = tablesOf(lines);
  const put = (r, cells) => { lines[r.line] = "| " + cells.join(" | ") + " |"; };
  const w = weekTable(tables);
  let found = false;
  if (w) {
    const ai = w.head.findIndex(c => c.startsWith("adjust")), ni = w.head.findIndex(c => c.startsWith("note"));
    const row = w.rows.find(r => r.cells[w.wi] === isoWeek(date) || (isDate(r.cells[w.wi]) && isoWeek(r.cells[w.wi]) === isoWeek(date)));
    if (row) {
      const c = row.cells.slice(); while (c.length < w.head.length) c.push("");
      const v = parseFloat(c[w.hi]); c[w.hi] = fmtCell(Math.max(0, (isFinite(v) ? v : 0) + delta));
      if (ai !== -1) { const a = parseFloat(c[ai]) || 0; c[ai] = fmtCell(a + delta); }
      if (ni !== -1) c[ni] = noteCell(c[ni], addNote, removeNote);
      put(row, c); found = true;
    }
  }
  const d = dayTable(tables);
  if (d) {
    const ai = d.head.findIndex(c => c.startsWith("adjust")), ni = d.head.findIndex(c => c.startsWith("note"));
    const row = d.rows.find(r => r.cells[d.di] === date);
    if (row) {
      const c = row.cells.slice(); while (c.length < d.head.length) c.push("");
      const v = parseFloat(c[d.hi]); c[d.hi] = fmtCell(Math.max(0, (isFinite(v) ? v : 0) + delta));
      if (ai !== -1) { const a = parseFloat(c[ai]) || 0; c[ai] = fmtCell(a + delta); }
      if (ni !== -1) c[ni] = noteCell(c[ni], addNote && addNote.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d+: /, ""), removeNote && removeNote.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d+: /, ""));
      put(row, c);
    }
  }
  return { text: lines.join(nl), found };
}
function capacityLogRow(when, a, plan, undo) {
  const what = a.kind === "off" ? "day off" : `${signed(plan.applied)} h`;
  return `| ${when} | Capacity | — | ${dayLabel(a.date)} ${undo ? "undo " : ""}${what} (${plan.week} ${fmtH(plan.weekBefore)} → ${fmtH(plan.weekAfter)} h) | Quick capacity${a.reason ? ": " + esc(a.reason) : ""} |`;
}

// ---------- schedule change log ----------
// prev/cur: { start, due }. Returns a list of { field, from, to }.
function dateChanges(prev, cur) {
  const out = [];
  for (const f of ["start", "due"]) if ((prev[f] || null) !== (cur[f] || null)) out.push({ field: f, from: prev[f] || null, to: cur[f] || null });
  return out;
}
function describeChange(ch) { return ch.map(c => `${c.field} ${c.from ? c.from.slice(5) : "—"} → ${c.to ? c.to.slice(5) : "—"}`).join(", "); }
// group: [{ task, changes, reason }], first = cause. Returns table rows for Schedule log.md.
function scheduleRows(group, when) {
  if (!group.length) return [];
  const first = group[0];
  const rows = [];
  const why = (g, i) => g.reason ? g.reason : i === 0 ? (group.length > 1 ? "changed; moved the tasks below" : "moved by hand") : `knock-on from ${first.task.title}`;
  group.forEach((g, i) => rows.push(`| ${when} | ${esc(g.task.title)} | ${esc(g.task.project || "")} | ${describeChange(g.changes)} | ${esc(why(g, i))} |`));
  return rows;
}
function esc(s) { return String(s).replace(/\|/g, "\\|"); }
const SCHEDULE_HEADER = "# Schedule log\n\nWritten by the dotpm Companion: every change to a task's start or due date, newest first. Changes within a couple of seconds are grouped; the first is the cause.\n\n| When | Task | Project | Change | Cause |\n| --- | --- | --- | --- | --- |\n";
function prependRows(md, header, rows) {
  if (!md || !md.includes("| --- |")) return header + rows.join("\n") + "\n";
  const i = md.indexOf("\n", md.indexOf("| --- |")) + 1;
  return md.slice(0, i) + rows.join("\n") + "\n" + md.slice(i);
}

// ---------- spillover ----------
// Tasks due in the week before weekStart that aren't done.
function spillover(tasks, cfg, weekStart) {
  const from = addDays(weekStart, -7), to = addDays(weekStart, -1);
  return tasks.filter(t => t.due && t.due >= from && t.due <= to && !isComplete(cfg, t.status))
    .sort((a, b) => a.due.localeCompare(b.due));
}
const SPILLOVER_HEADER = "# Spillover\n\nWritten by the dotpm Companion each Monday: tasks due last week that weren't done, with the hours left. Newest first.\n\n| Week | Task | Project | Was due | Hours left |\n| --- | --- | --- | --- | --- |\n";
function spilloverRows(list, week) {
  if (!list.length) return [`| ${week} | (nothing spilled over) |  |  |  |`];
  return list.map(t => `| ${week} | ${esc(t.title)} | ${esc(t.project || "")} | ${t.due} | ${Math.round(remaining(t) * 10) / 10} |`);
}

// ---------- project templates ----------
// A template note has a table: | Task | Work type | Hours | Start day | Days | After | Done when |
// Start day = days after the project start (0 = first day); After = task names (comma separated) it waits on.
function parseTemplate(md) {
  const lines = String(md || "").split(/\r?\n/).filter(l => /^\s*\|/.test(l));
  if (lines.length < 2) return [];
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const head = cells(lines[0]).map(c => c.toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const ci = { task: col("task", "title"), type: col("work", "type"), hours: col("hour", "estimate"), start: col("start"), days: col("day"), after: col("after", "depend"), done: col("done") };
  if (ci.days === ci.start) ci.days = head.findIndex((h, i) => h.includes("day") && i !== ci.start);
  const out = [];
  for (const l of lines.slice(1)) {
    const c = cells(l);
    if (c.every(x => /^:?-+:?$/.test(x) || !x)) continue;
    const title = c[ci.task];
    if (!title) continue;
    out.push({
      title, workType: ci.type >= 0 ? c[ci.type] || null : null,
      hours: ci.hours >= 0 && isFinite(parseFloat(c[ci.hours])) ? parseFloat(c[ci.hours]) : null,
      startDay: ci.start >= 0 && isFinite(parseInt(c[ci.start])) ? parseInt(c[ci.start]) : 0,
      days: ci.days >= 0 && isFinite(parseInt(c[ci.days])) ? Math.max(1, parseInt(c[ci.days])) : 1,
      after: ci.after >= 0 && c[ci.after] ? c[ci.after].split(/\s*,\s*/).filter(Boolean) : [],
      doneWhen: ci.done >= 0 && c[ci.done] ? c[ci.done].split(/\s*;\s*/).filter(Boolean) : [],
    });
  }
  return out;
}
function templateTasks(rows, projectStart) {
  return rows.map(r => ({ ...r, start: addDays(projectStart, r.startDay), due: addDays(projectStart, r.startDay + r.days - 1) }));
}


// ---------- file fallbacks (used only when dotpm's store isn't available) ----------
function slug(title) { return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "task"; }
function yq(v) { return JSON.stringify(String(v)); }
function taskFile(t, projectTitle) {
  const fm = ["---", "pm-task: true", `projectId: ${yq(`[[${projectTitle}|${projectTitle}]]`)}`, "parentId:", `id: ${yq(t.id)}`, `title: ${yq(t.title)}`, `type: "task"`,
    `status: ${yq(t.status)}`, `priority: ${yq(t.priority)}`, `start: ${yq(t.start)}`, `due: ${yq(t.due)}`, "progress: 0", "assignees: []",
    `tags: [${(t.tags || []).map(yq).join(", ")}]`, "subtaskIds: []", "dependencies: []", `createdAt: ${yq(t.createdAt)}`, `updatedAt: ${yq(t.updatedAt)}`];
  if (t.timeEstimate != null) fm.push(`timeEstimate: ${t.timeEstimate}`);
  const cf = Object.entries(t.customFields || {});
  if (cf.length) { fm.push("customFields:"); for (const [k, v] of cf) fm.push(`  ${k}: ${yq(v)}`); }
  fm.push("---");
  return fm.join("\n") + "\n\n" + (t.description ? t.description + "\n\n" : "") + `Project: [[${projectTitle}|${projectTitle}]]\n`;
}
// Add one entry to the timeLogs list in the frontmatter (block style), creating the key if needed.
function appendTimeLog(text, log) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = m[1].split(/\r?\n/);
  const entry = [`  - date: ${log.date}`, `    hours: ${log.hours}`, `    note: ${yq(log.note || "")}`,
    ...(log.start ? [`    start: "${log.start}"`] : []), ...(log.end ? [`    end: "${log.end}"`] : [])];
  let i = lines.findIndex(l => /^timeLogs:/.test(l));
  if (i === -1) lines.push("timeLogs:", ...entry);
  else {
    if (/^timeLogs:\s*\[\s*\]\s*$/.test(lines[i])) lines[i] = "timeLogs:";
    let j = i + 1; while (j < lines.length && /^\s+/.test(lines[j])) j++;
    lines.splice(j, 0, ...entry);
  }
  return `---${nl}${lines.join(nl)}${nl}---` + text.slice(m[0].length);
}
const EXAMPLE_TEMPLATE = `# Case study template

Used by **dotpm Companion → New project from template**. Each row becomes a task.
*Start day* counts from the project's start date (0 = first day), *Days* is how long it runs,
*After* lists tasks it waits on (comma separated), *Done when* items are separated by semicolons.

| Task | Work type | Hours | Start day | Days | After | Done when |
| --- | --- | --- | --- | --- | --- | --- |
| Brief and framing | Writing | 4 | 0 | 4 |  | Angle written; persona; positioning map |
| Research and references | Research | 4 | 0 | 4 |  | Competitors and references collected |
| Form concepting | Concepting | 8 | 4 | 5 | Brief and framing | Sketches scanned; direction chosen |
| CAD | CAD | 12 | 9 | 7 | Form concepting | Assembly complete; ready to render |
| Prototype | Fabrication | 6 | 16 | 4 | CAD | Printed or built; photographed |
| Renders | Render | 10 | 16 | 5 | CAD | Hero; exploded; in context |
| Decision notes | Writing | 4 | 16 | 5 | CAD | 3–4 notes that explain why |
| Case study page | Concepting | 8 | 21 | 4 | Renders, Decision notes, Prototype | Page published; 30-second test passes |
`;

// Frontmatter straight from the file text, for when Obsidian's metadata cache isn't ready yet.
function frontmatterOf(text, parseYaml) {
  const mm = typeof text === "string" && text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!mm || typeof parseYaml !== "function") return null;
  try { const v = parseYaml(mm[1]); return v && typeof v === "object" ? v : null; } catch (e) { return null; }
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
  bodyOf, setFrontmatterLines, frontmatterOf,
  NO_TYPE, NO_PROJECT, DEFAULT_MULTIPLIER, categoryGroups, DUE_SORT, isDefaultSort,
  isDate, normDate, toDay, fromDay, addDays, diffDays, mondayOf, isoWeek, localToday,
  readDotpmConfig, isComplete, doneStatusId, priorityRank, label,
  linkText, parseChecklist, checklistProgress, parseTask,
  typeKey, multiplierFor, remaining, adjusted, overBudget, urgency, urgencyOrder, TIERS, recordMultiplier, ensureMultipliers, multiplierOn, measured,
  parseCapacity, capacityTemplate, weeksInRange, spread, compute, availableOnDay, dayLeftShare, hoursUntil,
  linkTarget, baseName, isReady, measuredSeries, board, shiftToWeek,
  parentPath, projectTree, projectStats, plannedShare, parseQuickAdd, parseLogInput,
  dateChanges, describeChange, scheduleRows, SCHEDULE_HEADER, prependRows, spillover, SPILLOVER_HEADER, spilloverRows,
  parseTemplate, templateTasks, slug, taskFile, appendTimeLog, EXAMPLE_TEMPLATE,
  parseCapacityDays, parseCapacityInput, describeLog, normClock, fmtClock, dayUsable, dayLabel, adjustmentNote, planAdjustment, addToRules, removeLastFromRules,
  applyCapacityDelta, capacityLogRow,
};
