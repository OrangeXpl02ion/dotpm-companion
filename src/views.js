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
function typeKeys(cfg) { return [...cfg.workTypes, M.NO_TYPE]; }
function typeName(k) { return k === M.NO_TYPE ? "No work-type" : k; }
function typeColor(cfg, k) {
  const i = cfg.workTypes.indexOf(k);
  return i === -1 || i > 7 ? "var(--dpc-none)" : `var(--dpc-s${i + 1})`;
}

// ---------- shell ----------
const TABS = [["tasks", "All tasks"], ["capacity", "Capacity"], ["queue", "Queue"], ["types", "Work types"], ["multipliers", "Multipliers"]];
function render(root, st, on) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.classList.add("dpc-root");
  const bar = h(doc, "div", { class: "dpc-bar" },
    h(doc, "div", { class: "dpc-tabs", role: "tablist" }, TABS.map(([id, name]) =>
      h(doc, "button", { class: "dpc-tab" + (st.tab === id ? " is-active" : ""), role: "tab", "aria-selected": st.tab === id, onclick: () => on.setTab(id) }, name))),
    st.tab === "queue" || st.tab === "types"
      ? h(doc, "div", { class: "dpc-seg", role: "group", "aria-label": "Hours shown" },
          [["adj", "× multipliers"], ["raw", "Raw estimates"]].map(([id, name]) =>
            h(doc, "button", { class: "dpc-seg-btn" + (st.mode === id ? " is-active" : ""), "aria-pressed": st.mode === id, onclick: () => on.setMode(id) }, name)))
      : null);
  root.append(bar);
  if (!st.result) { root.append(h(doc, "p", { class: "dpc-muted" }, "Reading tasks…")); return; }
  const body = h(doc, "div", { class: "dpc-body" });
  root.append(body);
  ({ tasks: renderTasks, capacity: renderCapacity, queue: renderQueue, types: renderTypes, multipliers: renderMultipliers }[st.tab] || renderTasks)(body, st, on);
}

function taskLink(doc, t, on) {
  return h(doc, "a", { class: "dpc-task-link", href: "#", onclick: e => { e.preventDefault(); on.openTask(t.path); } }, t.title);
}
function riskBadge(doc, r) {
  if (!r) return null;
  const tip = r.overdue ? "Past its due date with work left" : `Needs ${fmtH(r.need)} (with multiplier) in ${r.days} day${r.days === 1 ? "" : "s"}; ${fmtH(r.available)} available`;
  return h(doc, "span", { class: "dpc-badge dpc-badge-risk", title: tip }, h(doc, "span", { class: "dpc-badge-icon", "aria-hidden": "true" }, "!"), r.overdue ? "Overdue" : "At risk");
}

