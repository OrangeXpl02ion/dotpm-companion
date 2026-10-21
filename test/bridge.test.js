"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
global.document = { createDocumentFragment: () => ({ append() {} }), createElement: () => ({ addEventListener() {} }) };
const stub = { Plugin: class { constructor(app) { this.app = app; } }, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal: class {}, TFolder: class {}, Platform: { isDesktopApp: true }, parseYaml: s => global.__yaml(s),
  Notice: class { constructor(m) { stub.notices.push(m); } }, TFile, normalizePath: x => x, debounce: f => f, notices: [] };
const orig = Module._load;
Module._load = function (r, ...a) { return r === "obsidian" ? stub : orig.call(this, r, ...a); };
const Plugin = require("../src/main.js");
const M = require("../src/model.js");

function make(withDotpm) {
  const calls = [];
  const files = { "Project/K/_tasks/a.md": "---\npm-task: true\nid: \"t1\"\nstatus: \"todo\"\nprogress: 0\n---\n\n## Done when\n- [x] a\n- [ ] b\n" };
  const app = {
    vault: { getAbstractFileByPath: p => (p in files ? new TFile(p) : null), process: async (f, fn) => { files[f.path] = fn(files[f.path]); calls.push(["process", f.path]); } },
    workspace: { getLeavesOfType: () => [] },
    plugins: { plugins: {} },
  };
  if (withDotpm) app.plugins.plugins["project-manager"] = {
    index: { task: id => (id === "t1" ? { projectPath: "Project/K/K.md" } : null) },
    store: {
      loadProjectByPath: async p => ({ filePath: p }),
      updateTask: async (proj, id, patch) => calls.push(["updateTask", proj.filePath, id, patch]),
      scheduleAfterChange: async (proj, id) => calls.push(["schedule", id]),
    },
    refreshViews: () => calls.push(["refresh"]),
    router: { openTask: o => calls.push(["openTask", o.filePath]) },
  };
  const p = new Plugin(app);
  p.app = app;
  p.cfg = M.readDotpmConfig({});
  p.settings = { progressFromChecklist: true, undo: {}, pulled: {} };
  p.saveSettings = async () => {};
  p.diag = { fromFile: 0 }; p.confirmDone = new Map(); p.reasons = new Map(); p.dates = new Map(); p.logGroup = []; p.projectNotes = {};
  const body = M.bodyOf(files["Project/K/_tasks/a.md"]);
  p.tasks = new Map([["Project/K/_tasks/a.md", M.parseTask("Project/K/_tasks/a.md", { "pm-task": true, id: "t1", status: "todo", progress: 0 }, body, p.cfg)]]);
  return { p, calls, files };
}

test("progress goes through dotpm's store and redraws dotpm", async () => {
  const { p, calls, files } = make(true);
  await p.writeProgress("Project/K/_tasks/a.md");
  assert.deepEqual(calls, [["updateTask", "Project/K/K.md", "t1", { progress: 50 }], ["refresh"]]);
  assert.ok(files["Project/K/_tasks/a.md"].includes("progress: 0"), "file left to dotpm");
});

test("status change also reschedules dependents", async () => {
  const { p, calls } = make(true);
  await p.setTaskField("Project/K/_tasks/a.md", "status", "done");
  assert.deepEqual(calls, [["updateTask", "Project/K/K.md", "t1", { status: "done" }], ["schedule", "t1"], ["refresh"]]);
  await p.setTaskField("Project/K/_tasks/a.md", "title", "x");
  assert.equal(calls.length, 3, "only status and priority are editable");
});

test("without dotpm it edits the one frontmatter line", async () => {
  const { p, calls, files } = make(false);
  await p.writeProgress("Project/K/_tasks/a.md");
  await p.markDone("Project/K/_tasks/a.md"); // first ✓ only warns: one Done-when box unticked
  assert.equal(calls.length, 1);
  await p.markDone("Project/K/_tasks/a.md");
  assert.equal(calls.length, 2);
  assert.ok(files["Project/K/_tasks/a.md"].includes("progress: 50"));
  assert.ok(files["Project/K/_tasks/a.md"].includes('status: "done"'));
});

test("a failing dotpm call falls back to the file", async () => {
  const { p, files, calls } = make(true);
  p.app.plugins.plugins["project-manager"].store.updateTask = async () => { throw new Error("boom"); };
  const warn = console.warn; console.warn = () => {};
  await p.writeProgress("Project/K/_tasks/a.md");
  console.warn = warn;
  assert.ok(files["Project/K/_tasks/a.md"].includes("progress: 50"));
});

