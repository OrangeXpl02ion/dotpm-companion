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
  lastTab: "tasks",
  showDone: false,
  boardMode: "week",
  undo: {},
  openOnStartup: true,
  lastMode: "adj",
};

class CompanionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = plugin.settings.lastTab; this.mode = plugin.settings.lastMode; this.expanded = null; this.collapsed = new Set(); this.query = ""; }
  boardMode() { return this.plugin.settings.boardMode === "status" ? "status" : "week"; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "dotpm Companion"; }
  getIcon() { return "gauge"; }
  async onOpen() { this.refresh(); }
  onResize() { this.refresh(); }
  refresh() {
    const p = this.plugin;
    const root = this.contentEl;
    V.render(root, {
      tab: this.tab, mode: this.mode, expanded: this.expanded, collapsed: this.collapsed, query: this.query,
      bridged: !!p.dotpm(), showMore: !!this.showMore,
      cfg: p.cfg, settings: { ...p.settings, capacity: p.capacity }, tasks: p.taskList(), result: p.result,
    }, {
      setTab: t => { this.tab = t; p.settings.lastTab = t; p.saveSettings(); this.refresh(); },
      setMode: m => { this.mode = m; p.settings.lastMode = m; p.saveSettings(); this.refresh(); },
      toggleWeek: w => { this.expanded = this.expanded === w ? null : w; this.refresh(); },
      openTask: path => p.openTask(path),
      openFile: path => { const f = p.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) p.app.workspace.getLeaf(false).openFile(f); },
      markDone: path => p.markDone(path),
      setField: (path, field, value) => p.setTaskField(path, field, value),
      setShowDone: v => { p.settings.showDone = v; p.saveSettings(); this.refresh(); },
      toggleGroup: g => { if (this.collapsed.has(g)) this.collapsed.delete(g); else this.collapsed.add(g); this.refresh(); },
      setQuery: q => { this.query = q; },
      undoDone: path => p.undoDone(path),
      startNow: path => p.startNow(path),
      moveCard: (path, key) => p.moveCard(path, key, this.boardMode()),
      setBoardMode: m => { p.settings.boardMode = m; p.saveSettings(); this.refresh(); },
      toggleMore: () => { this.showMore = !this.showMore; this.refresh(); },
      setMultiplier: (k, v) => p.setMultiplier(k, v),
      createCapacity: () => p.createCapacityFile(),
    });
  }
}

module.exports = class DotpmCompanion extends Plugin {
  async onload() {
    this.tasks = new Map();
    this.capacity = {};
    this.result = null;
    this.pendingProgress = new Map();
    this.cfg = M.readDotpmConfig({});
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new CompanionView(leaf, this));
    this.addRibbonIcon("gauge", "dotpm Companion", () => this.activateView());
    this.addCommand({ id: "open", name: "Open view", callback: () => this.activateView() });
    this.addCommand({ id: "open-tasks", name: "Open all tasks", callback: () => this.activateView("tasks") });
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
        if (this.result && this.result.today !== M.localToday()) { this.settings.undo = {}; this.saveSettings(); this.recompute(); }
      }, 60 * 1000));
      if (this.settings.openOnStartup && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) this.activateView("tasks");
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
    new Notice(`Marked “${t.title}” done.`);
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
  // Pull a not-yet-started task into today.
  async startNow(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    const today = M.localToday();
    const patch = { start: today };
    if (t.due && t.due < today) patch.due = today;
    await this.updateTask(path, patch);
    new Notice(`“${t.title}” starts today.`);
  }
  // Board drop: a week column shifts start and due by whole weeks; a status column sets the status.
  async moveCard(path, key, mode) {
    const t = this.tasks.get(path);
    if (!t) return;
    if (mode === "status") { if (key !== t.status && this.cfg.statuses.some(x => x.id === key)) await this.updateTask(path, { status: key }); return; }
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
  async activateView(tab) {
    if (tab) this.settings.lastTab = tab;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    else if (tab && leaf.view instanceof CompanionView) { leaf.view.tab = tab; leaf.view.refresh(); }
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
    new Setting(el).setName("Open on startup").setDesc("Open the companion on the All tasks tab when Obsidian starts.")
      .addToggle(t => t.setValue(S.openOnStartup).onChange(async v => { S.openOnStartup = v; await p.saveSettings(); }));
    new Setting(el).setName("Multipliers").setHeading();
    for (const k of V.typeKeys(p.cfg)) {
      new Setting(el).setName(V.typeName(k)).addText(t => t.setValue(String(M.multiplierFor(S.multipliers, k))).onChange(v => {
        const n = parseFloat(v); if (isFinite(n) && n > 0) p.setMultiplier(k, Math.round(n * 100) / 100);
      }));
    }
  }
}
