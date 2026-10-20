"use strict";
const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, normalizePath, debounce } = require("obsidian");
const M = require("./model");
const V = require("./views");

const VIEW_TYPE = "dotpm-companion";
// Through dotpm's own store the change is visible at once; the file-edit fallback must wait out
// dotpm's 5 s self-write window or dotpm keeps showing the old value.
const PROGRESS_DELAY_MS = 1500;
const FALLBACK_DELAY_MS = 6000;
const DEFAULTS = {
  capacityFile: "Capacity.md",
  defaultWeeklyHours: 40,
  rangeStart: "2026-10-19",
  rangeEnd: "2026-12-11",
  overloadPct: 85,
  progressFromChecklist: true,
  multipliers: {},
  multiplierHistory: [],
  lastTab: "dotpm",
  dotpmScope: "",
  dotpmState: null,
  showDone: false,
  boardMode: "today",
  undo: {},
  pulled: {},
  openOnStartup: true,
  lastMode: "adj",
};

class CompanionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = ({ tasks: "dotpm", queue: "board" })[plugin.settings.lastTab] || plugin.settings.lastTab; this.mode = plugin.settings.lastMode; this.expanded = null; this.collapsed = new Set(); this.query = ""; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "dotpm Companion"; }
  getIcon() { return "gauge"; }
  async onOpen() { this.refresh(); }
  onResize() {
    if (this.tab === "dotpm") { try { this.dotpmView && this.dotpmView.onResize && this.dotpmView.onResize(); } catch (e) { /* ignore */ } return; }
    this.refresh();
  }
  async onClose() { this.unmountDotpm(); }

  // ---- dotpm's own project view, hosted inside this tab ----
  // dotpm's view is created through its registered factory with a stand-in leaf: when dotpm wants to
  // reload "its" tab (switching scope), the change is applied to the hosted view instead of replacing
  // this companion tab; anything else dotpm opens (task editor, overview) goes to a normal new tab.
  mountDotpm(host) {
    const p = this.plugin;
    if (this.dotpmView) { host.append(this.dotpmView.containerEl); this.scope = this.dotpmView.scope || this.scope; return; }
    const factory = this.app.viewRegistry && this.app.viewRegistry.viewByType && this.app.viewRegistry.viewByType["pm-project"];
    if (typeof factory !== "function") throw new Error("dotpm's project view isn't registered (is dotpm enabled?)");
    const self = this;
    const leaf = Object.create(this.leaf);
    leaf.setViewState = async (vs, eState) => {
      if (vs && vs.type === "pm-project" && self.dotpmView) { await self.dotpmView.setState(vs.state || {}, { history: false }); self.saveDotpmState(); return; }
      const other = self.app.workspace.getLeaf("tab"); await other.setViewState(vs, eState);
    };
    leaf.getViewState = () => ({ type: "pm-project", state: self.dotpmView ? self.dotpmView.getState() : {} });
    const v = factory(leaf);
    this.dotpmView = v;
    v.containerEl.addClass("dpc-embedded");
    v.containerEl.setAttribute("data-type", "pm-project");
    host.append(v.containerEl);
    v.load();
    const state = p.settings.dotpmState && p.settings.dotpmState.scope ? p.settings.dotpmState : { scope: { kind: "project", path: p.rootProjectPath() } };
    this.dotpmReady = (async () => {
      await v.setState(state, { history: false });
      await v.onOpen();
      this.scope = v.scope || this.scope;
    })();
    this.dotpmReady.catch(e => { console.error("[dotpm-companion] dotpm view failed", e); this.unmountDotpm(); this.dotpmError = e; this.refresh(); });
  }
  saveDotpmState() {
    try { const st = this.dotpmView.getState(); if (st && st.scope) { this.plugin.settings.dotpmState = { scope: st.scope }; this.plugin.saveSettings(); } } catch (e) { /* ignore */ }
  }
  unmountDotpm() {
    const v = this.dotpmView;
    if (!v) return;
    this.saveDotpmState();
    this.dotpmView = null;
    try { v.onClose && v.onClose(); } catch (e) { /* ignore */ }
    try { v.unload(); } catch (e) { /* ignore */ }
    v.containerEl.remove();
  }
  switchTab(t) {
    if (this.tab === "dotpm" && t !== "dotpm") { this.saveDotpmState(); this.scope = null; }
    this.tab = t; this.plugin.settings.lastTab = t; this.plugin.saveSettings();
    this.dotpmError = null;
    if (t !== "dotpm" || !this.dotpmView || !this.dotpmView.containerEl.isConnected) this.contentEl.empty();
    this.refresh();
  }
  refresh() {
    const p = this.plugin;
    const root = this.contentEl;
    // dotpm redraws itself; leave it alone while it's showing.
    if (this.tab === "dotpm" && this.dotpmView && this.dotpmView.containerEl.isConnected) return;
    V.render(root, {
      tab: this.tab, mode: this.mode, expanded: this.expanded, collapsed: this.collapsed, query: this.query,
      bridged: !!p.dotpm(), showMore: !!this.showMore, projectColors: p.projectColors, dotpmError: this.dotpmError ? String(this.dotpmError.message || this.dotpmError) : null,
      cfg: p.cfg, settings: { ...p.settings, capacity: p.capacity }, tasks: p.taskList(), result: p.result,
    }, {
      setTab: t => this.switchTab(t),
      mountDotpm: host => this.mountDotpm(host),
      openDotpmTab: () => p.openDotpmInTab(),
      setMode: m => { this.mode = m; p.settings.lastMode = m; p.saveSettings(); this.refresh(); },
      toggleWeek: w => { this.expanded = this.expanded === w ? null : w; this.refresh(); },
      openTask: path => p.openTask(path),
      openFile: path => { const f = p.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) p.app.workspace.getLeaf(false).openFile(f); },
      markDone: path => p.markDone(path),
      setField: (path, field, value) => p.setTaskField(path, field, value),
      undoDone: path => p.undoDone(path),
      startNow: path => p.startNow(path),
      undoStart: path => p.undoStart(path),
      moveCard: (path, key) => p.moveCard(path, key),
      setBoardMode: m => { p.settings.boardMode = m; p.saveSettings(); this.refresh(); },
      toggleMore: () => { this.showMore = !this.showMore; this.refresh(); },
      setMultiplier: (k, v) => p.setMultiplier(k, v),
      createCapacity: () => p.createCapacityFile(),
    });
  }
}