test("open task uses dotpm's editor", () => {
  const { p, calls } = make(true);
  p.openTask("Project/K/_tasks/a.md");
  assert.deepEqual(calls, [["openTask", "Project/K/_tasks/a.md"]]);
});

test("undo restores the status a task had before it was marked done", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  p.tasks.get(path).status = "in-progress";
  await p.markDone(path); await p.markDone(path);
  assert.equal(p.settings.undo[path].prev, "in-progress");
  p.tasks.get(path).status = "done";
  await p.undoDone(path);
  assert.deepEqual(calls.filter(c => c[0] === "updateTask").map(c => c[3]), [{ status: "done" }, { status: "in-progress" }]);
  assert.equal(p.settings.undo[path], undefined);
});

test("undo of a task finished elsewhere reopens it as in progress", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  p.tasks.get(path).status = "done";
  await p.undoDone(path);
  assert.deepEqual(calls[0][3], { status: "in-progress" });
});

test("start now moves the start date to today", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  Object.assign(p.tasks.get(path), { start: "2099-01-01", due: "2099-01-05" });
  await p.startNow(path);
  assert.deepEqual(calls[0][3], { start: M.localToday() });
});

test("undo add restores the original start and due dates", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  Object.assign(p.tasks.get(path), { start: "2099-01-01", due: "2099-01-05" });
  await p.startNow(path);
  assert.deepEqual(p.settings.pulled[path], { start: "2099-01-01", due: "2099-01-05", date: M.localToday(), kind: "added" });
  Object.assign(p.tasks.get(path), { start: M.localToday() });
  await p.undoStart(path);
  const ups = calls.filter(c => c[0] === "updateTask").map(c => c[3]);
  assert.deepEqual(ups, [{ start: M.localToday() }, { start: "2099-01-01" }]);
  assert.equal(p.settings.pulled[path], undefined);
});

test("undo add also restores a due date that start-now moved", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  Object.assign(p.tasks.get(path), { start: "2000-01-01", due: "2000-01-02" });
  await p.startNow(path);
  Object.assign(p.tasks.get(path), { start: M.localToday(), due: M.localToday() });
  await p.undoStart(path);
  assert.deepEqual(calls.filter(c => c[0] === "updateTask").map(c => c[3])[1], { start: "2000-01-01", due: "2000-01-02" });
});

test("dotpm views on dotpm's default sort switch to due date once; chosen sorts are kept", async () => {
  const { p } = make(true);
  const pm = p.app.plugins.plugins["project-manager"];
  let saved = 0;
  pm.settings = { ganttGranularity: "week", defaultFields: {}, projectFilters: {
    "project:A.md": { sort: [{ key: "status", dir: "asc" }] },
    "project:B.md": { sort: [{ key: "progress", dir: "asc" }] } } };
  pm.saveSettings = async () => { saved++; };
  p.projectNotes = { "A.md": {}, "B.md": {}, "C.md": {} };
  p.settings.dotpmDueSort = true; p.settings.dotpmSortSeen = [];
  await p.applyDotpmDueSort();
  const pf = pm.settings.projectFilters;
  assert.deepEqual(pf["project:A.md"].sort, M.DUE_SORT);
  assert.deepEqual(pf["project:B.md"].sort, [{ key: "progress", dir: "asc" }]);
  assert.deepEqual(pf["project:C.md"].sort, M.DUE_SORT);
  assert.deepEqual(pf.vault.sort, M.DUE_SORT);
  assert.equal(saved, 1);
  pf["project:A.md"].sort = [{ key: "status", dir: "asc" }]; // you set it back in dotpm
  await p.applyDotpmDueSort();
  assert.deepEqual(pf["project:A.md"].sort, [{ key: "status", dir: "asc" }], "not overridden a second time");
});

test("tasks in a project named like a work type get that work type", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  p.cfg = M.readDotpmConfig({ customFields: [{ id: "wt", name: "work-type", options: ["CAD", "Fun", "IDSA"] }] });
  p.settings.workTypeFromProject = true;
  Object.assign(p.tasks.get(path), { project: "Fun", workType: null, customFields: { other: "x" } });
  await p.applyProjectWorkType(path);
  assert.deepEqual(calls[0][3], { customFields: { other: "x", wt: "Fun" } });
  Object.assign(p.tasks.get(path), { project: "Toaster" });
  await p.applyProjectWorkType(path);
  assert.equal(calls.filter(c => c[0] === "updateTask").length, 1, "no matching work type → untouched");
});

