"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
global.document = { createDocumentFragment: () => ({ append() {} }), createElement: () => ({ addEventListener() {} }) };
const stub = { Plugin: class { constructor(app) { this.app = app; } }, ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
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
  await p.markDone(path);
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
  assert.deepEqual(p.settings.pulled[path], { start: "2099-01-01", due: "2099-01-05", date: M.localToday() });
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
  Object.assign(p.tasks.get(path), { project: "Kettle" });
  await p.applyProjectWorkType(path);
  assert.equal(calls.filter(c => c[0] === "updateTask").length, 1, "no matching work type → untouched");
});
