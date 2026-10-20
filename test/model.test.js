"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/model.js");
const fx = require("./fixture/vault.json");
const cfg = M.readDotpmConfig(fx.dotpm);
const tasks = fx.tasks.map(t => M.parseTask(t.path, t.fm, t.body, cfg)).filter(Boolean);
const settings = { rangeStart: "2026-10-19", rangeEnd: "2026-12-11", defaultWeeklyHours: 40, overloadPct: 85, capacity: {},
  multipliers: Object.fromEntries([...cfg.workTypes, M.NO_TYPE].map(k => [k, 2])) };

test("reads dotpm settings", () => {
  assert.equal(cfg.projectsFolder, "Project/");
  assert.equal(cfg.workTypeFieldId, "9as32nw7mvg3hsfb");
  assert.deepEqual(cfg.workTypes, ["CAD", "Render", "Layout", "Writing", "Fabrication", "Research"]);
  assert.equal(M.doneStatusId(cfg), "done");
});

test("parses every real task file, quoted or unquoted", () => {
  assert.equal(tasks.length, 38);
  const k = tasks.find(t => t.title === "Toaster web page");
  assert.equal(k.start, "2026-11-24"); assert.equal(k.due, "2026-11-27");
  assert.equal(k.estimate, 8); assert.equal(k.workType, "Layout"); assert.equal(k.project, "Toaster");
  const g = tasks.find(t => t.title === "Lantern hero and context renders");
  assert.equal(g.logged, 2); assert.deepEqual(g.checklist, { done: 2, total: 3 });
  assert.equal(M.checklistProgress(g.checklist), 67);
  const s = tasks.find(t => t.title === "study for quiz");
  assert.equal(s.due, null);
  const m = tasks.find(t => t.title === "Lantern Nov 9 presentation");
  assert.equal(m.type, "milestone");
});

test("Date objects and blank dates", () => {
  assert.equal(M.normDate(new Date("2026-11-24T00:00:00Z")), "2026-11-24");
  assert.equal(M.normDate(""), null);
  assert.equal(M.normDate("2026-11-24T10:00:00.000Z"), "2026-11-24");
});

test("checklist stops at the next section and ignores other lists", () => {
  const body = "Intro\n- [x] not counted\n\n## Done when\n- [x] a\n- [ ] b\n* [X] c\n\nProject: [[K|K]]\n\n## Subtasks\n- [x] [[s|s]]\n";
  assert.deepEqual(M.parseChecklist(body), { done: 2, total: 3 });
  assert.equal(M.parseChecklist("no list"), null);
  assert.equal(M.parseChecklist("## Done when\n\ntext only"), null);
});

test("ISO weeks", () => {
  assert.equal(M.isoWeek("2026-10-19"), "2026-W43");
  assert.equal(M.isoWeek("2026-12-11"), "2026-W50");
  assert.equal(M.isoWeek("2027-01-01"), "2026-W53");
  assert.equal(M.mondayOf("2026-10-25"), "2026-10-19");
});

test("spread rule", () => {
  const t = { due: "2026-10-25", start: "2026-10-10" };
  const s = M.spread(t, 14, "2026-10-19"); // past start counts from today: 7 days
  assert.equal(s.length, 7); assert.equal(s[0][0], "2026-10-19"); assert.equal(s[0][1], 2);
  assert.deepEqual(M.spread({ due: "2026-10-01" }, 5, "2026-10-19"), [["2026-10-19", 5]]); // overdue → today
  assert.equal(M.spread({ due: null }, 5, "2026-10-19"), null);
  assert.equal(M.spread({ due: "2026-11-01", start: "2026-10-30" }, 3, "2026-10-19").length, 3); // future start
});