test("✓ on a task with every Done-when box ticked marks it done at once", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  p.tasks.get(path).checklist = { done: 2, total: 2 };
  await p.markDone(path);
  assert.deepEqual(calls[0][3], { status: "done" });
});

test("not today moves the start (and an earlier due) to tomorrow, with undo", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  const today = M.localToday(), tomorrow = M.addDays(today, 1);
  Object.assign(p.tasks.get(path), { start: today, due: today });
  await p.notToday(path);
  assert.deepEqual(calls[0][3], { start: tomorrow, due: tomorrow });
  assert.equal(p.settings.pulled[path].kind, "deferred");
  Object.assign(p.tasks.get(path), { start: tomorrow, due: tomorrow });
  await p.undoStart(path);
  assert.deepEqual(calls.filter(c => c[0] === "updateTask")[1][3], { start: today, due: today });
});

test("quick-add creates the task through dotpm's store", async () => {
  const { p, calls } = make(true);
  const pm = p.app.plugins.plugins["project-manager"];
  pm.store.insertTask = async (proj, task) => calls.push(["insertTask", proj.filePath, task]);
  p.projectNotes = { "Project/F/Fun/Fun.md": { title: "Fun" } };
  p.cfg = M.readDotpmConfig({ customFields: [{ id: "wt", name: "work-type", options: ["Fun"] }] });
  const q = M.parseQuickAdd("buy tickets tomorrow 2h p2 #fun", { today: M.localToday(), projects: ["Fun"], workTypes: ["Fun"], priorities: ["critical", "high", "medium", "low"] });
  await p.createTask(q.project, q);
  const [, path, task] = calls.find(c => c[0] === "insertTask");
  assert.equal(path, "Project/F/Fun/Fun.md");
  assert.equal(task.title, "Buy tickets"); assert.equal(task.due, M.addDays(M.localToday(), 1));
  assert.equal(task.priority, "high"); assert.equal(task.timeEstimate, 2); assert.deepEqual(task.customFields, { wt: "Fun" });
  assert.equal(task.id.length, 16);
});

test("logging time appends to the task's time logs through dotpm", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md";
  p.app.metadataCache = { getFileCache: () => ({ frontmatter: { timeLogs: [{ date: "2026-10-19", hours: 1, note: "x", start: 836, end: "14:56" }] } }) };
  await p.logTime(path, { hours: 2, note: "hinge", start: "12:00", end: "14:00", dayOffset: 0 });
  assert.deepEqual(calls[0][3], { timeLogs: [{ date: "2026-10-19", hours: 1, note: "x", start: "13:56", end: "14:56" },
    { date: M.localToday(), hours: 2, note: "hinge", start: "12:00", end: "14:00" }] }, "keeps earlier times (base-60 number fixed) and adds the new range");
  await p.logTime(path, { hours: 1, note: "", start: "23:00", end: "01:00", dayOffset: -1 });
  assert.equal(calls.filter(c => c[3] && c[3].timeLogs).at(-1)[3].timeLogs.at(-1).date, M.addDays(M.localToday(), -1), "work that began yesterday is dated yesterday");
});

test("schedule log groups a cause with its knock-ons on the logging device", async () => {
  const { p } = make(true);
  p.settings.scheduleLog = true;
  p.isLogDevice = () => true;
  const rows = [];
  p.prependTo = async (name, header, r) => rows.push(...r);
  const a = { path: "a", title: "Toaster CAD", project: "Toaster", start: "2026-11-02", due: "2026-11-13" };
  const b = { path: "b", title: "Toaster renders", project: "Toaster", start: "2026-11-14", due: "2026-11-21" };
  p.trackDates(a); p.trackDates(b);
  p.trackDates({ ...a, due: "2026-11-17" }); p.trackDates({ ...b, start: "2026-11-18", due: "2026-11-25" });
  clearTimeout(p.logTimer); await p.flushScheduleLog();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Toaster CAD .* due 11-13 → 11-17 .* moved the tasks below/);
  assert.match(rows[1], /Toaster renders .* knock-on from Toaster CAD/);
});

