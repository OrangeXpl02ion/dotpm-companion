"use strict";
// Moving a task to another project goes through dotpm's own moveTaskToProject; a work type that only came from
// the old project's name (quick task filed in Misc) follows the move.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
global.document = { createDocumentFragment: () => ({ append() {} }), createElement: () => ({ addEventListener() {} }) };
const opened = [];
class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder(t) { this.placeholder = t; } open() { opened.push(this); } }
const stub = { Plugin: class { constructor(app) { this.app = app; } }, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal, Menu: class {}, TFolder: class {}, Platform: { isDesktopApp: true }, parseYaml: () => ({}),
  Notice: class { constructor(m) { stub.notices.push(m); } }, TFile, normalizePath: x => x, debounce: f => f, notices: [] };
const orig = Module._load;
Module._load = function (r, ...a) { return r === "obsidian" ? stub : orig.call(this, r, ...a); };
const Plugin = require("../src/main.js");
const M = require("../src/model.js");

const FID = "96flm7smmvg5yscw";
function make(task) {
  const calls = [];
  const app = { vault: { getAbstractFileByPath: () => null }, workspace: { getLeavesOfType: () => [] }, plugins: { plugins: {} } };
  app.plugins.plugins["project-manager"] = {
    index: { task: id => (id === "t1" ? { projectPath: "Project/Misc/Misc.md" } : null) },
    store: {
      loadProjectByPath: async p => ({ filePath: p, title: p.split("/").pop().replace(".md", "") }),
      updateTask: async (proj, id, patch) => calls.push(["updateTask", proj.filePath, id, patch]),
      moveTaskToProject: async (from, to, id, parent) => calls.push(["move", from.filePath, to.filePath, id, parent]),
    },
    refreshViews: () => calls.push(["refresh"]),
  };
  const p = new Plugin(app);
  p.app = app;
  p.cfg = { ...M.readDotpmConfig({}), workTypeFieldId: FID, workTypes: ["CAD", "Concepting", "Fabrication", "Misc", "IDSA"] };
  p.settings = { undo: {}, pulled: {} };
  p.projectNotes = {
    "Project/Misc/Misc.md": { path: "Project/Misc/Misc.md", title: "Misc", parent: null },
    "Project/Studio/Studio.md": { path: "Project/Studio/Studio.md", title: "Studio", parent: null },
    "Project/Studio/Gardening/Gardening Studio.md": { path: "Project/Studio/Gardening/Gardening Studio.md", title: "Gardening Studio", parent: "[[Project/Studio/Studio]]" },
    "Project/IDSA/IDSA.md": { path: "Project/IDSA/IDSA.md", title: "IDSA", parent: null },
  };
  const path = "Project/Misc/_tasks/a.md";
  p.tasks = new Map([[path, { id: "t1", path, title: "Buy dowels", project: "Misc", status: "todo", customFields: { [FID]: task.wt }, workType: task.wt, deps: [], logs: [] }]]);
  return { p, calls, path };
}

test("moves through dotpm and leaves a real work type alone", async () => {
  const { p, calls, path } = make({ wt: "Fabrication" });
  await p.moveToProject(path, "Project/Studio/Gardening/Gardening Studio.md");
  assert.deepEqual(calls, [["move", "Project/Misc/Misc.md", "Project/Studio/Gardening/Gardening Studio.md", "t1", null], ["refresh"]]);
  assert.equal(opened.length, 0);
});

test("work type from the old project's name: asks for a new one", async () => {
  opened.length = 0;
  const { p, calls, path } = make({ wt: "Misc" });
  await p.moveToProject(path, "Project/Studio/Studio.md");
  assert.equal(opened.length, 1, "work type picker opens");
  await opened[0].onChooseItem("Concepting");
  assert.deepEqual(calls.at(-2), ["updateTask", "Project/Studio/Studio.md", "t1", { customFields: { [FID]: "Concepting" } }]);
});

test("work type from the old project's name: new project named like a work type sets it", async () => {
  opened.length = 0;
  const { p, calls, path } = make({ wt: "Misc" });
  await p.moveToProject(path, "Project/IDSA/IDSA.md");
  assert.equal(opened.length, 0);
  assert.deepEqual(calls.find(c => c[0] === "updateTask")[3], { customFields: { [FID]: "IDSA" } });
});

test("project picker lists other projects with their parents", () => {
  opened.length = 0;
  const { p, path } = make({ wt: "Misc" });
  p.pickProjectFor(path);
  const m = opened[0];
  assert.deepEqual(m.getItems().map(x => m.getItemText(x)), ["IDSA", "Studio", "Studio › Gardening Studio"]);
});
