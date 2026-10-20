"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
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
  p.settings = { progressFromChecklist: true };
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
