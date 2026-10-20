"use strict";
const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, normalizePath, debounce } = require("obsidian");
const M = require("./model");
const V = require("./views");

const VIEW_TYPE = "dotpm-companion";
const PROGRESS_DELAY_MS = 6000;
const DEFAULTS = {
  capacityFile: "Capacity.md",
  defaultWeeklyHours: 40,
  rangeStart: "2026-10-19",
  rangeEnd: "2026-12-11",
  overloadPct: 85,
  progressFromChecklist: true,
  multipliers: {},
  multiplierHistory: [],
  lastTab: "capacity",
  lastMode: "adj",
};

class CompanionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = plugin.settings.lastTab; this.mode = plugin.settings.lastMode; this.expanded = null; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "dotpm Companion"; }
  getIcon() { return "gauge"; }
  async onOpen() { this.refresh(); }
  onResize() { this.refresh(); }
  refresh() {
    const p = this.plugin;
    const root = this.contentEl;
    V.render(root, {
      tab: this.tab, mode: this.mode, expanded: this.expanded,
      cfg: p.cfg, settings: { ...p.settings, capacity: p.capacity }, tasks: p.taskList(), result: p.result,
    }, {
      setTab: t => { this.tab = t; p.settings.lastTab = t; p.saveSettings(); this.refresh(); },
      setMode: m => { this.mode = m; p.settings.lastMode = m; p.saveSettings(); this.refresh(); },
      toggleWeek: w => { this.expanded = this.expanded === w ? null : w; this.refresh(); },
      openTask: path => { const f = p.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) p.app.workspace.getLeaf(false).openFile(f); },
      markDone: path => p.markDone(path),
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
      this.registerInterval(window.setInterval(() => { if (this.result && this.result.today !== M.localToday()) this.recompute(); }, 60 * 1000));
    });
  }
  onunload() { for (const t of this.pendingProgress.values()) clearTimeout(t); }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    this.settings.multipliers = Object.assign({}, data.multipliers || {});
    this.settings.multiplierHistory = Array.isArray(data.multiplierHistory) ? data.multiplierHistory.slice() : [];
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

  // ---- the one shared save path: minimal line edits in the frontmatter ----
  // dotpm ignores outside edits to a file for 5 s after it saves that file itself (SELF_WRITE_WINDOW_MS),
  // so wait 6 s after the last change; otherwise dotpm keeps showing the old progress.
  queueProgress(path) {
    clearTimeout(this.pendingProgress.get(path));
    this.pendingProgress.set(path, setTimeout(() => { this.pendingProgress.delete(path); this.writeProgress(path); }, PROGRESS_DELAY_MS));
  }
  async writeProgress(path) {
    const t = this.tasks.get(path);
    const pct = t && M.checklistProgress(t.checklist);
    if (pct == null || pct === t.progress) return;
    await this.editFrontmatter(path, { progress: String(pct) });
  }
  async editFrontmatter(path, fields) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, text => M.setFrontmatterLines(text, fields));
  }
  async syncAllProgress() {
    let n = 0;
    for (const t of this.taskList()) {
      const pct = M.checklistProgress(t.checklist);
      if (pct != null && pct !== t.progress) { await this.editFrontmatter(t.path, { progress: String(pct) }); n++; }
    }
    new Notice(n ? `Updated progress on ${n} task${n === 1 ? "" : "s"}.` : "Progress already matches every checklist.");
  }
  async markDone(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    await this.editFrontmatter(path, { status: JSON.stringify(M.doneStatusId(this.cfg)) });
    new Notice(`Marked “${t.title}” done.`);
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
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
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
    new Setting(el).setName("Progress from Done-when checklist").setDesc("Set each task's progress to the share of ticked boxes under “## Done when”. Overwrites progress set by hand on those tasks. Updates about 6 seconds after you tick a box.")
      .addToggle(t => t.setValue(S.progressFromChecklist).onChange(async v => { S.progressFromChecklist = v; await save(); }));
    new Setting(el).setName("Multipliers").setHeading();
    for (const k of V.typeKeys(p.cfg)) {
      new Setting(el).setName(V.typeName(k)).addText(t => t.setValue(String(M.multiplierFor(S.multipliers, k))).onChange(v => {
        const n = parseFloat(v); if (isFinite(n) && n > 0) p.setMultiplier(k, Math.round(n * 100) / 100);
      }));
    }
  }
}