// ---------- all tasks ----------
function projectPathOf(path) { const i = path.indexOf("/_tasks/"); return i === -1 ? path.replace(/\/[^/]+$/, "") : path.slice(0, i); }
function select(doc, list, value, label, onchange) {
  const el = h(doc, "select", { class: "dropdown dpc-select", "aria-label": label });
  for (const o of list) el.append(h(doc, "option", { value: o.id, selected: o.id === value }, o.label));
  if (!list.some(o => o.id === value)) el.append(h(doc, "option", { value, selected: true }, value || "—"));
  el.addEventListener("click", e => e.stopPropagation());
  el.addEventListener("change", () => onchange(el.value));
  return el;
}
function renderTasks(body, st, on) {
  const doc = body.ownerDocument, R = st.result, cfg = st.cfg, today = R.today, root = st.settings.projectsFolder || cfg.projectsFolder;
  const showDone = !!st.settings.showDone;
  const visible = st.tasks.filter(t => showDone || !M.isComplete(cfg, t.status));
  const groups = new Map();
  for (const t of visible) { const g = projectPathOf(t.path); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const search = h(doc, "input", { type: "search", class: "dpc-search", placeholder: "Filter tasks…", value: st.query || "", "aria-label": "Filter tasks" });
  const doneBox = h(doc, "input", { type: "checkbox", checked: showDone, id: "dpc-showdone" });
  doneBox.addEventListener("change", () => on.setShowDone(doneBox.checked));
  const openCount = st.tasks.filter(t => !M.isComplete(cfg, t.status)).length;
  body.append(h(doc, "div", { class: "dpc-toolbar" }, search,
    h(doc, "label", { class: "dpc-check", for: "dpc-showdone" }, doneBox, " Show done"),
    h(doc, "span", { class: "dpc-muted dpc-right" }, `${openCount} open · ${st.tasks.length} total`),
    st.bridged === false ? h(doc, "span", { class: "dpc-muted", title: "dotpm isn't loaded, so changes are written to the files directly" }, "· dotpm not loaded") : null));
  if (!keys.length) { body.append(h(doc, "p", { class: "dpc-muted" }, showDone ? "No tasks." : "No open tasks.")); return; }
  const tb = h(doc, "tbody");
  const prio = t => M.priorityRank(cfg, t.priority);
  for (const g of keys) {
    const list = groups.get(g).sort((a, b) =>
      (M.isComplete(cfg, a.status) - M.isComplete(cfg, b.status)) || (a.start || "9999").localeCompare(b.start || "9999") || (a.due || "9999").localeCompare(b.due || "9999") || prio(a) - prio(b));
    const crumbs = g.startsWith(root) ? g.slice(root.length).split("/") : g.split("/");
    const left = list.filter(t => !M.isComplete(cfg, t.status)).reduce((a, t) => a + M.remaining(t), 0);
    const closed = st.collapsed && st.collapsed.has(g);
    const head = h(doc, "tr", { class: "dpc-group", tabindex: 0, "aria-expanded": !closed, "data-group": g,
      onclick: () => on.toggleGroup(g), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); on.toggleGroup(g); } } },
      h(doc, "td", { colspan: 8 }, h(doc, "span", { class: "dpc-caret", "aria-hidden": "true" }, closed ? "▸" : "▾"),
        crumbs.slice(0, -1).map(c => h(doc, "span", { class: "dpc-muted" }, `${c} › `)), h(doc, "strong", {}, crumbs.at(-1)),
        h(doc, "span", { class: "dpc-muted" }, `  ${list.length} task${list.length === 1 ? "" : "s"}${left ? ` · ${fmtH(left)} left` : ""}`)));
    tb.append(head);
    if (closed) continue;
    for (const t of list) {
      const done = M.isComplete(cfg, t.status);
      const risk = R.risk[t.path];
      const hours = t.estimate != null ? `${fmtH(t.logged).replace("h", "")}/${fmtH(t.estimate)}` : (t.logged ? fmtH(t.logged) : "");
      const pct = Math.max(0, Math.min(100, t.progress || 0));
      tb.append(h(doc, "tr", { class: "dpc-task-row" + (done ? " is-done" : ""), "data-group": g,
        "data-search": `${t.title} ${t.project} ${t.workType || ""} ${M.label(cfg.statuses, t.status)} ${M.label(cfg.priorities, t.priority)}`.toLowerCase() },
        h(doc, "td", { class: "dpc-title-cell" }, t.type === "milestone" ? h(doc, "span", { class: "dpc-muted", title: "Milestone" }, "◆ ") : null,
          taskLink(doc, t, on), " ", riskBadge(doc, risk),
          h(doc, "button", { class: "dpc-icon-btn", title: "Open the note", "aria-label": `Open note for ${t.title}`, onclick: e => { e.stopPropagation(); on.openFile(t.path); } }, "↗")),
        h(doc, "td", {}, select(doc, cfg.statuses, t.status, `Status of ${t.title}`, v => on.setField(t.path, "status", v))),
        h(doc, "td", {}, select(doc, cfg.priorities, t.priority, `Priority of ${t.title}`, v => on.setField(t.path, "priority", v))),
        h(doc, "td", { class: "dpc-nowrap dpc-muted" }, t.start ? fmtD(t.start) : ""),
        h(doc, "td", { class: "dpc-nowrap" + (!done && t.due && t.due < today ? " dpc-warn" : "") }, t.due ? fmtD(t.due) : ""),
        h(doc, "td", { class: "dpc-num dpc-muted" }, hours),
        h(doc, "td", {}, h(doc, "div", { class: "dpc-prog" }, h(doc, "div", { class: "dpc-meter dpc-meter-sm", role: "img", "aria-label": `${pct}% done` }, h(doc, "div", { class: "dpc-meter-fill", style: `width:${pct}%` })),
          h(doc, "span", { class: "dpc-pct" }, `${pct}%`))),
        h(doc, "td", {}, t.workType ? h(doc, "span", { class: "dpc-type" }, h(doc, "span", { class: "dpc-dot", style: `background:${typeColor(cfg, t.workType)}` }), t.workType) : "")));
    }
  }
  const table = h(doc, "table", { class: "dpc-table dpc-tasks" },
    h(doc, "thead", {}, h(doc, "tr", {}, ["Task", "Status", "Priority", "Start", "Due", "Hours", "Progress", "Type"].map((c, i) => h(doc, "th", { class: i === 5 ? "dpc-num" : null }, c)))), tb);
  const empty = h(doc, "p", { class: "dpc-muted", style: "display:none" }, "No tasks match.");
  body.append(h(doc, "div", { class: "dpc-scroll" }, table), empty);
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    on.setQuery(search.value);
    let shown = 0; const live = new Set();
    for (const r of table.querySelectorAll(".dpc-task-row")) {
      const ok = !q || q.split(/\s+/).every(w => r.dataset.search.includes(w));
      r.style.display = ok ? "" : "none";
      if (ok) { shown++; live.add(r.dataset.group); }
    }
    for (const r of table.querySelectorAll(".dpc-group")) r.style.display = !q || live.has(r.dataset.group) ? "" : "none";
    empty.style.display = q && !shown ? "" : "none";
  };
  search.addEventListener("input", apply);
  if (st.query) apply();
}

