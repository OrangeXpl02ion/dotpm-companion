"use strict";
// DOM rendering. Plain DOM only (no Obsidian helpers) so it can be rendered in a browser for testing.
const M = require("./model");

const SVGNS = "http://www.w3.org/2000/svg";
function h(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : doc.createTextNode(String(c)));
  return el;
}
function s(doc, tag, attrs, ...kids) {
  const el = doc.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : doc.createTextNode(String(c)));
  return el;
}
const fmtH = n => (n >= 9.95 ? Math.round(n) : Math.round(n * 10) / 10) + "h";
const fmtX = n => { const c = Math.round(n * 100); return (c / 100).toFixed(c % 10 ? 2 : 1) + "×"; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = d => { const [, m, dd] = d.split("-").map(Number); return `${MONTHS[m - 1]} ${dd}`; };
function relDue(due, today) {
  if (!due) return "—";
  const n = M.diffDays(today, due);
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `${fmtD(due)} · ${n}d`;
}

// Fixed categorical order = the work-type option order in dotpm. "No work-type" is neutral gray.
function typeKeys(cfg) { return [...cfg.workTypes, ...(cfg.extraTypes || []), M.NO_TYPE]; }
function typeName(k, cfg) { return k === M.NO_TYPE ? "No work-type" : cfg && (cfg.extraTypes || []).includes(k) ? `${k} (not in dotpm's list)` : k; }
function typeColor(cfg, k) {
  const i = cfg.workTypes.indexOf(k);
  return i === -1 ? "var(--dpc-none)" : i < 9 ? `var(--dpc-s${i + 1})` : "var(--dpc-none)";
}

// ---------- shell ----------
const TABS = [["dotpm", "dotpm"], ["board", "Board"], ["projects", "Projects"], ["capacity", "Capacity"], ["types", "Work types"], ["multipliers", "Multipliers"], ["time", "Time"]];
function render(root, st, on) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.classList.add("dpc-root");
  root.classList.toggle("dpc-embed", st.tab === "dotpm");
  const bar = h(doc, "div", { class: "dpc-bar" },
    h(doc, "div", { class: "dpc-tabs", role: "tablist" }, TABS.map(([id, name]) =>
      h(doc, "button", { class: "dpc-tab" + (st.tab === id ? " is-active" : ""), role: "tab", "aria-selected": st.tab === id, onclick: () => on.setTab(id) }, name))),
    (st.tab === "board" && st.settings.boardMode !== "week") || st.tab === "types"
      ? h(doc, "div", { class: "dpc-seg", role: "group", "aria-label": "Hours shown" },
          [["adj", "× multipliers"], ["raw", "Raw estimates"]].map(([id, name]) =>
            h(doc, "button", { class: "dpc-seg-btn" + (st.mode === id ? " is-active" : ""), "aria-pressed": st.mode === id, onclick: () => on.setMode(id) }, name)))
      : null,
    gitChip(doc, st.git, on));
  root.append(bar);
  if (st.tab === "dotpm") { renderDotpm(root, st, on); return; }
  if (!st.result) { root.append(h(doc, "p", { class: "dpc-muted" }, "Reading tasks…")); return; }
  const body = h(doc, "div", { class: "dpc-body" });
  root.append(body);
  ({ board: renderBoard, projects: renderProjects, capacity: renderCapacity, types: renderTypes, multipliers: renderMultipliers, time: renderTime }[st.tab] || renderBoard)(body, st, on);
}

// Push status beside the tabs (hidden when the vault isn't a Git repository or on mobile).
function gitChip(doc, g, on) {
  if (!g || g.state === "none") return h(doc, "span", { class: "dpc-git-chip dpc-git-none" });
  const icon = { synced: "\u2713", pending: "\u2191", stale: "!", behind: "\u2193", noremote: "\u2013", error: "!" }[g.state] || "";
  return h(doc, "button", { class: `dpc-git-chip dpc-git-${g.state}`, title: g.detail || "", "aria-label": `${g.text}. ${g.detail || ""}`,
    onclick: () => on.gitSync && on.gitSync() }, h(doc, "span", { class: "dpc-git-dot", "aria-hidden": "true" }, icon), g.text);
}
function taskLink(doc, t, on) {
  return h(doc, "a", { class: "dpc-task-link", href: "#", onclick: e => { e.preventDefault(); on.openTask(t.path); } }, t.title);
}
function riskBadge(doc, r) {
  if (!r) return null;
  const tip = r.overdue ? "Past its due date with work left" : `Needs ${fmtH(r.need)} (with multiplier) in ${r.days} day${r.days === 1 ? "" : "s"}; ${fmtH(r.available)} available`;
  return h(doc, "span", { class: "dpc-badge dpc-badge-risk", title: tip }, h(doc, "span", { class: "dpc-badge-icon", "aria-hidden": "true" }, "!"), r.overdue ? "Overdue" : "At risk");
}

// Why a task sits where it does in the queue: its urgency tier and the reason.
function urgencyChip(doc, u, compact) {
  if (!u || (compact && u.tier === 2)) return null;
  const name = ["Now", "Tight", ""][u.tier];
  const tip = u.slack == null ? "No due date" : `${fmtH(u.need)} left with multiplier; ${fmtH(u.need + u.slack)} available before it's due`;
  return h(doc, "span", { class: `dpc-urg dpc-urg-${u.label}`, title: tip }, name ? h(doc, "strong", {}, name) : null, name ? " · " : null, u.reason);
}
function byUrgency(st) { return M.urgencyOrder(st.cfg, st.settings.multipliers || {}, (st.result && st.result.urgency) || {}); }
function overBadge(doc, over) {
  return over ? h(doc, "span", { class: "dpc-badge dpc-badge-over", title: "Logged time has reached estimate × multiplier. Re-estimate what's left." }, h(doc, "span", { class: "dpc-badge-icon", "aria-hidden": "true" }, "+"), "Over budget") : null;
}

// ---------- dotpm ----------
// dotpm's own project view (table, Gantt, Kanban) hosted in this tab; see CompanionView.mountDotpm.
function renderDotpm(root, st, on) {
  const doc = root.ownerDocument;
  const fallback = msg => root.append(h(doc, "div", { class: "dpc-note" },
    h(doc, "p", {}, "dotpm couldn't be shown inside the companion", msg ? `: ${msg}` : ".", " You can still open it in its own tab."),
    h(doc, "button", { class: "mod-cta", onclick: () => on.openDotpmTab() }, "Open dotpm")));
  if (st.dotpmError) { fallback(st.dotpmError); return; }
  const host = h(doc, "div", { class: "dpc-embed-host" });
  root.append(host);
  try { on.mountDotpm(host); } catch (e) { host.remove(); fallback(e && e.message); }
}