test("capacity totals equal remaining hours (nothing lost or double-counted)", () => {
  const today = "2026-10-20";
  const R = M.compute(tasks, cfg, settings, today);
  const open = tasks.filter(t => !M.isComplete(cfg, t.status) && t.due && M.remaining(t) > 0 && t.due <= "2026-12-13");
  const rawSum = open.reduce((a, t) => a + M.remaining(t), 0);
  const weeksRaw = R.weeks.reduce((a, w) => a + w.raw, 0);
  assert.ok(Math.abs(rawSum - weeksRaw) < 1e-6, `${rawSum} vs ${weeksRaw}`);
  const weeksAdj = R.weeks.reduce((a, w) => a + w.adj, 0);
  const adjOpen = tasks.filter(t => !M.isComplete(cfg, t.status) && t.due && M.adjusted(t, S0()) > 0 && t.due <= "2026-12-13");
  const adjSum = adjOpen.reduce((a, t) => a + M.adjusted(t, S0()), 0);
  assert.ok(Math.abs(weeksAdj - adjSum) < 1e-6, `${adjSum} vs ${weeksAdj}`);
  for (const w of R.weeks) {
    const byType = Object.values(w.byType).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(byType - w.adj) < 1e-6);
  }
  assert.equal(R.weeks[0].week, "2026-W43"); assert.equal(R.weeks.at(-1).week, "2026-W50");
  assert.ok(R.weeks[0].isCurrent);
  assert.ok(R.unscheduled.some(t => t.title === "study for quiz"));
});

test("hand-checked week: W48", () => {
  const today = "2026-10-20";
  const R = M.compute(tasks, cfg, settings, today);
  const w = R.weeks.find(x => x.week === "2026-W48");
  // recompute independently from the spread rule
  let raw = 0;
  for (const t of tasks) {
    if (M.isComplete(cfg, t.status) || !t.due || M.remaining(t) <= 0) continue;
    const s = M.spread(t, M.remaining(t), today);
    for (const [d, hh] of s) if (d >= "2026-11-23" && d <= "2026-11-29") raw += hh;
  }
  assert.ok(Math.abs(w.raw - raw) < 1e-9);
});

test("at-risk", () => {
  const today = "2026-10-20";
  const R = M.compute(tasks, cfg, settings, today);
  const ct = tasks.find(t => t.title === "concept stool");
  assert.equal(ct.estimate, null);
  assert.equal(R.risk[ct.path], undefined, "no estimate → no hours → not at risk");
  const fake = { path: "x", title: "x", status: "todo", priority: "high", due: "2026-10-21", start: null, estimate: 10, logged: 0, workType: "CAD", logs: [] };
  const R2 = M.compute([fake], cfg, settings, today);
  // 20h adjusted over 2 days; 40/7*2 = 11.4h available
  assert.ok(R2.risk.x && !R2.risk.x.overdue);
  assert.ok(Math.abs(R2.risk.x.available - 80 / 7) < 1e-9);
  const R3 = M.compute([{ ...fake, due: "2026-10-01" }], cfg, settings, today);
  assert.ok(R3.risk.x.overdue);
});

test("queue order and filters", () => {
  const today = "2026-10-20";
  const R = M.compute(tasks, cfg, settings, today);
  assert.ok(R.queue.every(t => !t.start || t.start <= today));
  for (let i = 1; i < R.queue.length; i++) {
    const ta = R.urgency[R.queue[i - 1].path].tier, tb = R.urgency[R.queue[i].path].tier;
    assert.ok(ta <= tb, "urgency tier first");
    if (ta === tb) assert.ok(M.priorityRank(cfg, R.queue[i - 1].priority) <= M.priorityRank(cfg, R.queue[i].priority), "then priority");
  }
  assert.ok(R.upcoming > 20);
});

test("multiplier history", () => {
  const S = {};
  M.ensureMultipliers(S, ["CAD", M.NO_TYPE], "2026-10-20");
  assert.deepEqual(S.multipliers, { CAD: 2, [M.NO_TYPE]: 2 });
  assert.equal(S.multiplierHistory.length, 2);
  assert.equal(M.ensureMultipliers(S, ["CAD"], "2026-10-21"), false);
  let h = M.recordMultiplier(S.multiplierHistory, "2026-10-27", "CAD", 1.8);
  h = M.recordMultiplier(h, "2026-10-27", "CAD", 1.7); // same day replaces
  assert.equal(h.filter(p => p.type === "CAD").length, 2);
  assert.equal(M.multiplierOn(h, "CAD", "2026-10-26"), 2);
  assert.equal(M.multiplierOn(h, "CAD", "2026-11-01"), 1.7);
});