const DotpmCompanion = module.exports = class DotpmCompanion extends Plugin {
  async onload() {
    this.tasks = new Map();
    this.projectColors = {};
    this.projectNotes = {};
    this.capacity = {};
    this.result = null;
    this.pendingProgress = new Map();
    this.cfg = M.readDotpmConfig({});
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new CompanionView(leaf, this));
    this.addRibbonIcon("gauge", "dotpm Companion", () => this.activateView());
    this.addCommand({ id: "open", name: "Open view", callback: () => this.activateView() });
    this.addCommand({ id: "open-dotpm", name: "Open dotpm tab", callback: () => this.activateView("dotpm") });
    this.addCommand({ id: "open-today", name: "Open today's queue", callback: () => { this.settings.boardMode = "today"; this.activateView("board"); } });
    this.addCommand({ id: "create-capacity", name: "Create capacity file", callback: () => this.createCapacityFile() });
    this.addCommand({ id: "sync-progress", name: "Update progress from Done-when checklists (all tasks)", callback: () => this.syncAllProgress() });
    this.addSettingTab(new CompanionSettings(this.app, this));

    this.scheduleRecompute = debounce(() => this.recompute(), 400, true);
    this.app.workspace.onLayoutReady(async () => {
      await this.reloadDotpmConfig();
      await this.rebuildIndex();
      this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => this.onChanged(file, data, cache)));
      this.registerEvent(this.app.vault.on("delete", f => { if (this.tasks.delete(f.path)) this.scheduleRecompute(); if (f.path === this.settings.capacityFile) this.loadCapacity().then(() => this.scheduleRecompute()); }));
      this.registerEvent(this.app.vault.on("rename", (f, old) => { if (this.tasks.has(old)) { this.tasks.delete(old); this.indexFile(f).then(() => this.scheduleRecompute()); } }));
      this.registerEvent(this.app.vault.on("modify", f => {
        if (f.path === normalizePath(this.app.vault.configDir + "/plugins/project-manager/data.json")) this.reloadDotpmConfig().then(() => this.rebuildIndex());
      }));
      this.registerInterval(window.setInterval(() => {
        if (this.result && this.result.today !== M.localToday()) { this.settings.undo = {}; this.settings.pulled = {}; this.saveSettings(); this.recompute(); }
      }, 60 * 1000));
      if (this.settings.openOnStartup && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) this.activateView("dotpm");
    });
  }
  onunload() { for (const t of this.pendingProgress.values()) clearTimeout(t); }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    this.settings.multipliers = Object.assign({}, data.multipliers || {});
    this.settings.multiplierHistory = Array.isArray(data.multiplierHistory) ? data.multiplierHistory.slice() : [];
    // Undo entries only live for the day they were made ("Done today" clears at midnight).
    const today = M.localToday();
    this.settings.undo = Object.fromEntries(Object.entries(data.undo || {}).filter(([, v]) => v && v.date === today));
    this.settings.pulled = Object.fromEntries(Object.entries(data.pulled || {}).filter(([, v]) => v && v.date === today));
  }
  async saveSettings() { await this.saveData(this.settings); }

  async reloadDotpmConfig() {
    const p = normalizePath(this.app.vault.configDir + "/plugins/project-manager/data.json");
    try { this.cfg = M.readDotpmConfig(JSON.parse(await this.app.vault.adapter.read(p))); }
    catch (e) { console.warn("[dotpm-companion] could not read dotpm settings; using defaults", e); }
    if (M.ensureMultipliers(this.settings, V.typeKeys(this.cfg), M.localToday())) await this.saveSettings();
  }

  inProjects(path) { return path.startsWith(this.cfg.projectsFolder) && path.endsWith(".md") && !path.includes("/Archive/"); }
  taskList() { return [...this.tasks.values()]; }

  async indexFile(file, content) {
    if (!(file instanceof TFile) || !this.inProjects(file.path)) return null;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
    if (fm && fm["pm-project"] === true && typeof fm.title === "string") {
      this.projectColors[fm.title] = typeof fm.color === "string" ? fm.color : null;
      this.projectNotes[file.path] = { title: fm.title, parent: typeof fm.parent === "string" && fm.parent ? fm.parent : null };
    }
    if (!fm || fm["pm-task"] !== true) { this.tasks.delete(file.path); return null; }
    const text = content != null ? content : await this.app.vault.cachedRead(file);
    const t = M.parseTask(file.path, fm, M.bodyOf(text), this.cfg);
    if (t) this.tasks.set(file.path, t); else this.tasks.delete(file.path);
    return t;
  }
  async rebuildIndex() {
    this.tasks.clear();
    const files = this.app.vault.getMarkdownFiles().filter(f => this.inProjects(f.path));
    await Promise.all(files.map(f => this.indexFile(f)));
    await this.loadCapacity();
    this.recompute();
  }
  async loadCapacity() {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.capacityFile));
    this.capacity = f instanceof TFile ? M.parseCapacity(await this.app.vault.cachedRead(f)) : {};
  }
  async onChanged(file, data) {
    if (file.path === normalizePath(this.settings.capacityFile)) { this.capacity = M.parseCapacity(data); this.scheduleRecompute(); return; }
    if (!this.inProjects(file.path)) return;
    const t = await this.indexFile(file, data);
    this.scheduleRecompute();
    if (t && this.settings.progressFromChecklist) this.queueProgress(file.path);
  }

  recompute() {
    const today = M.localToday();
    this.result = M.compute(this.taskList(), this.cfg, { ...this.settings, capacity: this.capacity }, today);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof CompanionView) leaf.view.refresh();
  }

  // ---- dotpm bridge ----
  // dotpm keeps tasks in memory; changing them through its own store saves the file and redraws its views.
  // Internal API, so every call is guarded and falls back to a one-line frontmatter edit.
  dotpm() {
    const pm = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["project-manager"];
    return pm && pm.store && pm.index && typeof pm.store.updateTask === "function" && typeof pm.store.loadProjectByPath === "function"
      && typeof pm.index.task === "function" ? pm : null;
  }
  async updateViaDotpm(taskId, patch) {
    const pm = this.dotpm();
    if (!pm) return false;
    const ref = pm.index.task(taskId);
    if (!ref || !ref.projectPath) return false;
    const project = await pm.store.loadProjectByPath(ref.projectPath);
    if (!project) return false;
    await pm.store.updateTask(project, taskId, patch);
    if (["start", "due", "dependencies", "status", "type"].some(k => k in patch) && typeof pm.store.scheduleAfterChange === "function")
      await pm.store.scheduleAfterChange(project, taskId);
    if (typeof pm.refreshViews === "function") pm.refreshViews();
    return true;
  }
  // The one shared save path for every write the companion makes to a task.
  async updateTask(path, patch) {
    const t = this.tasks.get(path);
    if (!t) return;
    try { if (await this.updateViaDotpm(t.id, patch)) return; }
    catch (e) { console.warn("[dotpm-companion] dotpm update failed; editing the file instead", e); }
    const lines = {};
    for (const k in patch) lines[k] = typeof patch[k] === "number" ? String(patch[k]) : JSON.stringify(patch[k]);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.process(f, text => M.setFrontmatterLines(text, lines));
  }
  queueProgress(path) {
    clearTimeout(this.pendingProgress.get(path));
    const delay = this.dotpm() ? PROGRESS_DELAY_MS : FALLBACK_DELAY_MS;
    this.pendingProgress.set(path, setTimeout(() => { this.pendingProgress.delete(path); this.writeProgress(path); }, delay));
  }
  async writeProgress(path) {
    const t = this.tasks.get(path);
    const pct = t && M.checklistProgress(t.checklist);
    if (pct == null || pct === t.progress) return;
    await this.updateTask(path, { progress: pct });
  }
  async syncAllProgress() {
    let n = 0;
    for (const t of this.taskList()) {
      const pct = M.checklistProgress(t.checklist);
      if (pct != null && pct !== t.progress) { await this.updateTask(t.path, { progress: pct }); n++; }
    }
    new Notice(n ? `Updated progress on ${n} task${n === 1 ? "" : "s"}.` : "Progress already matches every checklist.");
  }
  async markDone(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    this.settings.undo[path] = { prev: t.status, date: M.localToday() };
    await this.saveSettings();
    await this.updateTask(path, { status: M.doneStatusId(this.cfg) });
    this.noticeWithUndo(`Marked “${t.title}” done.`, () => this.undoDone(path));
  }
  // Reopen a task finished today, back to the status it had before (or the first open status).
  async undoDone(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    const u = this.settings.undo[path];
    const open = this.cfg.statuses.filter(x => !x.complete);
    const prev = u && open.some(x => x.id === u.prev) ? u.prev : (open.find(x => x.id === "in-progress") || open[0] || { id: "todo" }).id;
    delete this.settings.undo[path];
    await this.saveSettings();
    await this.updateTask(path, { status: prev });
    new Notice(`Reopened “${t.title}”.`);
  }
  // Pull a not-yet-started task into today; remember its dates so it can be undone today.
  async startNow(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    const today = M.localToday();
    const patch = { start: today };
    if (t.due && t.due < today) patch.due = today;
    if (!this.settings.pulled[path]) this.settings.pulled[path] = { start: t.start, due: t.due, date: today };
    await this.saveSettings();
    await this.updateTask(path, patch);
    this.noticeWithUndo(`“${t.title}” added to the queue.`, () => this.undoStart(path));
  }
  // Put a pulled-in task back on its original dates.
  async undoStart(path) {
    const t = this.tasks.get(path), u = this.settings.pulled[path];
    if (!t || !u) return;
    delete this.settings.pulled[path];
    await this.saveSettings();
    const patch = { start: u.start || "" };
    if ((u.due || "") !== (t.due || "")) patch.due = u.due || "";
    await this.updateTask(path, patch);
    new Notice(`“${t.title}” is back to starting ${u.start || "unscheduled"}.`);
  }
  noticeWithUndo(text, undo) {
    const frag = document.createDocumentFragment();
    frag.append(text + " ");
    const n = new Notice(frag, 8000);
    const btn = document.createElement("button");
    btn.textContent = "Undo"; btn.className = "dpc-notice-undo";
    btn.addEventListener("click", e => { e.stopPropagation(); n.hide && n.hide(); undo(); });
    const el = n.noticeEl || n.messageEl;
    if (el) el.append(btn);
  }
  // Board drop: a week column shifts start and due by whole weeks.
  async moveCard(path, key) {
    const t = this.tasks.get(path);
    if (!t) return;
    const w = this.result && this.result.weeks.find(x => x.week === key);
    if (!w) return;
    const patch = M.shiftToWeek(t, w.start);
    if (patch) await this.updateTask(path, patch);
  }
  async setTaskField(path, field, value) {
    if (!["status", "priority"].includes(field)) return;
    const t = this.tasks.get(path);
    if (field === "status" && t && !M.isComplete(this.cfg, t.status) && M.isComplete(this.cfg, value)) {
      this.settings.undo[path] = { prev: t.status, date: M.localToday() }; await this.saveSettings();
    }
    await this.updateTask(path, { [field]: value });
  }
  // Open in dotpm's task editor when available, otherwise the note itself.
  openTask(path) {
    const pm = this.dotpm();
    try { if (pm && pm.router && typeof pm.router.openTask === "function") { pm.router.openTask({ filePath: path }); return; } }
    catch (e) { console.warn("[dotpm-companion] could not open dotpm editor", e); }
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
  }
  async setMultiplier(key, value) {
    this.settings.multipliers[key] = value;
    this.settings.multiplierHistory = M.recordMultiplier(this.settings.multiplierHistory, M.localToday(), key, value);
    await this.saveSettings();
    this.recompute();
  }
  async createCapacityFile() {
    const p = normalizePath(this.settings.capacityFile);
    if (this.app.vault.getAbstractFileByPath(p)) { new Notice(`${p} already exists.`); return; }
    const f = await this.app.vault.create(p, M.capacityTemplate(this.settings.rangeStart, this.settings.rangeEnd, this.settings.defaultWeeklyHours));
    await this.loadCapacity(); this.recompute();
    this.app.workspace.getLeaf(true).openFile(f);
  }
  // Top-level project for the dotpm tab: the one chosen in settings, else the first project with no parent.
  rootProjectPath() {
    const notes = this.projectNotes;
    if (this.settings.dotpmScope && notes[this.settings.dotpmScope]) return this.settings.dotpmScope;
    const roots = Object.keys(notes).filter(k => !notes[k].parent).sort();
    return roots[0] || Object.keys(notes).sort()[0] || "";
  }
  async openDotpmInTab() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "pm-project", active: true, state: { scope: { kind: "project", path: this.rootProjectPath() } } });
  }
  async activateView(tab) {
    if (tab) this.settings.lastTab = tab;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    else if (tab && leaf.view instanceof CompanionView) leaf.view.switchTab(tab);
    this.app.workspace.revealLeaf(leaf);
  }
};


class CompanionSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this, p = this.plugin, S = p.settings;
    el.empty();
    const save = async () => { await p.saveSettings(); await p.loadCapacity(); p.recompute(); };
    new Setting(el).setName("Capacity file").setDesc("Markdown table with a Week column (2026-W43) and an Available hours column.")
      .addText(t => t.setValue(S.capacityFile).onChange(async v => { S.capacityFile = v.trim() || DEFAULTS.capacityFile; await save(); }));
    new Setting(el).setName("Default hours per week").setDesc("Used for any week missing from the capacity file.")
      .addText(t => t.setValue(String(S.defaultWeeklyHours)).onChange(async v => { const n = parseFloat(v); if (n >= 0) { S.defaultWeeklyHours = n; await save(); } }));
    new Setting(el).setName("Planning range").setDesc("First and last day shown in the capacity view (YYYY-MM-DD).")
      .addText(t => t.setPlaceholder("start").setValue(S.rangeStart).onChange(async v => { if (M.isDate(v)) { S.rangeStart = v; await save(); } }))
      .addText(t => t.setPlaceholder("end").setValue(S.rangeEnd).onChange(async v => { if (M.isDate(v)) { S.rangeEnd = v; await save(); } }));
    new Setting(el).setName("Overload threshold").setDesc("Flag a week at this share of available hours (%).")
      .addText(t => t.setValue(String(S.overloadPct)).onChange(async v => { const n = parseFloat(v); if (n > 0) { S.overloadPct = n; await save(); } }));
    new Setting(el).setName("Progress from Done-when checklist").setDesc("Set each task's progress to the share of ticked boxes under “## Done when”. Overwrites progress set by hand on those tasks.")
      .addToggle(t => t.setValue(S.progressFromChecklist).onChange(async v => { S.progressFromChecklist = v; await save(); }));
    new Setting(el).setName("dotpm tab project").setDesc("Project the dotpm tab opens on. Its sub-projects are included.")
      .addDropdown(d => {
        d.addOption("", "Top-level project (automatic)");
        for (const k of Object.keys(p.projectNotes).sort()) d.addOption(k, p.projectNotes[k].title + (p.projectNotes[k].parent ? "" : " (top level)"));
        d.setValue(S.dotpmScope || "").onChange(async v => { S.dotpmScope = v; S.dotpmState = null; await p.saveSettings(); });
      });
    new Setting(el).setName("Open on startup").setDesc("Open the companion on the dotpm tab when Obsidian starts.")
      .addToggle(t => t.setValue(S.openOnStartup).onChange(async v => { S.openOnStartup = v; await p.saveSettings(); }));
    new Setting(el).setName("Multipliers").setHeading();
    for (const k of V.typeKeys(p.cfg)) {
      new Setting(el).setName(V.typeName(k)).addText(t => t.setValue(String(M.multiplierFor(S.multipliers, k))).onChange(v => {
        const n = parseFloat(v); if (isFinite(n) && n > 0) p.setMultiplier(k, Math.round(n * 100) / 100);
      }));
    }
  }
}
module.exports.CompanionView = CompanionView;