// ---------- capacity ----------
function renderCapacity(body, st, on) {
  const doc = body.ownerDocument, R = st.result;
  const cur = R.weeks.find(w => w.isCurrent);
  const riskCount = Object.keys(R.risk).length;
  const over = R.weeks.filter(w => w.overloaded && !w.isPast).length;
  body.append(h(doc, "div", { class: "dpc-tiles" },
    tile(doc, "This week", cur ? `${fmtH(cur.adj)} of ${fmtH(cur.available)} left` : "—", cur ? `${Math.round(cur.pct * 100)}% committed · week total ${fmtH(cur.weekAvailable)}` : "outside the planning range"),
    tile(doc, "Overloaded weeks", String(over), `at ${st.settings.overloadPct}% or more`),
    tile(doc, "At risk", String(riskCount), riskCount ? "see the list below" : "nothing at risk")));

  if (on.quickCapacity) body.append(h(doc, "div", { class: "dpc-toolbar" },
    h(doc, "span", { class: "dpc-muted" }, "Slept in, lost an afternoon or working extra? Change a day's hours; the calendar rebuild keeps it."),
    h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.quickCapacity(), title: "Change a day's available hours (press C; command: Quick capacity)" }, "± Change hours")));

  const noFile = R.weeks.every(w => !w.fromFile);
  if (noFile) body.append(h(doc, "div", { class: "dpc-note" },
    `No ${st.settings.capacityFile} found, so every week uses the default of ${st.settings.defaultWeeklyHours}h. `,
    h(doc, "button", { class: "mod-cta dpc-small", onclick: () => on.createCapacity() }, `Create ${st.settings.capacityFile}`)));

  const table = h(doc, "table", { class: "dpc-table dpc-cap" },
    h(doc, "thead", {}, h(doc, "tr", {},
      ["Week", "Dates", "Raw", "× mult.", "Available", "Load"].map((c, i) => h(doc, "th", { class: i >= 2 && i <= 4 ? "dpc-num" : null }, c)))));
  const tb = h(doc, "tbody");
  for (const w of R.weeks) {
    const open = st.expanded === w.week;
    const pct = w.pct === Infinity ? 1 : w.pct;
    tb.append(h(doc, "tr", { class: "dpc-week" + (w.isCurrent ? " is-current" : "") + (w.isPast ? " is-past" : "") + (w.overloaded ? " is-over" : ""), tabindex: 0,
      "aria-expanded": open, onclick: () => on.toggleWeek(w.week), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); on.toggleWeek(w.week); } } },
      h(doc, "td", {}, h(doc, "span", { class: "dpc-caret", "aria-hidden": "true" }, open ? "▾" : "▸"), w.week.slice(5)),
      h(doc, "td", { class: "dpc-muted" }, `${fmtD(w.start)} – ${fmtD(w.end)}`),
      h(doc, "td", { class: "dpc-num dpc-muted" }, fmtH(w.raw)),
      h(doc, "td", { class: "dpc-num" }, fmtH(w.adj)),
      h(doc, "td", { class: "dpc-num" + (w.fromFile ? "" : " dpc-muted"),
        title: (w.isCurrent ? `Hours left this week (rest of today, then whole days) of ${fmtH(w.weekAvailable)} for the week. ` : "") +
          (w.fromFile ? `From ${st.settings.capacityFile}` : "Default (not in the capacity file)") }, fmtH(w.available) + (w.isCurrent ? " left" : "")),
      h(doc, "td", { class: "dpc-load" },
        h(doc, "div", { class: "dpc-meter", role: "img", "aria-label": `${Math.round(pct * 100)}% committed` },
          h(doc, "div", { class: "dpc-meter-fill", style: `width:${Math.min(100, pct * 100)}%` }),
          h(doc, "div", { class: "dpc-meter-mark", style: `left:${st.settings.overloadPct}%` })),
        h(doc, "span", { class: "dpc-pct" }, w.pct === Infinity ? "—" : `${Math.round(w.pct * 100)}%`),
        w.overloaded ? h(doc, "span", { class: "dpc-badge dpc-badge-over" }, h(doc, "span", { class: "dpc-badge-icon", "aria-hidden": "true" }, "▲"), "Over") : null)));
    if (open) {
      const list = w.tasks.length ? h(doc, "ul", { class: "dpc-week-tasks" }, w.tasks.map(x =>
        h(doc, "li", {}, h(doc, "span", { class: "dpc-dot", style: `background:${typeColor(st.cfg, M.typeKey(x.task))}`, "aria-hidden": "true" }),
          taskLink(doc, x.task, on), h(doc, "span", { class: "dpc-muted" }, ` · ${x.task.project}`),
          h(doc, "span", { class: "dpc-num dpc-right" }, `${fmtH(x.adj)}`, h(doc, "span", { class: "dpc-muted" }, ` (${fmtH(x.raw)} raw)`)))))
        : h(doc, "p", { class: "dpc-muted" }, "Nothing scheduled this week.");
      tb.append(h(doc, "tr", { class: "dpc-week-detail" }, h(doc, "td", { colspan: 6 }, list)));
    }
  }
  table.append(tb);
  body.append(table);

  const risky = st.tasks.filter(t => R.risk[t.path]).sort(byUrgency(st));
  body.append(h(doc, "h4", { class: "dpc-h" }, "At risk"));
  body.append(risky.length ? h(doc, "ul", { class: "dpc-list" }, risky.map(t => {
    const r = R.risk[t.path];
    return h(doc, "li", {}, riskBadge(doc, r), " ", taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, r.overdue ? ` · was due ${fmtD(t.due)}, ${fmtH(r.need)} left with multiplier`
        : ` · needs ${fmtH(r.need)} by ${fmtD(t.due)}, ${fmtH(r.available)} available`));
  })) : h(doc, "p", { class: "dpc-muted" }, "No task needs more hours than are available before its due date."));
  const waiting = st.tasks.filter(t => R.waiting && R.waiting[t.path]);
  if (waiting.length) {
    body.append(h(doc, "h4", { class: "dpc-h" }, "Waiting on an overdue task"));
    body.append(h(doc, "ul", { class: "dpc-list" }, waiting.map(t => h(doc, "li", {}, taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, " waits on "), ...R.waiting[t.path].map((x, i) => [i ? ", " : null, taskLink(doc, x, on), h(doc, "span", { class: "dpc-warn" }, ` (due ${fmtD(x.due)})`)]).flat()))));
  }
  if (st.spill) {
    body.append(h(doc, "h4", { class: "dpc-h" }, `Spilled over from last week (${st.spill.length})`, h(doc, "span", { class: "dpc-muted dpc-h-note" }, `logged each Monday in ${st.settings.spilloverFile || "Spillover.md"}`)));
    body.append(st.spill.length ? h(doc, "ul", { class: "dpc-list" }, st.spill.map(t => h(doc, "li", {}, taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, ` · ${t.project} · was due ${fmtD(t.due)} · ${fmtH(M.remaining(t))} left`)))) : h(doc, "p", { class: "dpc-muted" }, "Everything due last week was finished."));
  }

  const foot = [];
  if (R.unscheduled.length) foot.push(`${R.unscheduled.length} open task${R.unscheduled.length === 1 ? " has" : "s have"} no due date and ${R.unscheduled.length === 1 ? "isn't" : "aren't"} counted.`);
  if (R.beyond.length) foot.push(`${R.beyond.length} task${R.beyond.length === 1 ? " runs" : "s run"} past the planning range (${fmtD(st.settings.rangeEnd)}).`);
  if (foot.length) body.append(h(doc, "p", { class: "dpc-muted dpc-foot" }, foot.join(" ")));
}
function tile(doc, title, value, sub) {
  return h(doc, "div", { class: "dpc-tile" }, h(doc, "div", { class: "dpc-tile-label" }, title), h(doc, "div", { class: "dpc-tile-value" }, value), h(doc, "div", { class: "dpc-tile-sub" }, sub));
}

// ---------- queue ----------
function renderQueue(body, st, on) {
  const doc = body.ownerDocument, R = st.result, mults = st.settings.multipliers;
  if (!R.queue.length) {
    body.append(h(doc, "div", { class: "dpc-empty" }, h(doc, "strong", {}, "Queue is clear."), " ",
      R.candidates.length ? "Pull in the next tasks below." : "Nothing else is ready to start yet."));
    renderMore(body, st, on, true);
    renderDoneToday(body, st, on);
    return;
  }
  renderDays(body, st);
  const tb = h(doc, "tbody");
  const pulled = st.settings.pulled || {};
  R.queue.forEach((t, i) => {
    const hrs = st.mode === "raw" ? M.remaining(t) : M.adjusted(t, mults);
    tb.append(h(doc, "tr", {},
      h(doc, "td", { class: "dpc-num dpc-muted" }, String(i + 1)),
      h(doc, "td", {}, urgencyChip(doc, R.urgency && R.urgency[t.path], false)),
      h(doc, "td", {}, h(doc, "span", { class: `dpc-pri dpc-pri-${t.priority}` }, M.label(st.cfg.priorities, t.priority) || "—")),
      h(doc, "td", { class: "dpc-title-cell" }, taskLink(doc, t, on), h(doc, "div", { class: "dpc-muted dpc-sub" }, [t.project, t.workType, pulled[t.path] && pulled[t.path].kind !== "deferred" ? "added today" : null, R.waiting[t.path] ? `waiting on ${R.waiting[t.path].map(x => x.title).join(", ")} (overdue)` : null].filter(Boolean).join(" · ")),
        t.checklist ? h(doc, "div", { class: "dpc-muted dpc-sub" }, `${t.checklist.done}/${t.checklist.total} done-when`) : null),
      h(doc, "td", { class: "dpc-nowrap" + (R.risk[t.path] && R.risk[t.path].overdue ? " dpc-warn" : ""), title: t.due ? null : "No due date" }, relDue(t.due, R.today)),
      h(doc, "td", { class: "dpc-num" }, t.type === "milestone" ? "◆" : fmtH(hrs)),
      h(doc, "td", {}, riskBadge(doc, R.risk[t.path]), overBadge(doc, R.over && R.over.has(t.path))),
      h(doc, "td", { class: "dpc-nowrap dpc-actions" }, pulled[t.path] && pulled[t.path].kind !== "deferred" ? h(doc, "button", { class: "dpc-small dpc-undo-pull", title: `Added today; undo puts it back to ${pulled[t.path].start ? "start " + fmtD(pulled[t.path].start) : "no start date"}`,
          "aria-label": `Undo adding ${t.title} to the queue`, onclick: () => on.undoStart(t.path) }, "Undo add") : null,
        h(doc, "button", { class: "dpc-small", title: "Log time on this task", "aria-label": `Log time on ${t.title}`, onclick: () => on.logTime(t.path) }, "+h"),
        h(doc, "button", { class: "dpc-small", title: "Move to tomorrow", "aria-label": `Move ${t.title} to tomorrow`, onclick: () => on.notToday(t.path) }, "Not today"),
        h(doc, "button", { class: "dpc-done", title: t.checklist && t.checklist.done < t.checklist.total ? "Mark done (Done-when not all ticked)" : "Mark done", "aria-label": `Mark ${t.title} done`, onclick: () => on.markDone(t.path) }, "✓"))));
  });
  body.append(h(doc, "table", { class: "dpc-table dpc-queue" },
    h(doc, "thead", {}, h(doc, "tr", {}, ["#", "Why", "Priority", "Task", "Due", st.mode === "raw" ? "Left" : "Left ×", "", ""].map((c, i) => h(doc, "th", { class: i === 0 || i === 5 ? "dpc-num" : null }, c)))), tb));
  renderDoneToday(body, st, on);
  renderMore(body, st, on, false);
  if (R.upcoming) {
    const later = st.tasks.filter(t => !M.isComplete(st.cfg, t.status) && t.start && t.start > R.today).sort(byUrgency(st));
    body.append(h(doc, "details", { class: "dpc-details" }, h(doc, "summary", {}, `Starting later (${later.length})`),
      h(doc, "ul", { class: "dpc-list" }, later.map(t => h(doc, "li", {}, h(doc, "span", { class: "dpc-muted dpc-nowrap dpc-start" }, `starts ${fmtD(t.start)}`), taskLink(doc, t, on),
        h(doc, "span", { class: "dpc-muted" }, ` · ${t.project} · `), urgencyChip(doc, R.urgency && R.urgency[t.path], false), " ", riskBadge(doc, R.risk[t.path]))))));
  }
}