test("spillover is written once per week even if triggered twice", async () => {
  const { p } = make(true);
  p.isLogDevice = () => true;
  let md = "";
  p.app.vault.read = async () => md;
  p.app.vault.getAbstractFileByPath = path => (path === "Spillover.md" && md ? new (require("obsidian").TFile)(path) : null);
  p.settings.spilloverFile = "Spillover.md"; p.settings.lastSpilloverWeek = "";
  p.prependTo = async (name, header, rows) => { md = M.prependRows(md, header, rows); };
  await Promise.all([p.writeSpillover(false), p.writeSpillover(false)]);
  p.settings.lastSpilloverWeek = ""; // e.g. settings from another device arrive late
  await p.writeSpillover(false);
  assert.equal((md.match(/nothing spilled over/g) || []).length, 1);
});

test("a device doesn't claim logging when another device's log is already in the vault", () => {
  const { p } = make(true);
  p.settings.logDeviceId = ""; p.settings.scheduleLogFile = "Schedule log.md"; p.settings.spilloverFile = "Spillover.md";
  p.deviceId = () => "mac";
  p.app.vault.getAbstractFileByPath = path => (path === "Schedule log.md" ? {} : null);
  p.claimLogDevice(false);
  assert.equal(p.settings.logDeviceId, "");
  p.claimLogDevice(true);
  assert.equal(p.settings.logDeviceId, "mac");
});

test("the logging switch: on in one place takes over; off releases it", async () => {
  const { p } = make(true);
  const store = {};
  p.app.loadLocalStorage = k => store[k] || null; p.app.saveLocalStorage = (k, v) => { store[k] = v; };
  p.deviceId = () => "mac";
  p.settings.logDeviceId = "pc";
  assert.equal(p.isLogDevice(), false);
  await p.setLogHere(true);
  assert.equal(p.settings.logDeviceId, "mac"); assert.equal(p.isLogDevice(), true);
  await p.setLogHere(false);
  assert.equal(p.settings.logDeviceId, ""); assert.equal(p.isLogDevice(), false);
  p.settings.logDeviceId = "mac"; // a stale synced claim
  assert.equal(p.isLogDevice(), false, "a local off always wins");
});

test("tasks are found even when Obsidian's metadata cache is still empty (fresh sync)", async () => {
  const { p } = make(true);
  const text = "---\npm-task: true\nid: \"t9\"\ntitle: \"Fresh\"\nprojectId: \"[[K|K]]\"\nstatus: todo\ndue: 2026-11-02\ntimeEstimate: 3\n---\n\nProject: [[K|K]]\n";
  const f = new (require("obsidian").TFile)("Project/K/_tasks/fresh.md");
  p.cfg = M.readDotpmConfig({});
  p.app.metadataCache = { getFileCache: () => null };
  p.app.vault.cachedRead = async () => text;
  p.tasks = new Map();
  p.trackDates = () => {};
  const yaml = s => Object.fromEntries(s.split("\n").map(l => l.split(/: (.*)/)).map(([k, v]) => [k, v === "true" ? true : /^\d+$/.test(v) ? Number(v) : String(v).replace(/^"|"$/g, "")]));
  global.__yaml = yaml;
  const t = await p.indexFile(f);
  assert.ok(t, "parsed from the file");
  assert.equal(t.title, "Fresh"); assert.equal(t.due, "2026-11-02"); assert.equal(t.estimate, 3);
});

test("a log added in dotpm on this computer gets start and end times", async () => {
  const { p, calls } = make(true);
  const path = "Project/K/_tasks/a.md", T = M.localToday();
  let fm = { timeLogs: [{ date: T, hours: 0.5, note: "sketching" }] };
  p.app.metadataCache = { getFileCache: () => ({ frontmatter: fm }) };
  p.settings.stampDotpmLogs = true;
  const prev = p.tasks.get(path);
  // no recent input here (e.g. the file arrived through sync): leave it
  p.pendingStamp = new Map(); p.lastInput = 0;
  p.watchLogs(path, prev);
  assert.equal(p.pendingStamp.size, 0);
  // you just used this computer: it waits, then stamps through dotpm's store
  p.lastInput = Date.now();
  p.watchLogs(path, prev);
  const pend = p.pendingStamp.get(path);
  assert.ok(pend); clearTimeout(pend.timer); p.pendingStamp.delete(path);
  pend.at = 17 * 60 + 10;
  await p.stampLogs(path, pend);
  assert.deepEqual(calls[0], ["updateTask", "Project/K/K.md", "t1", { timeLogs: [{ date: T, hours: 0.5, note: "sketching", start: "16:40", end: "17:10" }] }]);
  // already timed now: running again changes nothing
  fm = { timeLogs: calls[0][3].timeLogs };
  const n = calls.length;
  await p.stampLogs(path, pend);
  assert.equal(calls.length, n);
});