// ---------- capacity ----------
function renderCapacity(body, st, on) {
  const doc = body.ownerDocument, R = st.result;
  const cur = R.weeks.find(w => w.isCurrent);
  const riskCount = Object.keys(R.risk).length;
  const over = R.weeks.filter(w => w.overloaded && !w.isPast).length;
  body.append(h(doc, "div", { class: "dpc-tiles" },
    tile(doc, "This week", cur ? `${fmtH(cur.adj)} of ${fmtH(cur.available)}` : "—", cur ? `${Math.round(cur.pct * 100)}% committed · ${fmtH(cur.raw)} raw` : "outside the planning range"),
    tile(doc, "Overloaded weeks", String(over), `at ${st.settings.overloadPct}% or more`),
    tile(doc, "At risk", String(riskCount), riskCount ? "see the list below" : "nothing at risk")));

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
      h(doc, "td", { class: "dpc-num" + (w.fromFile ? "" : " dpc-muted"), title: w.fromFile ? `From ${st.settings.capacityFile}` : "Default (not in the capacity file)" }, fmtH(w.available)),
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

  const risky = st.tasks.filter(t => R.risk[t.path]).sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  body.append(h(doc, "h4", { class: "dpc-h" }, "At risk"));
  body.append(risky.length ? h(doc, "ul", { class: "dpc-list" }, risky.map(t => {
    const r = R.risk[t.path];
    return h(doc, "li", {}, riskBadge(doc, r), " ", taskLink(doc, t, on),
      h(doc, "span", { class: "dpc-muted" }, r.overdue ? ` · was due ${fmtD(t.due)}, ${fmtH(r.need)} left with multiplier`
        : ` · needs ${fmtH(r.need)} by ${fmtD(t.due)}, ${fmtH(r.available)} available`));
  })) : h(doc, "p", { class: "dpc-muted" }, "No task needs more hours than are available before its due date."));

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
  if (!R.queue.length) { body.append(h(doc, "p", { class: "dpc-muted" }, "No open tasks.")); return; }
  const tb = h(doc, "tbody");
  R.queue.forEach((t, i) => {
    const hrs = st.mode === "raw" ? M.remaining(t) : M.adjusted(t, mults);
    tb.append(h(doc, "tr", {},
      h(doc, "td", { class: "dpc-num dpc-muted" }, String(i + 1)),
      h(doc, "td", {}, h(doc, "span", { class: `dpc-pri dpc-pri-${t.priority}` }, M.label(st.cfg.priorities, t.priority) || "—")),
      h(doc, "td", { class: "dpc-title-cell" }, taskLink(doc, t, on), h(doc, "div", { class: "dpc-muted dpc-sub" }, [t.project, t.workType].filter(Boolean).join(" · ")),
        t.checklist ? h(doc, "div", { class: "dpc-muted dpc-sub" }, `${t.checklist.done}/${t.checklist.total} done-when`) : null),
      h(doc, "td", { class: "dpc-nowrap" + (R.risk[t.path] && R.risk[t.path].overdue ? " dpc-warn" : ""), title: t.due ? null : "No due date" }, relDue(t.due, R.today)),
      h(doc, "td", { class: "dpc-num" }, t.type === "milestone" ? "◆" : fmtH(hrs)),
      h(doc, "td", {}, riskBadge(doc, R.risk[t.path])),
      h(doc, "td", {}, h(doc, "button", { class: "dpc-done", title: "Mark done", "aria-label": `Mark ${t.title} done`, onclick: () => on.markDone(t.path) }, "✓"))));
  });
  body.append(h(doc, "table", { class: "dpc-table dpc-queue" },
    h(doc, "thead", {}, h(doc, "tr", {}, ["#", "Priority", "Task", "Due", st.mode === "raw" ? "Left" : "Left ×", "", ""].map((c, i) => h(doc, "th", { class: i === 0 || i === 4 ? "dpc-num" : null }, c)))), tb));
  if (R.upcoming) {
    const later = st.tasks.filter(t => !M.isComplete(st.cfg, t.status) && t.start && t.start > R.today).sort((a, b) => a.start.localeCompare(b.start) || M.priorityRank(st.cfg, a.priority) - M.priorityRank(st.cfg, b.priority));
    body.append(h(doc, "details", { class: "dpc-details" }, h(doc, "summary", {}, `Starting later (${later.length})`),
      h(doc, "ul", { class: "dpc-list" }, later.map(t => h(doc, "li", {}, h(doc, "span", { class: "dpc-muted dpc-nowrap dpc-start" }, `starts ${fmtD(t.start)}`), taskLink(doc, t, on),
        h(doc, "span", { class: "dpc-muted" }, ` · ${t.project}`), riskBadge(doc, R.risk[t.path]))))));
  }
}