function renderDays(body, st) {
  const doc = body.ownerDocument, R = st.result;
  if (!R.days || !R.days.length) return;
  const max = 1.15 * Math.max(1, ...R.days.map(d => Math.max(d.adj, d.available))); // headroom so the available line stays visible
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  body.append(h(doc, "div", { class: "dpc-days", role: "list", "aria-label": "Committed hours for the next 7 days" }, R.days.map((d, i) => {
    const over = d.adj > d.available + 0.05;
    return h(doc, "div", { class: "dpc-day" + (i === 0 ? " is-today" : "") + (over ? " is-over" : ""), role: "listitem",
      title: `${fmtD(d.date)}: ${fmtH(d.adj)} committed (× multipliers) of about ${fmtH(d.available)} available` },
      h(doc, "div", { class: "dpc-day-name" }, i === 0 ? "Today" : DOW[new Date(M.toDay(d.date) * 86400000).getUTCDay()]),
      h(doc, "div", { class: "dpc-day-bar" }, h(doc, "div", { class: "dpc-day-fill", style: `height:${Math.min(100, (d.adj / max) * 100)}%` }),
        h(doc, "div", { class: "dpc-day-cap", style: `bottom:${Math.min(100, (d.available / max) * 100)}%` })),
      h(doc, "div", { class: "dpc-day-hrs" }, fmtH(d.adj)));
  })));
}
function renderDoneToday(body, st, on) {
  const doc = body.ownerDocument, R = st.result;
  const pulled = st.settings.pulled || {};
  const deferred = st.tasks.filter(t => pulled[t.path] && pulled[t.path].kind === "deferred");
  if (deferred.length) {
    body.append(h(doc, "h4", { class: "dpc-h" }, `Moved to tomorrow (${deferred.length})`));
    body.append(h(doc, "ul", { class: "dpc-list dpc-done-list" }, deferred.map(t => h(doc, "li", {}, h(doc, "span", { class: "dpc-muted", "aria-hidden": "true" }, "→"), taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, ` · ${t.project}`), h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.undoStart(t.path), "aria-label": `Undo: bring ${t.title} back to today` }, "Undo")))));
  }
  body.append(h(doc, "h4", { class: "dpc-h" }, `Done today (${R.doneToday.length})`, h(doc, "span", { class: "dpc-muted dpc-h-note" }, "clears at midnight")));
  if (!R.doneToday.length) { body.append(h(doc, "p", { class: "dpc-muted" }, "Nothing finished yet today.")); return; }
  body.append(h(doc, "ul", { class: "dpc-list dpc-done-list" }, R.doneToday.map(t =>
    h(doc, "li", {}, h(doc, "span", { class: "dpc-done-mark", "aria-hidden": "true" }, "✓"), taskLink(doc, t, on), h(doc, "span", { class: "dpc-muted" }, ` · ${t.project}`),
      h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.undoDone(t.path), "aria-label": `Undo: reopen ${t.title}` }, "Undo")))));
}
function renderMore(body, st, on, open) {
  const doc = body.ownerDocument, R = st.result;
  const show = open || st.showMore;
  const btn = h(doc, "button", { class: (open ? "mod-cta " : "") + "dpc-more-btn", onclick: () => on.toggleMore(), "aria-expanded": show },
    h(doc, "span", { "aria-hidden": "true" }, "↻ "), show && !open ? "Hide suggestions" : "Find more tasks");
  body.append(h(doc, "div", { class: "dpc-more" }, open && show ? null : btn));
  if (!show) return;
  const list = R.candidates.slice(0, 6);
  if (!list.length) { body.append(h(doc, "p", { class: "dpc-muted" }, "No task is ready to pull forward: everything left is waiting on another task.")); return; }
  body.append(h(doc, "p", { class: "dpc-muted dpc-sub" }, "Ready to start: dependencies done, least slack first. “Start now” moves the start date to today."));
  body.append(h(doc, "ul", { class: "dpc-list dpc-more-list" }, list.map(t =>
    h(doc, "li", {}, h(doc, "span", { class: `dpc-pri dpc-pri-${t.priority}` }, M.label(st.cfg.priorities, t.priority)), taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, ` · ${t.project} · starts ${fmtD(t.start)}${t.estimate ? ` · ${fmtH(M.adjusted(t, st.settings.multipliers))}` : ""} · `),
      urgencyChip(doc, R.urgency && R.urgency[t.path], false),
      h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.startNow(t.path) }, "Start now")))));
}

// ---------- projects (progress tracker, styled after dotpm's project overview) ----------
const HEALTH = { "on-track": ["On track", "✓"], watch: ["Watch", "!"], behind: ["Behind", "▲"], done: ["Done", "✓"], empty: ["No tasks", "–"] };
function renderProjects(body, st, on) {
  const doc = body.ownerDocument, R = st.result, cfg = st.cfg, today = R.today;
  const tree = M.projectTree(st.projects || []);
  const rank = { behind: 0, watch: 1, "on-track": 2, done: 3, empty: 4 };
  const stats = tree.map(n => M.projectStats(n, st.tasks, cfg, today, R.risk))
    .sort((a, b) => (a.total ? 0 : 1) - (b.total ? 0 : 1) || rank[a.health] - rank[b.health] || a.node.title.localeCompare(b.node.title));
  const flat = []; const walk = (s, depth) => { flat.push([s, depth]); s.kids.forEach(k => walk(k, depth + 1)); }; stats.forEach(s => walk(s, 0));
  const count = k => flat.filter(([s]) => s.health === k).length;
  body.append(h(doc, "div", { class: "dpc-toolbar" },
    h(doc, "span", { class: "dpc-muted" }, `${flat.length} projects · ${count("behind")} behind · ${count("watch")} to watch · ${count("on-track")} on track`),
    h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.newFromTemplate() }, "+ From template")));
  if (!flat.length) { body.append(h(doc, "p", { class: "dpc-muted" }, "No projects yet.")); return; }
  const list = h(doc, "div", { class: "dpc-projects" });
  for (const [s, depth] of flat) list.append(projectCard(doc, s, depth, st, on));
  body.append(list);
}
function projectCard(doc, s, depth, st, on) {
  const R = st.result, cfg = st.cfg, n = s.node, open = st.openProjects && st.openProjects.has(n.path);
  const [hl, hi] = HEALTH[s.health];
  const pct = v => `${Math.round(v * 100)}%`;
  const sub = s.kids.length ? ` · incl. ${s.kids.length} sub-project${s.kids.length === 1 ? "" : "s"}` : "";
  const stat = (label, value, note, cls) => h(doc, "div", { class: "dpc-pstat" + (cls ? " " + cls : "") },
    h(doc, "div", { class: "dpc-pstat-label" }, label), h(doc, "div", { class: "dpc-pstat-value" }, value), h(doc, "div", { class: "dpc-pstat-note" }, note));
  const head = h(doc, "div", { class: "dpc-phead" },
    h(doc, "div", { class: "dpc-picon", style: n.color ? `--dpc-pc:${n.color}` : null, "aria-hidden": "true" }, n.icon || "📋"),
    h(doc, "div", { class: "dpc-ptitle-wrap" },
      h(doc, "div", { class: "dpc-ptitle" }, h(doc, "a", { href: "#", class: "dpc-task-link", onclick: e => { e.preventDefault(); on.openProjectNote(n.path); } }, n.title),
        h(doc, "span", { class: `dpc-health dpc-health-${s.health}` }, h(doc, "span", { "aria-hidden": "true" }, hi), hl)),
      h(doc, "div", { class: "dpc-muted dpc-sub" }, s.total ? `${s.done} of ${s.total} task${s.total === 1 ? "" : "s"} done${sub}${s.nextDue ? ` · next due ${fmtD(s.nextDue.due)}` : ""}` : "No tasks yet — add one with Quick add")));
  const plannedNote = s.planned == null ? "no dates yet" : s.gap >= 0.005 ? `${pct(s.gap)} ahead of plan` : s.gap <= -0.005 ? `${pct(-s.gap)} behind plan (${pct(s.planned)} planned)` : "on plan";
  const grid = h(doc, "div", { class: "dpc-pgrid" },
    stat("Progress", pct(s.actual), plannedNote, null),
    stat("Tasks", `${s.done} of ${s.total}`, "done", null),
    stat("Overdue", String(s.overdue.length), s.atRisk.length ? `tasks past due · ${s.atRisk.length} at risk` : "tasks past due", s.overdue.length ? "is-bad" : null),
    stat("Time", `${fmtH(s.logged).replace("h", "")}/${fmtH(s.estimate)}`, "logged / estimate", null));
  const bar = h(doc, "div", { class: "dpc-pbar", role: "img", "aria-label": `${pct(s.actual)} done${s.planned != null ? `, ${pct(s.planned)} planned by today` : ""}` },
    h(doc, "div", { class: "dpc-pbar-fill", style: `width:${Math.min(100, s.actual * 100)}%` }),
    s.planned != null ? h(doc, "div", { class: "dpc-pbar-plan", style: `left:${Math.min(100, s.planned * 100)}%`, title: `Planned by today: ${pct(s.planned)}` }) : null);
  const ms = s.milestones.length ? h(doc, "div", { class: "dpc-pms" }, h(doc, "span", { class: "dpc-pstat-label" }, "Milestones"),
    s.milestones.map(m => h(doc, "button", { class: `dpc-ms-chip is-${m.state}`, onclick: () => on.openTask(m.task.path), title: m.state === "missed" ? "Past its date and not done" : m.state === "done" ? "Done" : "Upcoming" },
      h(doc, "span", { "aria-hidden": "true" }, m.state === "done" ? "◆ ✓" : "◆"), ` ${m.task.title}`, h(doc, "span", { class: "dpc-muted" }, m.task.due ? ` · ${fmtD(m.task.due)}` : "")))) : null;
  const desc = n.description ? h(doc, "div", { class: "dpc-pdesc" }, n.description.split("\n").filter(Boolean)[0].replace(/\*\*/g, "")) : null;
  const toggle = h(doc, "button", { class: "dpc-ptoggle", "aria-expanded": !!open, onclick: () => on.toggleProject(n.path) },
    h(doc, "span", { class: "dpc-caret", "aria-hidden": "true" }, open ? "▾" : "▸"), `Tasks (${s.own.length}${s.kids.length ? ` here · ${s.total} with sub-projects` : ""})`);
  if (!s.total) return h(doc, "section", { class: "dpc-pcard is-empty", style: `--dpc-depth:${depth}`, "aria-label": n.title }, head);
  const card = h(doc, "section", { class: "dpc-pcard", style: `--dpc-depth:${depth}`, "aria-label": n.title }, head, grid, bar, ms, desc, toggle);
  if (open) {
    const urgOrd = byUrgency(st);
    const tasks = s.own.slice().sort((a, b) => (M.isComplete(cfg, a.status) - M.isComplete(cfg, b.status)) || (M.isComplete(cfg, a.status) ? (a.due || "9999").localeCompare(b.due || "9999") : urgOrd(a, b)));
    card.append(tasks.length ? h(doc, "ul", { class: "dpc-ptasks" }, tasks.map(t => {
      const stc = cfg.statuses.find(x => x.id === t.status);
      const done = M.isComplete(cfg, t.status), prog = done ? 100 : Math.max(0, Math.min(100, t.progress || 0));
      return h(doc, "li", { class: done ? "is-done" : "" },
        h(doc, "span", { class: "dpc-status", style: `--dpc-sc:${(stc && stc.color) || "var(--text-faint)"}` }, stc ? stc.label : t.status),
        h(doc, "span", { class: "dpc-ptask-title" }, t.type === "milestone" ? "◆ " : null, taskLink(doc, t, on), " ", riskBadge(doc, R.risk[t.path])),
        h(doc, "span", { class: "dpc-muted dpc-nowrap" + (!done && t.due && t.due < R.today ? " dpc-warn" : "") }, t.due ? fmtD(t.due) : ""),
        h(doc, "span", { class: "dpc-muted dpc-num" }, t.estimate != null ? `${fmtH(t.logged).replace("h", "")}/${fmtH(t.estimate)}` : ""),
        h(doc, "span", { class: "dpc-ptask-prog", role: "img", "aria-label": `${prog}% done` }, h(doc, "span", { style: `width:${prog}%` })));
    })) : h(doc, "p", { class: "dpc-muted dpc-ptasks-empty" }, s.kids.length ? "No tasks directly in this project; see its sub-projects below." : "No tasks yet."));
  }
  return card;
}

