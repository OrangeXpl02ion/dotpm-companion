"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
global.document = { createDocumentFragment: () => ({ append() {} }), createElement: () => ({ addEventListener() {} }) };
const stub = { Plugin: class { constructor(app) { this.app = app; } }, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal: class {}, TFolder: class {}, Platform: { isDesktopApp: true },
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
  p.confirmDone = new Map(); p.reasons = new Map(); p.dates = new Map(); p.logGroup = []; p.projectNotes = {};
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
  p.app.metadataCache = { getFileCache: () => ({ frontmatter: { timeLogs: [{ date: "2026-10-19", hours: 1, note: "x" }] } }) };
  await p.logTime(path, 2, "hinge");
  assert.deepEqual(calls[0][3], { timeLogs: [{ date: "2026-10-19", hours: 1, note: "x" }, { date: M.localToday(), hours: 2, note: "hinge" }] });
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