// ---------- work types (stacked bars per week) ----------
function renderTypes(body, st, on) {
  const doc = body.ownerDocument, R = st.result, cfg = st.cfg;
  const keys = typeKeys(cfg);
  const field = st.mode === "raw" ? "rawByType" : "byType";
  const present = keys.filter(k => R.weeks.some(w => (w[field][k] || 0) > 0.05));
  const totals = R.weeks.map(w => present.reduce((a, k) => a + (w[field][k] || 0), 0));
  const maxV = Math.max(1, ...totals, ...R.weeks.map(w => w.available));
  const W = Math.max(320, Math.min(760, (body.clientWidth || 640))), H = 240, padL = 40, padR = 8, padT = 12, padB = 28;
  const cw = (W - padL - padR) / R.weeks.length, bw = Math.min(44, cw * 0.62);
  const y = v => padT + (H - padT - padB) * (1 - v / maxV);
  const step = niceStep(maxV);
  const svg = s(doc, "svg", { class: "dpc-chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Committed hours per week by work type, ${st.mode === "raw" ? "raw estimates" : "with multipliers"}` });
  for (let v = 0; v <= maxV + 0.001; v += step) {
    svg.append(s(doc, "line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? "dpc-axis" : "dpc-grid" }));
    svg.append(s(doc, "text", { x: padL - 6, y: y(v) + 4, class: "dpc-tick", "text-anchor": "end" }, `${v}h`));
  }
  const wrap = h(doc, "div", { class: "dpc-chart-wrap" });
  const tip = h(doc, "div", { class: "dpc-tip", role: "status" });
  R.weeks.forEach((w, i) => {
    const cx = padL + cw * i + cw / 2, x = cx - bw / 2;
    let acc = 0;
    const segs = present.filter(k => (w[field][k] || 0) > 0.05);
    segs.forEach((k, j) => {
      const v = w[field][k], y0 = y(acc), y1 = y(acc + v), top = j === segs.length - 1;
      const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
      const yy = y1;
      const r = top ? Math.min(4, hgt, bw / 2) : 0;
      const d = `M${x},${yy + hgt} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + hgt} Z`;
      const seg = s(doc, "path", { d, fill: typeColor(cfg, k), class: "dpc-seg-mark", tabindex: 0 });
      const show = e => {
        tip.textContent = `${w.week.slice(5)} · ${typeName(k)}: ${fmtH(v)} of ${fmtH(totals[i])}`; tip.classList.add("is-on");
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
  body.append(legend(doc, cfg, present, true), wrap);
  // table view
  const t = h(doc, "table", { class: "dpc-table dpc-types-table" },
    h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, "Week"), present.map(k => h(doc, "th", { class: "dpc-num" }, typeName(k))), h(doc, "th", { class: "dpc-num" }, "Total"), h(doc, "th", { class: "dpc-num" }, "Available"))),
    h(doc, "tbody", {}, R.weeks.map((w, i) => h(doc, "tr", { class: w.isCurrent ? "is-current" : "" }, h(doc, "td", {}, w.week.slice(5)),
      present.map(k => h(doc, "td", { class: "dpc-num" }, w[field][k] ? fmtH(w[field][k]) : "")),
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
    h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), typeName(k))),
    withCap ? h(doc, "span", { class: "dpc-legend-item" }, h(doc, "span", { class: "dpc-swatch-line" }), "Available") : null);
}

// ---------- multipliers ----------
function renderMultipliers(body, st, on) {
  const doc = body.ownerDocument, cfg = st.cfg, R = st.result, set = st.settings;
  const keys = typeKeys(cfg);
  body.append(h(doc, "p", { class: "dpc-muted" }, "How much longer each kind of work takes than you estimate. Capacity, at-risk and the queue's “Left ×” use these. Every change is recorded so you can see the trend."));
  const tb = h(doc, "tbody");
  for (const k of keys) {
    const m = R.measured[k];
    const input = h(doc, "input", { type: "number", min: "0.1", max: "10", step: "0.1", value: String(M.multiplierFor(set.multipliers, k)), class: "dpc-mult-input", "aria-label": `${typeName(k)} multiplier` });
    input.addEventListener("change", () => { const v = parseFloat(input.value); if (isFinite(v) && v > 0) on.setMultiplier(k, Math.round(v * 100) / 100); });
    tb.append(h(doc, "tr", {},
      h(doc, "td", {}, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), typeName(k)),
      h(doc, "td", {}, input, " ×"),
      h(doc, "td", { class: m ? "" : "dpc-muted" }, m ? `${fmtX(m.factor)} from ${m.n} done task${m.n === 1 ? "" : "s"}` : "no done tasks with time logs yet")));
  }
  body.append(h(doc, "table", { class: "dpc-table dpc-mults" }, h(doc, "thead", {}, h(doc, "tr", {}, ["Work type", "Multiplier", "Measured (logged ÷ estimate)"].map(c => h(doc, "th", {}, c)))), tb));
  body.append(h(doc, "h4", { class: "dpc-h" }, "Trend"));
  body.append(trendChart(doc, body, cfg, set.multiplierHistory || [], keys, R.today));
}
function trendChart(doc, body, cfg, history, keys, today) {
  const wrap = h(doc, "div", { class: "dpc-chart-wrap" });
  if (!history.length) { wrap.append(h(doc, "p", { class: "dpc-muted" }, "No history yet.")); return wrap; }
  const first = history[0].date;
  const last = M.diffDays(first, today) < 13 ? M.addDays(first, 13) : today;
  const span = M.diffDays(first, last);
  const vals = history.map(p => p.value);
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
      return h(doc, "div", {}, h(doc, "span", { class: "dpc-swatch", style: `background:${typeColor(cfg, k)}` }), `${typeName(k)}: ${v == null ? "—" : fmtX(v)}`);
    }));
    tip.classList.add("is-on");
    placeTip(tip, wrap, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => { tip.classList.remove("is-on"); cross.classList.remove("is-on"); });
  wrap.append(legend(doc, cfg, shown, false), svg, tip);
  const changes = history.slice().reverse();
  wrap.append(h(doc, "details", { class: "dpc-details" }, h(doc, "summary", {}, `Change history (${changes.length})`),
    h(doc, "table", { class: "dpc-table" }, h(doc, "thead", {}, h(doc, "tr", {}, ["Date", "Work type", "Multiplier"].map(c => h(doc, "th", {}, c)))),
      h(doc, "tbody", {}, changes.map(p => h(doc, "tr", {}, h(doc, "td", {}, fmtD(p.date)), h(doc, "td", {}, typeName(p.type)), h(doc, "td", {}, fmtX(p.value))))))));
  return wrap;
}

module.exports = { render, typeColor, typeKeys, typeName, fmtH, fmtX };