// ---------- board ----------
// Styled after dotpm's own kanban: colored column tops with count pills, compact cards with hours,
// progress, a project chip and the due date. Actions (✓, Move…) show on hover, always on touch screens.
function renderBoard(body, st, on) {
  const doc = body.ownerDocument, R = st.result;
  const mode = st.settings.boardMode === "week" ? "week" : "today";
  body.append(h(doc, "div", { class: "dpc-toolbar" },
    h(doc, "div", { class: "dpc-seg", role: "group", "aria-label": "Board view" }, [["today", "Today"], ["week", "By week"]].map(([id, name]) =>
      h(doc, "button", { class: "dpc-seg-btn" + (mode === id ? " is-active" : ""), "aria-pressed": mode === id, onclick: () => on.setBoardMode(id) }, name))),
    h(doc, "span", { class: "dpc-muted" }, mode === "week" ? "Each card sits in the week it's due, in queue order. Drag to another week to move its dates."
      : "Started tasks, most urgent first: Now, Tight, then least slack. Finish them here or pull in more."),
    h(doc, "button", { class: "dpc-small dpc-right", onclick: () => on.quickAdd(), title: "Quick add a task (command: Quick add task)" }, "+ Quick add")));
  if (mode === "today") { renderQueue(body, st, on); return; }
  const cols = R.board.map(c => ({ ...c, color: c.key === "overdue" ? "var(--dpc-risk)" : c.week && c.week.overloaded ? "var(--dpc-over)" : c.week && c.week.isCurrent ? "var(--interactive-accent, var(--text-accent))" : "var(--text-faint)" }));
  const targets = R.board.filter(c => c.week).map(c => ({ key: c.key, label: c.week.isCurrent ? "This week" : `${c.key.slice(5)} · ${fmtD(c.week.start)}` }));
  const wrap = h(doc, "div", { class: "dpc-board" });
  for (const c of cols) {
    const w = c.week;
    const head = h(doc, "div", { class: "dpc-col-head" },
      h(doc, "div", { class: "dpc-col-title" }, h(doc, "span", { class: "dpc-col-name", style: `color:${c.color}` }, c.label), h(doc, "span", { class: "dpc-count" }, String(c.tasks.length))),
      w ? h(doc, "div", { class: "dpc-col-sub" }, h(doc, "span", { class: "dpc-muted dpc-nowrap" }, `${fmtD(w.start)} – ${fmtD(w.end)}`),
          h(doc, "div", { class: "dpc-meter dpc-meter-sm" + (w.overloaded ? " is-over" : ""), role: "img", "aria-label": `${Math.round(w.pct * 100)}% committed` },
            h(doc, "div", { class: "dpc-meter-fill", style: `width:${Math.min(100, w.pct * 100)}%` })),
          h(doc, "span", { class: "dpc-muted dpc-nowrap", title: "Committed this week (× multipliers) of available hours" }, `${fmtH(w.adj)}/${fmtH(w.available)}`)) : null);
    const list = h(doc, "div", { class: "dpc-col-list" });
    for (const t of c.tasks) list.append(card(doc, t, st, on, "week", targets));
    const col = h(doc, "section", { class: "dpc-col" + (w && w.isCurrent ? " is-current" : ""), style: `--dpc-col:${c.color}`, "aria-label": c.label }, head, list);
    if (w) {
      col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("is-drop"); });
      col.addEventListener("dragleave", e => { if (!col.contains(e.relatedTarget)) col.classList.remove("is-drop"); });
      col.addEventListener("drop", e => { e.preventDefault(); col.classList.remove("is-drop"); const p = e.dataTransfer.getData("text/plain"); if (p) on.moveCard(p, c.key); });
    }
    wrap.append(col);
  }
  body.append(wrap);
}
function card(doc, t, st, on, mode, targets) {
  const R = st.result, cfg = st.cfg;
  const done = M.isComplete(cfg, t.status);
  const pri = cfg.priorities.find(x => x.id === t.priority);
  const top = pri && t.priority !== "medium" ? (pri.color || "transparent") : "transparent";
  const el = h(doc, "article", { class: "dpc-card" + (done ? " is-done" : "") + (R.blocked.has(t.path) && !done ? " is-waiting" : ""), draggable: "true",
    style: `--dpc-top:${top}`, title: R.blocked.has(t.path) && !done ? "Waiting on another task" : null });
  el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", t.path); e.dataTransfer.effectAllowed = "move"; el.classList.add("is-drag"); });
  el.addEventListener("dragend", () => el.classList.remove("is-drag"));
  el.addEventListener("click", e => { if (e.target.closest("button, select, a")) return; on.openTask(t.path); });
  const pct = Math.max(0, Math.min(100, t.progress || 0));
  const hrs = t.estimate != null ? `${fmtH(t.logged).replace("h", "")}/${fmtH(t.estimate)}` : t.logged ? fmtH(t.logged) : null;
  const projColor = (st.projectColors && st.projectColors[t.project]) || "var(--text-faint)";
  const cur = t.due ? M.isoWeek(t.due) : "";
  const move = h(doc, "select", { class: "dropdown dpc-move", "aria-label": `Move ${t.title}` },
    h(doc, "option", { value: "", selected: true, disabled: true }, "Move…"), targets.filter(x => x.key !== cur).map(x => h(doc, "option", { value: x.key }, x.label)));
  move.addEventListener("change", () => { if (move.value) on.moveCard(t.path, move.value); });
  const overdue = !done && t.due && t.due < R.today;
  el.append(...[
    h(doc, "div", { class: "dpc-card-head" }, h(doc, "span", { class: "dpc-card-title" }, t.title),
      t.type === "milestone" ? h(doc, "span", { class: "dpc-ms", title: "Milestone" }, "M") : null),
    !done ? urgencyChip(doc, R.urgency && R.urgency[t.path], false) : null,
    hrs || R.risk[t.path] ? h(doc, "div", { class: "dpc-card-meta" }, hrs ? h(doc, "span", { class: "dpc-hrs" }, hrs) : null,
      !done && M.remaining(t) > 0 && st.settings.multipliers ? h(doc, "span", { class: "dpc-muted", title: "Hours left with multiplier" }, `${fmtH(M.adjusted(t, st.settings.multipliers))} ×`) : null,
      riskBadge(doc, R.risk[t.path]), !done ? overBadge(doc, R.over && R.over.has(t.path)) : null) : null,
    pct > 0 ? h(doc, "div", { class: "dpc-card-prog", role: "img", "aria-label": `${pct}% done` }, h(doc, "div", { style: `width:${pct}%` })) : null,
    h(doc, "div", { class: "dpc-card-foot" },
      h(doc, "span", { class: "dpc-chip" }, h(doc, "span", { class: "dpc-dot", style: `background:${projColor}` }), t.project || "—"),
      t.due ? h(doc, "span", { class: "dpc-card-due" + (overdue ? " dpc-warn" : "") }, fmtD(t.due)) : null),
    h(doc, "div", { class: "dpc-card-actions" }, move,
      done ? h(doc, "button", { class: "dpc-small", onclick: () => on.undoDone(t.path) }, "Undo")
        : h(doc, "button", { class: "dpc-done", title: "Mark done", "aria-label": `Mark ${t.title} done`, onclick: () => on.markDone(t.path) }, "✓"))].filter(Boolean));
  return el;
}