test("capacity file parsing and template round-trip", () => {
  const md = M.capacityTemplate("2026-10-19", "2026-12-11", 40);
  const cap = M.parseCapacity(md);
  assert.equal(Object.keys(cap).length, 8); assert.equal(cap["2026-W43"], 40);
  const hand = "| Week | Starts | Available hours | Notes |\n|---|---|---|---|\n| 2026-W48 | Nov 23 | 22 | Thanksgiving |\n| 2026-W49 | Nov 30 |  | |\n";
  assert.deepEqual(M.parseCapacity(hand), { "2026-W48": 22 });
});

test("measured factor", () => {
  const done = [{ status: "done", estimate: 4, logged: 6, workType: "CAD" }, { status: "done", estimate: 6, logged: 9, workType: "CAD" }, { status: "todo", estimate: 5, logged: 1, workType: "CAD" }];
  const m = M.measured(done, cfg);
  assert.equal(m.CAD.n, 2); assert.equal(m.CAD.factor, 1.5);
});

test("frontmatter line edits touch only that line", () => {
  const f = require("./fixture/vault.json").tasks.find(t => t.path.endsWith("toaster-web-page.md"));
  const text = "---\npm-task: true\nstatus: todo\nprogress: 0\ndependencies:\n  - \"[[a|a]]\"\n---\n\n## Done when\n- [x] a\n\nProject: [[K|K]]";
  const out = M.setFrontmatterLines(text, { progress: "50" });
  assert.equal(out, text.replace("progress: 0", "progress: 50"));
  assert.equal(M.setFrontmatterLines(out, { status: '"done"' }).split("\n")[2], 'status: "done"');
  const crlf = text.replace(/\n/g, "\r\n");
  assert.equal(M.setFrontmatterLines(crlf, { progress: "50" }), crlf.replace("progress: 0", "progress: 50"));
  assert.equal(M.bodyOf(text).startsWith("\n## Done when"), true);
  assert.equal(M.setFrontmatterLines("no frontmatter", { progress: "1" }), "no frontmatter");
  assert.ok(f);
});

test("dependencies, ready tasks and candidates", () => {
  const today = "2026-10-20";
  const R = M.compute(tasks, cfg, settings, today);
  const k = tasks.find(t => t.title === "Toaster web page");
  assert.ok(k.deps.includes("toaster-3d-print") && k.deps.includes("Typeface pairing"));
  assert.ok(R.blocked.has(k.path), "web page waits on unfinished tasks");
  assert.ok(R.candidates.length > 0);
  for (const c of R.candidates) assert.ok(!R.blocked.has(c.path) && c.start > today);
  for (let i = 1; i < R.candidates.length; i++) assert.ok(M.priorityRank(cfg, R.candidates[i - 1].priority) <= M.priorityRank(cfg, R.candidates[i].priority));
});

test("done today and measured series", () => {
  const base = { estimate: 4, logs: [], workType: "CAD", priority: "high", deps: [], start: null, due: null, title: "a" };
  const ts = [
    { ...base, path: "a", status: "done", completed: "2026-10-20", logged: 6 },
    { ...base, path: "b", status: "done", completed: "2026-10-22", logged: 4, estimate: 8 },
    { ...base, path: "c", status: "done", completed: "2026-10-19", logged: 0 },
    { ...base, path: "d", status: "todo", logged: 3 },
  ];
  const R = M.compute(ts, cfg, settings, "2026-10-20");
  assert.deepEqual(R.doneToday.map(t => t.path), ["a"]);
  const s = R.measuredSeries.CAD;
  assert.deepEqual(s.map(p => [p.date, Math.round(p.value * 100) / 100, p.n]), [["2026-10-20", 1.5, 1], ["2026-10-22", 0.83, 2]]);
});

test("board columns and moving between weeks", () => {
  const R = M.compute(tasks, cfg, settings, "2026-10-20");
  const keys = R.board.map(c => c.key);
  assert.equal(keys[0] === "overdue" ? keys[1] : keys[0], "2026-W43");
  assert.ok(keys.includes("none"));
  const open = tasks.filter(t => !M.isComplete(cfg, t.status));
  assert.equal(R.board.reduce((a, c) => a + c.tasks.length, 0), open.length, "every open task on exactly one column");
  assert.deepEqual(M.shiftToWeek({ start: "2026-11-24", due: "2026-11-27" }, "2026-12-07"), { start: "2026-12-08", due: "2026-12-11" });
  assert.deepEqual(M.shiftToWeek({ start: null, due: null }, "2026-11-02"), { due: "2026-11-06" });
  assert.equal(M.shiftToWeek({ due: "2026-11-27" }, "2026-11-23"), null);
});

