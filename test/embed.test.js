"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
class TFile { constructor(path) { this.path = path; } }
const el = () => ({ cls: [], attrs: {}, parent: null, get isConnected() { return !!this.parent; }, addClass(c) { this.cls.push(c); }, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.parent = null; } });
const stub = { Plugin: class { constructor(app) { this.app = app; } }, ItemView: class { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = { empty() {} }; } },
  PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal: class {}, TFolder: class {}, Platform: { isDesktopApp: true }, Notice: class {}, TFile, normalizePath: x => x, debounce: f => f };
const orig = Module._load;
Module._load = function (r, ...a) { return r === "obsidian" ? stub : orig.call(this, r, ...a); };
global.document = { createDocumentFragment: () => ({ append() {} }), createElement: () => ({ addEventListener() {} }) };
const Plugin = require("../src/main.js");
const { CompanionView } = Plugin;

function setup(saved) {
  const log = [];
  class FakeDotpmView { // behaves like dotpm's pm-project view: reloads "its" leaf on scope switch
    constructor(leaf) { this.leaf = leaf; this.containerEl = el(); this.scope = { name: "dotpm-keys" }; this.state = {}; }
    load() { log.push(["load"]); }
    async setState(s) { this.state = s; log.push(["setState", s]); }
    getState() { return this.state; }
    async onOpen() { log.push(["onOpen"]); }
    onClose() { log.push(["onClose"]); }
    unload() { log.push(["unload"]); }
    async switchScope(scope) { await this.leaf.setViewState({ type: "pm-project", state: { scope } }); }
    async openOverview(path) { await this.leaf.setViewState({ type: "pm-project-overview", state: { filePath: path } }); }
  }
  const opened = [];
  const realLeaf = { app: null, setViewState: async () => log.push(["REAL LEAF REPLACED"]) };
  const app = {
    viewRegistry: { viewByType: { "pm-project": leaf => new FakeDotpmView(leaf) } },
    workspace: { getLeaf: () => ({ setViewState: async vs => opened.push(vs) }), getLeavesOfType: () => [] },
  };
  realLeaf.app = app;
  const plugin = { settings: { dotpmState: saved || null, dotpmScope: "" }, saveSettings() { log.push(["save"]); }, projectNotes: { "Project/Fall 2026/Fall 2026.md": { title: "Fall 2026", parent: null }, "Project/Fall 2026/Portfolio/Portfolio.md": { title: "Portfolio", parent: "[[Project/Fall 2026/Fall 2026]]" } } };
  plugin.defaultScope = Plugin.prototype.defaultScope.bind(plugin);
  plugin.validScope = Plugin.prototype.validScope.bind(plugin);
  const view = Object.create(CompanionView.prototype);
  Object.assign(view, { leaf: realLeaf, app, plugin, contentEl: { empty() {} }, scope: null, tab: "dotpm" });
  const host = { kids: [], append(x) { x.parent = this; this.kids.push(x); } };
  return { view, host, log, opened, realLeaf };
}

test("mounts dotpm's own view on all projects", async () => {
  const { view, host, log } = setup();
  view.mountDotpm(host);
  await view.dotpmReady;
  assert.equal(host.kids.length, 1);
  assert.deepEqual(log.filter(l => l[0] === "setState")[0][1], { scope: { kind: "vault" } });
  assert.ok(log.some(l => l[0] === "onOpen"));
  assert.equal(view.scope.name, "dotpm-keys", "dotpm's keyboard scope is active");
  assert.equal(view.dotpmView.containerEl.attrs["data-type"], "pm-project");
});

test("dotpm switching scope stays inside the companion", async () => {
  const { view, host, log } = setup();
  view.mountDotpm(host); await view.dotpmReady;
  await view.dotpmView.switchScope({ kind: "project", path: "Project/Fall 2026/Portfolio/Portfolio.md" });
  assert.ok(!log.some(l => l[0] === "REAL LEAF REPLACED"));
  assert.equal(view.dotpmView.state.scope.path, "Project/Fall 2026/Portfolio/Portfolio.md");
});

test("other dotpm screens open in a new tab", async () => {
  const { view, host, log, opened } = setup();
  view.mountDotpm(host); await view.dotpmReady;
  await view.dotpmView.openOverview("Project/Fall 2026/Fall 2026.md");
  assert.equal(opened.length, 1); assert.equal(opened[0].type, "pm-project-overview");
  assert.ok(!log.some(l => l[0] === "REAL LEAF REPLACED"));
});

test("remounting reuses the same dotpm view; closing saves its scope", async () => {
  const { view, host, log } = setup({ scope: { kind: "project", path: "Project/Fall 2026/Portfolio/Portfolio.md" } });
  view.mountDotpm(host); await view.dotpmReady;
  assert.equal(log.filter(l => l[0] === "setState")[0][1].scope.path, "Project/Fall 2026/Portfolio/Portfolio.md", "restores last scope");
  const first = view.dotpmView;
  view.mountDotpm(host);
  assert.equal(view.dotpmView, first);
  view.unmountDotpm();
  assert.ok(log.some(l => l[0] === "onClose") && log.some(l => l[0] === "unload"));
  assert.deepEqual(view.plugin.settings.dotpmState, { scope: { kind: "project", path: "Project/Fall 2026/Portfolio/Portfolio.md" } });
  assert.equal(view.dotpmView, null);
});

test("without dotpm it throws so the tab shows the fallback", () => {
  const { view, host } = setup();
  view.app.viewRegistry.viewByType = {};
  assert.throws(() => view.mountDotpm(host), /isn't registered/);
});

test("a remembered scope whose project was deleted falls back to all projects", async () => {
  const { view, host, log } = setup({ scope: { kind: "project", path: "Project/Gone/Gone.md" } });
  view.mountDotpm(host); await view.dotpmReady;
  assert.deepEqual(log.filter(l => l[0] === "setState")[0][1], { scope: { kind: "vault" } });
});

test("picked scopes keep only projects that still exist", () => {
  const { view } = setup();
  assert.deepEqual(view.plugin.validScope({ kind: "picked", paths: ["Project/Gone/Gone.md", "Project/Fall 2026/Portfolio/Portfolio.md"] }), { kind: "picked", paths: ["Project/Fall 2026/Portfolio/Portfolio.md"] });
  assert.equal(view.plugin.validScope({ kind: "picked", paths: ["Project/Gone/Gone.md"] }), null);
});