// ---------- work types / categories (stacked bars per week) ----------
function renderTypes(body, st, on) {
  const doc = body.ownerDocument, set = st.settings;
  const view = set.typesView === "category" ? "category" : "type";
  const sub = set.showSubprojects !== false;
  body.append(h(doc, "div", { class: "dpc-toolbar" },
    h(doc, "div", { class: "dpc-seg", role: "group", "aria-label": "Split hours by" }, [["type", "By work type"], ["category", "By category"]].map(([id, name]) =>
      h(doc, "button", { class: "dpc-seg-btn" + (view === id ? " is-active" : ""), "aria-pressed": view === id, onclick: () => on.setTypesView(id) }, name))),
    view === "category"
      ? h(doc, "label", { class: "dpc-check", title: "Split each category into its sub-projects" },
          h(doc, "input", { type: "checkbox", checked: sub, onchange: e => on.setSubprojects(e.target.checked) }), "Show sub-projects")
      : null,
    h(doc, "span", { class: "dpc-muted" }, view === "category"
      ? (sub ? "Each sub-project is a shade of its category's color." : "One segment per top-level project (Studio, Portfolio, each class…).")
      : "Committed hours per week by work type.")));
  if (view === "category") { renderCategories(body, st, on, sub); return; }
  const cfg = st.cfg, field = st.mode === "raw" ? "rawByType" : "byType";
  renderStacked(body, st, {
    keys: typeKeys(cfg), val: (w, k) => w[field][k] || 0,
    color: k => typeColor(cfg, k), name: k => typeName(k, cfg), what: "work type",
    legend: present => legend(doc, cfg, present, true),
  });
}

// Same chart split by project: every sub-project is its own segment, shaded within its category's color
// (Studio, Portfolio, each class…), so a category reads as one block of related shades.
function categoryPalette(st) {
  const R = st.result, field = st.mode === "raw" ? "rawByProject" : "byProject";
  const used = new Set(R.weeks.flatMap(w => Object.keys(w[field] || {}).filter(k => w[field][k] > 0.05)));
  // only categories and sub-projects with hours in the range take a color, so shades stay far apart
  const groups = M.categoryGroups(st.projects || [], [...used])
    .map(g => ({ ...g, members: g.members.filter(m => used.has(m.key)) })).filter(g => g.members.length);
  const color = {}, name = {}, group = {};
  let slot = 0;
  for (const g of groups) {
    const base = g.key === M.NO_PROJECT || slot >= 8 ? "var(--dpc-none)" : `var(--dpc-s${++slot})`;
    const n = g.members.length;
    g.members.forEach((m, j) => {
      // spread shades from toward the text color (darker in light themes) to toward the background
      const t = n === 1 ? 0 : -0.3 + (0.85 * j) / (n - 1);
      const pct = Math.round(Math.abs(t) * 100);
      color[m.key] = Math.abs(t) < 0.04 ? base
        : t < 0 ? `color-mix(in oklab, ${base} ${100 - pct}%, var(--text-normal))`
        : `color-mix(in oklab, ${base} ${100 - pct}%, var(--background-primary))`;
      name[m.key] = m.own ? `${m.title} (general)` : m.title;
      group[m.key] = g;
    });
    g.base = base;
  }
  return { groups, color, name, group };
}
function renderCategories(body, st, on, sub) {
  const doc = body.ownerDocument, P = categoryPalette(st);
  const field = st.mode === "raw" ? "rawByProject" : "byProject";
  const groupSum = (w, g) => g.members.reduce((a, m) => a + (w[field][m.key] || 0), 0);
  const byKey = Object.fromEntries(P.groups.map(g => [g.key, g]));
  const avail = h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch-line" }), "Available");
  const o = sub ? {
    keys: P.groups.flatMap(g => g.members.map(m => m.key)), val: (w, k) => w[field][k] || 0,
    color: k => P.color[k] || "var(--dpc-none)",
    name: k => { const g = P.group[k]; const n = P.name[k] || k; return g && g.title !== n && !n.startsWith(g.title + " (") ? `${g.title} › ${n}` : n; },
    legend: present => h(doc, "div", { class: "dpc-legend dpc-legend-groups" },
      P.groups.filter(g => g.members.some(m => present.includes(m.key))).map(g =>
        h(doc, "div", { class: "dpc-legend-group" },
          h(doc, "span", { class: "dpc-legend-cat" }, h(doc, "span", { class: "dpc-swatch", style: `background:${g.base}` }), g.title),
          g.members.filter(m => present.includes(m.key) && !(g.members.length === 1 && m.key === g.key)).map(m =>
            h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch", style: `background:${P.color[m.key]}` }), P.name[m.key])))),
      avail),
  } : {
    keys: P.groups.map(g => g.key), val: (w, k) => groupSum(w, byKey[k]),
    color: k => byKey[k].base, name: k => byKey[k].title,
    legend: present => h(doc, "div", { class: "dpc-legend" }, present.map(k =>
      h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch", style: `background:${byKey[k].base}` }), byKey[k].title)), avail),
  };
  // the table always totals per category; hover a header for its sub-projects
  o.table = (present, totals) => {
    const R = st.result;
    const gs = P.groups.filter(g => g.members.some(m => R.weeks.some(w => (w[field][m.key] || 0) > 0.05)));
    return h(doc, "table", { class: "dpc-table dpc-types-table" },
      h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, "Week"),
        gs.map(g => h(doc, "th", { class: "dpc-num", title: g.members.map(m => P.name[m.key]).join(", ") }, g.title)),
        h(doc, "th", { class: "dpc-num" }, "Total"), h(doc, "th", { class: "dpc-num" }, "Available"))),
      h(doc, "tbody", {}, R.weeks.map((w, i) => h(doc, "tr", { class: w.isCurrent ? "is-current" : "" }, h(doc, "td", {}, w.week.slice(5)),
        gs.map(g => { const v = groupSum(w, g); return h(doc, "td", { class: "dpc-num" }, v > 0.05 ? fmtH(v) : ""); }),
        h(doc, "td", { class: "dpc-num" }, fmtH(totals[i])), h(doc, "td", { class: "dpc-num dpc-muted" }, fmtH(w.available))))));
  };
  renderStacked(body, st, { ...o, what: sub ? "project" : "category" });
}

function renderStacked(body, st, o) {
  const doc = body.ownerDocument, R = st.result, val = o.val;
  const present = o.keys.filter(k => R.weeks.some(w => val(w, k) > 0.05));
  const totals = R.weeks.map(w => present.reduce((a, k) => a + val(w, k), 0));
  const maxV = Math.max(1, ...totals, ...R.weeks.map(w => w.available));
  const W = Math.max(320, Math.min(760, (body.clientWidth || 640))), H = 240, padL = 40, padR = 8, padT = 12, padB = 28;
  const cw = (W - padL - padR) / R.weeks.length, bw = Math.min(44, cw * 0.62);
  const y = v => padT + (H - padT - padB) * (1 - v / maxV);
  const step = niceStep(maxV);
  const svg = s(doc, "svg", { class: "dpc-chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Committed hours per week by ${o.what}, ${st.mode === "raw" ? "raw estimates" : "with multipliers"}` });
  for (let v = 0; v <= maxV + 0.001; v += step) {
    svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? "dpc-axis" : "dpc-grid" }));
    svg.append(s(doc, "text", { x: padL - 6, y: y(v) + 4, class: "dpc-tick", "text-anchor": "end" }, `${v}h`));
  }
  const wrap = h(doc, "div", { class: "dpc-chart-wrap" });
  const tip = h(doc, "div", { class: "dpc-tip", role: "status" });
  R.weeks.forEach((w, i) => {
    const cx = padL + cw * i + cw / 2, x = cx - bw / 2;
    let acc = 0;
    const segs = present.filter(k => val(w, k) > 0.05);
    segs.forEach((k, j) => {
      const v = val(w, k), y0 = y(acc), y1 = y(acc + v), top = j === segs.length - 1;
      const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
      const yy = y1;
      const r = top ? Math.min(4, hgt, bw / 2) : 0;
      const d = `M${x},${yy + hgt} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + hgt} Z`;
      const seg = s(doc, "path", { d, style: `fill:${o.color(k)}`, class: "dpc-seg-mark", tabindex: 0 });
      const show = e => {
        tip.textContent = `${w.week.slice(5)} · ${o.name(k)}: ${fmtH(v)} of ${fmtH(totals[i])}`; tip.classList.add("is-on");
        const r = seg.getBoundingClientRect();
        placeTip(tip, wrap, e && e.clientX != null ? e.clientX : r.right, e && e.clientY != null ? e.clientY : r.top + r.height / 2);
      };
      seg.addEventListener("mousemove", show); seg.addEventListener("focus", show);
      seg.addEventListener("mouseleave", () => tip.classList.remove("is-on")); seg.addEventListener("blur", () => tip.classList.remove("is-on"));
      svg.append(seg);
      acc += v;
    });
    // available hours as a short dashed tick
    svg.append(s(doc, "line", { x1: x - 4, x2: x + bw + 4, y1: y(w.available), y2: y(w.available), class: "dpc-cap-line" }));
    svg.append(s(doc, "text", { x: cx, y: H - 10, class: "dpc-tick" + (w.isCurrent ? " is-current" : ""), "text-anchor": "middle" }, w.week.slice(5)));
  });
  wrap.append(svg, tip);
  body.append(o.legend(present), wrap);
  const t = o.table ? o.table(present, totals) : h(doc, "table", { class: "dpc-table dpc-types-table" },
    h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, "Week"), present.map(k => h(doc, "th", { class: "dpc-num" }, o.name(k))), h(doc, "th", { class: "dpc-num" }, "Total"), h(doc, "th", { class: "dpc-num" }, "Available"))),
    h(doc, "tbody", {}, R.weeks.map((w, i) => h(doc, "tr", { class: w.isCurrent ? "is-current" : "" }, h(doc, "td", {}, w.week.slice(5)),
      present.map(k => h(doc, "td", { class: "dpc-num" }, val(w, k) > 0.05 ? fmtH(val(w, k)) : "")),
      h(doc, "td", { class: "dpc-num" }, fmtH(totals[i])), h(doc, "td", { class: "dpc-num dpc-muted" }, fmtH(w.available))))));
  body.append(h(doc, "details", { class: "dpc-details" }, h(doc, "summary", {}, "Table"), t));
}
// Place a tooltip beside the pointer, inside its wrapper, flipping left near the right edge.
function placeTip(tip, wrap, clientX, clientY) {
  const b = wrap.getBoundingClientRect();
  tip.style.right = "auto";
  const w = tip.offsetWidth || 160, hgt = tip.offsetHeight || 40;
  let x = clientX - b.left + 14;
  if (x + w > b.width) x = clientX - b.left - w - 14;
  let y = clientY - b.top - hgt / 2;
  y = Math.max(0, Math.min(b.height - hgt, y));
  tip.style.left = `${Math.max(0, x)}px`; tip.style.top = `${y}px`;
}
function niceStep(max) { const raw = max / 4; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function legend(doc, cfg, keys, withCap) {
  return h(doc, "div", { class: "dpc-legend" }, keys.map(k =>
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), typeName(k, cfg))),
    withCap ? h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch-line" }), "Available") : null);
}