test("project stats roll up sub-projects, planned vs actual and milestones", () => {
  const projects = [
    { path: "P/Studio/Studio.md", title: "Studio", parent: null },
    { path: "P/Studio/G/G.md", title: "Lantern", parent: "[[P/Studio/Studio]]" },
  ];
  const tr = M.projectTree(projects);
  assert.equal(tr.length, 1); assert.equal(tr[0].children[0].title, "Lantern");
  const T = (o) => ({ status: "todo", progress: 0, logged: 0, estimate: 4, type: "task", deps: [], ...o });
  const ts = [
    T({ path: "1", project: "Lantern", start: "2026-10-01", due: "2026-10-10", status: "done", logged: 5 }),
    T({ path: "2", project: "Lantern", start: "2026-10-15", due: "2026-10-24", progress: 50 }),
    T({ path: "3", project: "Lantern", due: "2026-10-18", type: "milestone", estimate: null }),
    T({ path: "4", project: "Studio", start: "2026-11-01", due: "2026-11-05" }),
  ];
  const s = M.projectStats(tr[0], ts, cfg, "2026-10-20", {});
  assert.equal(s.total, 4); assert.equal(s.done, 1); assert.equal(s.overdue.length, 1);
  assert.equal(s.milestones[0].state, "missed");
  assert.equal(s.kids[0].total, 3);
  assert.ok(s.planned > s.actual, "behind plan");
  assert.equal(s.health, "behind");
  assert.equal(s.logged, 5);
});

test("quick-add parsing", () => {
  const ctx = { today: "2026-10-20", projects: ["Toaster", "Lantern Studio", "Fun"], workTypes: ["CAD", "Fun"], priorities: ["critical", "high", "medium", "low"] };
  const q = M.parseQuickAdd("render toaster hero shot fri 3h p1 #cad", ctx);
  assert.deepEqual([q.title, q.project, q.due, q.estimate, q.priority, q.workType], ["Render toaster hero shot", "Toaster", "2026-10-23", 3, "critical", "CAD"]);
  assert.equal(M.parseQuickAdd("sketch nov 9 90m @lant", ctx).project, "Lantern Studio");
  assert.equal(M.parseQuickAdd("sketch nov 9 90m @lant", ctx).estimate, 1.5);
  assert.equal(M.parseQuickAdd("tickets #fun", ctx).project, "Fun");
  assert.equal(M.parseQuickAdd("plan jan 5", { ...ctx, today: "2026-12-20" }).due, "2027-01-05");
  assert.equal(M.parseQuickAdd("call +2w", ctx).due, "2026-11-03");
});

test("time log input", () => {
  assert.deepEqual(M.parseLogInput("1h30m -- glued legs"), { hours: 1.5, note: "glued legs" });
  assert.deepEqual(M.parseLogInput("45m"), { hours: 0.75, note: "" });
  assert.equal(M.parseLogInput("soon"), null);
  assert.equal(M.parseLogInput("30"), null, "over 24h is rejected");
});

test("spillover and templates", () => {
  const ts = [{ title: "a", project: "K", due: "2026-10-14", status: "todo", estimate: 4, logged: 1 }, { title: "b", project: "K", due: "2026-10-14", status: "done", estimate: 1, logged: 1 }, { title: "c", project: "K", due: "2026-10-20", status: "todo", estimate: 1, logged: 0 }];
  const sp = M.spillover(ts, cfg, "2026-10-19");
  assert.deepEqual(sp.map(t => t.title), ["a"]);
  assert.match(M.spilloverRows(sp, "2026-W42")[0], /\| 2026-W42 \| a \| K \| 2026-10-14 \| 3 \|/);
  const rows = M.templateTasks(M.parseTemplate(M.EXAMPLE_TEMPLATE), "2026-11-02");
  assert.equal(rows.length, 8);
  assert.deepEqual([rows[3].title, rows[3].start, rows[3].due, rows[3].after], ["CAD", "2026-11-11", "2026-11-17", ["Form concepting"]]);
  assert.equal(M.prependRows(M.prependRows("", M.SCHEDULE_HEADER, ["| 1 |"]), M.SCHEDULE_HEADER, ["| 2 |"]).split("| --- | --- | --- | --- | --- |\n")[1], "| 2 |\n| 1 |\n");
});