// ---------- time ----------
// Where logged time went on a day or in a week, like a phone's screen-time report. Reads time logs only.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dowOf = d => DOW[new Date(M.toDay(d) * 86400000).getUTCDay()];
function fmtDur(hrs) {
  const m = Math.round(hrs * 60);
  if (m <= 0) return "0m";
  const hh = Math.floor(m / 60), mm = m % 60;
  return (hh ? `${hh}h` : "") + (hh && mm ? " " : "") + (mm ? `${mm}m` : "");
}
const clock12 = hr => `${hr % 12 || 12}${hr < 12 || hr === 24 ? "a" : "p"}`;
function timeState(st) {
  const t = st.time || {}, today = st.today || M.localToday();
  const mode = t.mode === "week" ? "week" : "day";
  let date = M.isDate(t.date) ? t.date : today;
  if (date > today) date = today;
  return { mode, date, group: t.group === "project" ? "project" : "type", today };
}
function renderTime(body, st, on) {
  const doc = body.ownerDocument, cfg = st.cfg, mults = st.settings.multipliers || {};
  const T = timeState(st), today = T.today;
  const from = T.mode === "day" ? T.date : M.mondayOf(T.date), to = T.mode === "day" ? T.date : M.addDays(from, 6);
  const R = M.timeReport(st.tasks, cfg, mults, from, to, { capacity: st.settings.capacity || {}, capacityDays: st.settings.capacityDays,
    defaultWeeklyHours: st.settings.defaultWeeklyHours, workWindow: st.workWindow, today });
  const set = patch => on.setTime(patch);
  const step = n => { let d = M.addDays(T.date, n * (T.mode === "day" ? 1 : 7)); if (d > today) d = today; set({ date: d }); };
  const label = T.mode === "day" ? (T.date === today ? "Today" : T.date === M.addDays(today, -1) ? "Yesterday" : `${dowOf(T.date)} ${fmtD(T.date)}`)
    : (from === M.mondayOf(today) ? "This week" : `${fmtD(from)} – ${fmtD(to)}`);
  const atEnd = T.mode === "day" ? T.date >= today : to >= today;
  const seg = (items, cur, fn, aria) => h(doc, "div", { class: "dpc-seg", role: "group", "aria-label": aria },
    items.map(([id, name]) => h(doc, "button", { class: "dpc-seg-btn" + (cur === id ? " is-active" : ""), "aria-pressed": cur === id, onclick: () => fn(id) }, name)));
  body.append(h(doc, "div", { class: "dpc-time-top" },
    seg([["day", "Day"], ["week", "Week"]], T.mode, m => set({ mode: m }), "Period"),
    h(doc, "div", { class: "dpc-time-nav" },
      h(doc, "button", { "aria-label": T.mode === "day" ? "Previous day" : "Previous week", onclick: () => step(-1) }, "‹"),
      h(doc, "span", { class: "dpc-time-label" }, label),
      h(doc, "button", { "aria-label": T.mode === "day" ? "Next day" : "Next week", disabled: atEnd, onclick: () => step(1) }, "›"),
      h(doc, "button", { class: "dpc-small", disabled: T.date === today, onclick: () => set({ date: today }) }, "Today"))));

  // headline
  let big, sub;
  if (T.mode === "day") {
    const avg = M.weekAverageBefore(st.tasks, T.date);
    big = fmtDur(R.total);
    sub = avg && avg.average > 0
      ? `${R.total >= avg.average ? "▲" : "▼"} ${Math.abs(Math.round((R.total / avg.average - 1) * 100))}% vs this week's daily average (${fmtDur(avg.average)})`
      : "No earlier days logged this week";
  } else {
    big = fmtDur(R.average);
    sub = `${fmtDur(R.total)} over ${R.elapsed} day${R.elapsed === 1 ? "" : "s"}`;
  }
  const used = R.available > 0 ? `${Math.round((R.total / R.available) * 100)}%` : "—";
  body.append(h(doc, "div", { class: "dpc-time-head" },
    h(doc, "div", {}, h(doc, "div", { class: "dpc-time-k" }, T.mode === "day" ? (T.date === today ? "Worked today" : "Worked") : "Daily average"),
      h(doc, "div", { class: "dpc-time-big" }, big), h(doc, "div", { class: "dpc-muted dpc-time-sub" }, sub)),
    h(doc, "div", { class: "dpc-time-stats" },
      [["Available", fmtH(R.available)], [T.mode === "day" ? "Used" : "Used so far", used], ["Tasks", String(R.rows.length)]]
        .map(([k, v]) => h(doc, "div", {}, h(doc, "div", { class: "dpc-time-k" }, k), h(doc, "div", { class: "dpc-time-v" }, v))))));

  // chart
  const wrap = h(doc, "div", { class: "dpc-chart-wrap" }), tip = h(doc, "div", { class: "dpc-tip", role: "status" });
  const hover = (el, text) => {
    const show = e => { tip.textContent = text; tip.classList.add("is-on"); const r = el.getBoundingClientRect();
      placeTip(tip, wrap, e && e.clientX != null ? e.clientX : r.right, e && e.clientY != null ? e.clientY : r.top + r.height / 2); };
    el.addEventListener("mousemove", show); el.addEventListener("focus", show);
    el.addEventListener("mouseleave", () => tip.classList.remove("is-on")); el.addEventListener("blur", () => tip.classList.remove("is-on"));
  };
  const keys = typeKeys(cfg), present = new Set();
  const W = Math.max(320, Math.min(760, body.clientWidth || 640)), padL = 38, padR = 8, padT = 12, padB = 24;
  if (T.mode === "day") {
    const H = 170, hrs = R.hours, cw = (W - padL - padR) / hrs.length, y = m => padT + (H - padT - padB) * (1 - m / 60);
    const svg = s(doc, "svg", { class: "dpc-chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Minutes worked in each hour" });
    for (const m of [0, 30, 60]) {
      svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(m), y2: y(m), class: m === 0 ? "dpc-axis" : "dpc-grid" }));
      svg.append(s(doc, "text", { x: padL - 6, y: y(m) + 4, class: "dpc-tick", "text-anchor": "end" }, `${m}m`));
    }
    hrs.forEach((b, i) => {
      const x = padL + i * cw + Math.min(3, cw * 0.12), bw = cw - 2 * Math.min(3, cw * 0.12);
      let acc = 0;
      for (const k of keys) {
        const v = (b.byType[k] || 0) * 60;
        if (v < 0.5) continue;
        present.add(k);
        const r = s(doc, "rect", { x, width: bw, y: y(Math.min(60, acc + v)), height: Math.max(0, y(acc) - y(Math.min(60, acc + v))), rx: 2, style: `fill:${typeColor(cfg, k)}`, class: "dpc-seg-mark", tabindex: 0 });
        hover(r, `${clock12(b.hour)}–${clock12(b.hour + 1)} · ${typeName(k, cfg)}: ${Math.round(v)}m`);
        svg.append(r); acc += v;
      }
      if ((b.hour - hrs[0].hour) % 3 === 0) svg.append(s(doc, "text", { x: padL + i * cw, y: H - 6, class: "dpc-tick" }, clock12(b.hour)));
    });
    if (T.date === today && typeof st.nowHours === "number" && st.nowHours > hrs[0].hour && st.nowHours < hrs[hrs.length - 1].hour + 1) {
      const x = padL + (st.nowHours - hrs[0].hour) * cw;
      svg.append(s(doc, "line", { x1: x, x2: x, y1: padT, y2: H - padB, class: "dpc-time-now" }));
      svg.append(s(doc, "text", { x: x + 4, y: padT + 9, class: "dpc-tick dpc-time-now-label" }, "now"));
    }
    wrap.append(svg, tip);
  } else {
    const H = 200, max = Math.max(1, ...R.days.map(d => Math.max(d.total, d.available)));
    const stp = niceStep(max), top = Math.ceil(max / stp) * stp, cw = (W - padL - padR) / 7, bw = Math.min(44, cw * 0.6);
    const y = v => padT + (H - padT - padB) * (1 - v / top);
    const svg = s(doc, "svg", { class: "dpc-chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Hours worked each day of the week" });
    for (let v = 0; v <= top + 1e-9; v += stp) {
      svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? "dpc-axis" : "dpc-grid" }));
      svg.append(s(doc, "text", { x: padL - 6, y: y(v) + 4, class: "dpc-tick", "text-anchor": "end" }, `${Math.round(v * 10) / 10}h`));
    }
    R.days.forEach((d, i) => {
      const x = padL + i * cw + (cw - bw) / 2, future = d.date > today;
      const g = s(doc, "g", { class: "dpc-time-day" + (future ? " is-future" : ""), tabindex: future ? null : 0, role: future ? null : "button", "aria-label": `${dowOf(d.date)} ${fmtD(d.date)}: ${fmtDur(d.total)}` });
      if (d.available > 0) g.append(s(doc, "rect", { x, width: bw, y: y(d.available), height: y(0) - y(d.available), rx: 4, class: "dpc-time-avail" }));
      let acc = 0;
      for (const k of keys) {
        const v = d.byType[k] || 0;
        if (v < 0.01) continue;
        present.add(k);
        const r = s(doc, "rect", { x, width: bw, y: y(acc + v), height: Math.max(0, y(acc) - y(acc + v)), rx: 2, style: `fill:${typeColor(cfg, k)}` });
        hover(r, `${dowOf(d.date)} ${fmtD(d.date)} · ${typeName(k, cfg)}: ${fmtDur(v)} of ${fmtDur(d.total)}`);
        g.append(r); acc += v;
      }
      g.append(s(doc, "text", { x: x + bw / 2, y: H - 6, class: "dpc-tick" + (d.date === today ? " is-current" : ""), "text-anchor": "middle" }, dowOf(d.date)));
      if (!future) {
        const go = () => set({ mode: "day", date: d.date });
        g.addEventListener("click", go); g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      }
      svg.append(g);
    });
    if (R.elapsed) {
      svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(R.average), y2: y(R.average), class: "dpc-time-avg" }));
      svg.append(s(doc, "text", { x: W - padR, y: y(R.average) - 5, class: "dpc-tick dpc-time-avg-label", "text-anchor": "end" }, `avg ${fmtDur(R.average)}`));
    }
    wrap.append(svg, tip);
  }
  const lg = h(doc, "div", { class: "dpc-legend" }, keys.filter(k => present.has(k)).map(k =>
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), typeName(k, cfg))),
    T.mode === "week" ? h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch dpc-time-avail-sw" }), "Available") : null);
  body.append(wrap, lg);
  if (T.mode === "day" && R.untimed > 0.01) body.append(h(doc, "p", { class: "dpc-muted dpc-time-note" }, `${fmtDur(R.untimed)} logged without a start and end time is in the total but not on the chart. Logs you add in dotpm from now on get times automatically.`));
  if (T.mode === "week") body.append(h(doc, "p", { class: "dpc-muted dpc-time-note" }, "Click a day to open it."));

  if (!R.rows.length) { body.append(h(doc, "p", { class: "dpc-muted" }, T.mode === "day" ? "No time logged on this day." : "No time logged this week.")); return; }

  // where the time went
  const projColor = name => (st.projectColors && st.projectColors[name]) || "var(--dpc-none)";
  const groups = T.group === "type"
    ? Object.entries(R.byType).map(([k, v]) => ({ name: typeName(k, cfg), v, color: typeColor(cfg, k) }))
    : Object.entries(R.byProject).map(([k, v]) => ({ name: k === M.NO_PROJECT ? "No project" : k, v, color: projColor(k) }));
  groups.sort((a, b) => b.v - a.v);
  body.append(h(doc, "div", { class: "dpc-time-sec" }, h(doc, "h4", { class: "dpc-h" }, "Where the time went"),
    seg([["type", "Work type"], ["project", "Project"]], T.group, g => set({ group: g }), "Group by")));
  body.append(h(doc, "div", { class: "dpc-time-groups" }, groups.map(g => h(doc, "div", { class: "dpc-time-group" },
    h(doc, "span", { class: "dpc-swatch", style: `background:${g.color}` }), h(doc, "span", { class: "dpc-time-gname" }, g.name),
    h(doc, "span", { class: "dpc-muted dpc-num" }, `${fmtDur(g.v)} · ${Math.round((g.v / R.total) * 100)}%`),
    h(doc, "div", { class: "dpc-time-gbar" }, h(doc, "div", { style: `width:${(g.v / groups[0].v) * 100}%;background:${g.color}` }))))));

  // time by task
  body.append(h(doc, "h4", { class: "dpc-h" }, "Time by task"));
  body.append(h(doc, "div", { class: "dpc-legend" },
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-time-sw" }), T.mode === "day" ? "this day" : "this week"),
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-time-sw is-before" }), "earlier"),
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-time-tick-sw" }), "estimate × multiplier")));
  const scale = Math.max(1, ...R.rows.map(r => Math.max(r.budget || 0, r.logged)));
  const pct = v => `${(Math.min(v, scale) / scale) * 100}%`;
  body.append(h(doc, "div", { class: "dpc-time-rows" }, R.rows.map(r => {
    const t = r.task, color = typeColor(cfg, r.type), beforeIn = Math.min(r.before, r.budget != null ? r.budget : r.before);
    const capped = r.budget != null ? Math.min(r.before + r.here, r.budget) : r.before + r.here;
    const status = r.budget == null ? "no estimate"
      : r.over ? `over by ${fmtDur(r.logged - r.budget)}` : r.done ? "finished" : `${fmtDur(r.budget - r.logged)} left`;
    const sess = r.sessions.map(l => (T.mode === "week" ? dowOf(l.date) + " " : "") + (l.start && l.end ? `${l.start}–${l.end}` : fmtDur(l.hours)) + (l.note ? ` ${l.note}` : "")).join("   ");
    return h(doc, "div", { class: "dpc-time-row" },
      h(doc, "div", { class: "dpc-time-rtop" },
        h(doc, "div", { class: "dpc-time-rname" }, taskLink(doc, t, on),
          h(doc, "div", { class: "dpc-muted dpc-time-meta" }, t.project || "No project", " · ", h(doc, "span", { class: "dpc-swatch", style: `background:${color}` }), typeName(r.type, cfg),
            t.estimate > 0 ? ` · est ${fmtH(t.estimate)} × ${fmtX(M.multiplierFor(mults, r.type))}` : "")),
        h(doc, "span", { class: "dpc-time-here dpc-num" }, fmtDur(r.here))),
      h(doc, "div", { class: "dpc-time-cmp" },
        h(doc, "div", { class: "dpc-time-track" },
          h(doc, "div", { class: "dpc-time-fill is-before", style: `left:0;width:${pct(beforeIn)};background:${color}` }),
          h(doc, "div", { class: "dpc-time-fill", style: `left:${pct(beforeIn)};width:calc(${pct(capped)} - ${pct(beforeIn)});background:${color}` }),
          r.over ? h(doc, "div", { class: "dpc-time-over", style: `left:${pct(r.budget)};width:calc(${pct(r.logged)} - ${pct(r.budget)})` }) : null,
          r.budget != null ? h(doc, "div", { class: "dpc-time-tick", style: `left:${pct(r.budget)}`, title: `Estimate × multiplier: ${fmtH(r.budget)}` }) : null),
        h(doc, "span", { class: "dpc-muted dpc-num dpc-time-of" }, r.budget != null ? `${fmtDur(r.logged)} of ${fmtDur(r.budget)} · ` : `${fmtDur(r.logged)} · `,
          h(doc, "span", { class: r.over ? "dpc-time-bad" : "" }, status))),
      sess ? h(doc, "div", { class: "dpc-muted dpc-time-sess" }, sess) : null);
  })));
}

// ---------- multipliers ----------
function renderMultipliers(body, st, on) {
  const doc = body.ownerDocument, cfg = st.cfg, R = st.result, set = st.settings;
  const keys = typeKeys(cfg);
  body.append(h(doc, "p", { class: "dpc-muted" }, "How much longer each kind of work takes than you estimate. Capacity, at-risk and the queue's “Left ×” use these. Every change is recorded so you can see the trend."));
  const tb = h(doc, "tbody");
  for (const k of keys) {
    const m = R.measured[k];
    const input = h(doc, "input", { type: "number", min: "0.1", max: "10", step: "0.1", value: String(M.multiplierFor(set.multipliers, k)), class: "dpc-mult-input", "aria-label": `${typeName(k, cfg)} multiplier` });
    input.addEventListener("change", () => { const v = parseFloat(input.value); if (isFinite(v) && v > 0) on.setMultiplier(k, Math.round(v * 100) / 100); });
    tb.append(h(doc, "tr", {},
      h(doc, "td", {}, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), typeName(k, cfg)),
      h(doc, "td", {}, input, " ×"),
      h(doc, "td", { class: m ? "" : "dpc-muted" }, m ? `${fmtX(m.factor)} from ${m.n} done task${m.n === 1 ? "" : "s"}` : "no done tasks with time logs yet")));
  }
  body.append(h(doc, "table", { class: "dpc-table dpc-mults" }, h(doc, "thead", {}, h(doc, "tr", {}, ["Work type", "Multiplier", "Measured (logged ÷ estimate)"].map(c => h(doc, "th", {}, c)))), tb));
  body.append(h(doc, "h4", { class: "dpc-h" }, "Trend"));
  body.append(trendChart(doc, body, cfg, set.multiplierHistory || [], keys, R.today, R.measuredSeries || {}));
}
function trendChart(doc, body, cfg, history, keys, today, measuredSeries) {
  const wrap = h(doc, "div", { class: "dpc-chart-wrap" });
  if (!history.length) { wrap.append(h(doc, "p", { class: "dpc-muted" }, "No history yet.")); return wrap; }
  const mDates = Object.values(measuredSeries).flat().map(p => p.date);
  const first = [history[0].date, ...mDates].sort()[0];
  const last = M.diffDays(first, today) < 13 ? M.addDays(first, 13) : today;
  const span = M.diffDays(first, last);
  const vals = history.map(p => p.value).concat(Object.values(measuredSeries).flat().map(p => p.value));
  const yMax = Math.max(2.5, Math.ceil((Math.max(...vals) + 0.25) * 2) / 2), yMin = 0;
  const W = Math.max(320, Math.min(760, body.clientWidth || 640)), H = 220, padL = 36, padR = 120, padT = 10, padB = 26;
  const x = d => padL + (W - padL - padR) * (M.diffDays(first, d) / span);
  const y = v => padT + (H - padT - padB) * (1 - (v - yMin) / (yMax - yMin));
  const svg = s(doc, "svg", { class: "dpc-chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Multiplier per work type over time" });
  for (let v = 0; v <= yMax + 0.001; v += 0.5) {
    svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? "dpc-axis" : v === 1 ? "dpc-ref" : "dpc-grid" }));
    svg.append(s(doc, "text", { x: padL - 6, y: y(v) + 4, class: "dpc-tick", "text-anchor": "end" }, `${v}×`));
  }
  const ticks = Math.min(6, span);
  for (let i = 0; i <= ticks; i++) {
    const d = M.addDays(first, Math.round((span * i) / ticks));
    svg.append(s(doc, "text", { x: x(d), y: H - 8, class: "dpc-tick", "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" }, fmtD(d)));
  }
  if (today <= last) svg.append(s(doc, "line", { x1: x(today), x2: x(today), y1: padT, y2: H - padB, class: "dpc-today" }));
  const ends = {};
  const shown = keys.filter(k => history.some(p => p.type === k));
  for (const k of shown) {
    const pts = history.filter(p => p.type === k);
    let d = "", prev = null;
    for (const p of pts) {
      if (prev == null) d += `M${x(p.date)},${y(p.value)}`;
      else d += ` H${x(p.date)} V${y(p.value)}`;
      prev = p.value;
    }
    d += ` H${x(today < last ? today : last)}`;
    svg.append(s(doc, "path", { d, class: "dpc-line", stroke: typeColor(cfg, k) }));
    for (const p of pts) svg.append(s(doc, "circle", { cx: x(p.date), cy: y(p.value), r: 4, fill: typeColor(cfg, k), class: "dpc-pt" }));
    const v = prev;
    (ends[v] = ends[v] || []).push(k);
  }
  // measured factor from time logs: dashed, same hue, square markers
  for (const k of keys) {
    const pts = (measuredSeries[k] || []).filter(p => p.date <= last);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.date)},${y(p.value)}`).join(" ") + (pts.length === 1 ? ` L${x(pts[0].date) + 0.01},${y(pts[0].value)}` : "");
    svg.append(s(doc, "path", { d, class: "dpc-line dpc-line-measured", stroke: typeColor(cfg, k) }));
    for (const p of pts) svg.append(s(doc, "rect", { x: x(p.date) - 4, y: y(p.value) - 4, width: 8, height: 8, rx: 2, fill: typeColor(cfg, k), class: "dpc-pt" }));
  }
  // direct end labels, grouped when several types share a value
  const labelY = Object.keys(ends).map(Number).sort((a, b) => b - a).map(v => ({ v, y: y(v) }));
  for (let i = 1; i < labelY.length; i++) if (labelY[i].y - labelY[i - 1].y < 14) labelY[i].y = labelY[i - 1].y + 14;
  for (const L of labelY) {
    const names = ends[L.v].map(typeName);
    const txt = names.length > 2 ? `${names.length} types` : names.join(", ");
    svg.append(s(doc, "text", { x: W - padR + 6, y: L.y + 4, class: "dpc-end-label" }, `${txt} ${fmtX(L.v)}`));
  }
  // crosshair + tooltip
  const cross = s(doc, "line", { y1: padT, y2: H - padB, class: "dpc-cross" });
  const hit = s(doc, "rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, class: "dpc-hit" });
  svg.append(cross, hit);
  const tip = h(doc, "div", { class: "dpc-tip" });
  hit.addEventListener("mousemove", e => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) * (W / box.width);
    const day = M.addDays(first, Math.max(0, Math.min(span, Math.round(((px - padL) / (W - padL - padR)) * span))));
    cross.setAttribute("x1", x(day)); cross.setAttribute("x2", x(day)); cross.classList.add("is-on");
    tip.replaceChildren(h(doc, "strong", {}, fmtD(day)), ...shown.map(k => {
      const v = M.multiplierOn(history, k, day);
      const ms = (measuredSeries[k] || []).filter(p => p.date <= day).pop();
      return h(doc, "div", {}, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), `${typeName(k, cfg)}: ${v == null ? "—" : fmtX(v)}`,
        ms ? h(doc, "span", { class: "dpc-muted" }, ` · measured ${fmtX(ms.value)} (${ms.n})`) : null);
    }));
    tip.classList.add("is-on");
    placeTip(tip, wrap, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => { tip.classList.remove("is-on"); cross.classList.remove("is-on"); });
  const anyMeasured = Object.keys(measuredSeries).length > 0;
  wrap.append(legend(doc, cfg, shown, false),
    h(doc, "div", { class: "dpc-legend dpc-legend-key" },
      h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-key-solid" }), "your multiplier"),
      h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-key-dash" }), anyMeasured ? "measured from time logs (logged ÷ estimate of done tasks)" : "measured from time logs — appears once a task with logged time is done")),
    svg, tip);
  const changes = history.slice().reverse();
  wrap.append(h(doc, "details", { class: "dpc-details" }, h(doc, "summary", {}, `Change history (${changes.length})`),
    h(doc, "table", { class: "dpc-table" }, h(doc, "thead", {}, h(doc, "tr", {}, ["Date", "Work type", "Multiplier"].map(c => h(doc, "th", {}, c)))),
      h(doc, "tbody", {}, changes.map(p => h(doc, "tr", {}, h(doc, "td", {}, fmtD(p.date)), h(doc, "td", {}, typeName(p.type, cfg)), h(doc, "td", {}, fmtX(p.value))))))));
  return wrap;
}

module.exports = { render, gitChip, typeColor, typeKeys, typeName, fmtH, fmtX };