test("work type is found by value when this device's field id differs", () => {
  const other = M.readDotpmConfig({ ...fx.dotpm, customFields: [{ id: "differentid", name: "work-type", options: cfg.workTypes }] });
  const k = M.parseTask("x.md", { "pm-task": true, title: "x", customFields: { "9as32nw7mvg3hsfb": "CAD" } }, "", other);
  assert.equal(k.workType, "CAD");
});

test("per-project load adds up to the week and groups by top-level project", () => {
  const R = M.compute(tasks, cfg, settings, "2026-10-20");
  for (const w of R.weeks) {
    const sum = Object.values(w.byProject).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - w.adj) < 1e-6);
    const raw = Object.values(w.rawByProject).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(raw - w.raw) < 1e-6);
  }
  const P = (path, title, parent) => ({ path, title, parent: parent ? `[[${parent}]]` : null });
  const g = M.categoryGroups([
    P("P/Studio.md", "Studio"), P("P/Garden.md", "Gardening Studio", "P/Studio"),
    P("P/Portfolio.md", "Portfolio"), P("P/Kettle.md", "Kettle", "P/Portfolio"), P("P/About.md", "About Page", "P/Portfolio"),
    P("P/Furniture.md", "Furniture"),
  ], ["Kettle", "Gardening Studio", "Furniture", "Loose", M.NO_PROJECT]);
  assert.deepEqual(g.map(x => x.title), ["Furniture", "Portfolio", "Studio", "Loose", "No project"]);
  assert.deepEqual(g[1].members.map(m => m.title), ["Portfolio", "About Page", "Kettle"]);
  assert.ok(g[1].members[0].own && !g[0].members[0].own);
});

const S0 = () => settings.multipliers || {};

test("hours left: estimate × multiplier − logged", () => {
  const t = { estimate: 5, logged: 4, workType: "CAD" };
  assert.equal(M.remaining(t), 1);
  assert.equal(M.adjusted(t, { CAD: 2 }), 6);
  assert.equal(M.adjusted({ ...t, logged: 12 }, { CAD: 2 }), 0, "never negative");
  assert.equal(M.overBudget({ ...t, logged: 10 }, { CAD: 2 }), true);
  assert.equal(M.overBudget(t, { CAD: 2 }), false);
  assert.equal(M.overBudget({ estimate: null, logged: 3 }, {}), false);
});

test("urgency tiers and inheritance", () => {
  const today = "2026-10-20";
  const base = { status: "todo", start: null, logs: [], logged: 0, workType: "CAD", deps: [] };
  const S = { ...settings, multipliers: { CAD: 2 }, capacity: {}, defaultWeeklyHours: 70, tightPct: 50 }; // 10 h a day
  const T = [
    { ...base, path: "a.md", title: "high far", priority: "high", due: "2026-11-20", estimate: 4 },
    { ...base, path: "b.md", title: "medium tomorrow", priority: "medium", due: "2026-10-21", estimate: 1 },
    { ...base, path: "c.md", title: "low tight", priority: "low", due: "2026-10-24", estimate: 15 }, // 30h of 50h
    { ...base, path: "d.md", title: "short", priority: "low", due: "2026-10-23", estimate: 25 }, // 50h of 40h
    { ...base, path: "e.md", title: "blocker", priority: "low", due: "2026-11-30", estimate: 1 },
    { ...base, path: "f.md", title: "needs blocker", priority: "low", due: "2026-10-22", estimate: 8, deps: ["e"] }, // 16h of 30h → tight
  ];
  const R = M.compute(T, cfg, S, today);
  const u = p => R.urgency[p];
  assert.equal(u("a.md").label, "normal");
  assert.equal(u("b.md").label, "now"); assert.equal(u("b.md").reason, "Due tomorrow");
  assert.equal(u("c.md").label, "tight");
  assert.equal(u("d.md").label, "now"); assert.match(u("d.md").reason, /^Short/);
  assert.equal(u("e.md").label, "tight", "takes the tier of the task waiting on it");
  assert.match(u("e.md").reason, /Unblocks needs blocker/);
  assert.equal(R.queue[0].title, "medium tomorrow", "due tomorrow beats a high-priority task due next month");
  assert.equal(R.queue.at(-1).title, "high far");
});
