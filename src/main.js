"use strict";
const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, TFolder, Modal, FuzzySuggestModal, Platform, Scope, normalizePath, debounce, parseYaml } = require("obsidian");
const M = require("./model");
const V = require("./views");

const VIEW_TYPE = "dotpm-companion";
// Through dotpm's own store the change is visible at once; the file-edit fallback must wait out
// dotpm's 5 s self-write window or dotpm keeps showing the old value.
const PROGRESS_DELAY_MS = 1500;
const FALLBACK_DELAY_MS = 6000;
const STAMP_INPUT_MS = 2 * 60 * 1000; // you used this computer this recently → a new log was made here
const STAMP_QUIET_MS = 15 * 1000;     // wait for the time panel to go quiet before adding times
const DEFAULTS = {
  capacityFile: "Capacity.md",
  capacityRulesFile: "Claude/capacity-rules.json",
  defaultWeeklyHours: 40,
  rangeStart: "2026-10-19",
  rangeEnd: "2026-12-11",
  overloadPct: 85,
  tightPct: 50,
  progressFromChecklist: true,
  multipliers: {},
  multiplierHistory: [],
  lastTab: "board",
  dotpmScope: "",
  dotpmDueSort: true,
  dotpmSortSeen: [],
  workTypeFromProject: true,
  quickAddProject: "Misc",
  templatesFolder: "Templates/Projects",
  scheduleLog: true,
  scheduleLogFile: "Schedule log.md",
  spilloverFile: "Spillover.md",
  lastSpilloverWeek: "",
  logDeviceId: "",
  dotpmState: null,
  showDone: false,
  boardMode: "today",
  typesView: "type",
  daysGroup: "type",
  weekPlans: {},
  showSubprojects: true,
  undo: {},
  capacityLocal: [],
  pulled: {},
  openOnStartup: true,
  lastMode: "adj",
  timeMode: "day",
  timeGroup: "type",
  stampDotpmLogs: true,
};

class CompanionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = ({ tasks: "dotpm", queue: "board", categories: "types" })[plugin.settings.lastTab] || plugin.settings.lastTab; this.mode = plugin.settings.lastMode; this.expanded = null; this.collapsed = new Set(); this.query = ""; this.openProjects = new Set();
    // N opens Quick add and C Quick capacity while this tab is active (outside the hosted dotpm view, which has its own keys).
    if (typeof Scope === "function") {
      this.ownScope = new Scope(this.app.scope);
      this.ownScope.register([], "n", evt => {
        const t = evt && evt.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return true;
        new QuickAddModal(this.plugin).open();
        return false;
      });
      this.ownScope.register([], "c", evt => {
        const t = evt && evt.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return true;
        new QuickCapacityModal(this.plugin).open();
        return false;
      });
      this.scope = this.ownScope;
    }
  }
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
    const state = { scope: p.validScope(p.settings.dotpmState && p.settings.dotpmState.scope) || p.defaultScope() };
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
    if (this.tab === "dotpm" && t !== "dotpm") { this.saveDotpmState(); this.scope = this.ownScope || null; }
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
      bridged: !!p.dotpm(), showMore: !!this.showMore, openProjects: this.openProjects, projects: Object.values(p.projectNotes).filter(x => !x.archived),
      spill: M.spillover(p.taskList(), p.cfg, M.mondayOf(M.localToday())), projectColors: p.projectColors, dotpmError: this.dotpmError ? String(this.dotpmError.message || this.dotpmError) : null,
      cfg: p.cfg, settings: { ...p.settings, capacity: p.capacity, capacityDays: p.capacityDays || {} }, tasks: p.taskList(), result: p.result,
      time: { mode: p.settings.timeMode, group: p.settings.timeGroup, date: this.timeDate }, today: M.localToday(),
      proj: { view: p.settings.projView, group: p.settings.projGroup, week: this.proj && this.proj.week },
      nowHours: (() => { const n = new Date(); return n.getHours() + n.getMinutes() / 60; })(), workWindow: p.workWindow || null,
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
      notToday: path => p.notToday(path),
      logTime: path => { const t = p.tasks.get(path); if (t) new LogTimeModal(p, t).open(); },
      quickAdd: () => new QuickAddModal(p).open(),
      quickCapacity: () => new QuickCapacityModal(p).open(),
      newFromTemplate: () => p.templatePicker(),
      toggleProject: k => { if (this.openProjects.has(k)) this.openProjects.delete(k); else this.openProjects.add(k); this.refresh(); },
      openProjectNote: path => { const f = p.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) p.app.workspace.getLeaf(false).openFile(f); },
      moveCard: (path, key) => p.moveCard(path, key),
      setBoardMode: m => { p.settings.boardMode = m; p.saveSettings(); this.refresh(); },
      setDaysGroup: g => { p.settings.daysGroup = g; p.saveSettings(); this.refresh(); },
      setTypesView: m => { p.settings.typesView = m; p.saveSettings(); this.refresh(); },
      setSubprojects: v => { p.settings.showSubprojects = !!v; p.saveSettings(); this.refresh(); },
      toggleMore: () => { this.showMore = !this.showMore; this.refresh(); },
      setMultiplier: (k, v) => p.setMultiplier(k, v),
      createCapacity: () => p.createCapacityFile(),
      openTimeWeek: from => { p.settings.timeMode = "week"; this.timeDate = from > M.mondayOf(M.localToday()) ? null : M.addDays(from, 6) > M.localToday() ? null : M.addDays(from, 6); this.switchTab("time"); },
      setProj: patch => {
        this.proj = { ...(this.proj || {}), ...patch };
        if (patch.view) p.settings.projView = patch.view;
        if (patch.group) p.settings.projGroup = patch.group;
        if (patch.view || patch.group) p.saveSettings();
        this.refresh();
      },
      setTime: patch => {
        if (patch.mode) p.settings.timeMode = patch.mode;
        if (patch.group) p.settings.timeGroup = patch.group;
        if (patch.date) this.timeDate = patch.date === M.localToday() ? null : patch.date;
        if (patch.mode || patch.group) p.saveSettings();
        this.refresh();
      },
    });
  }
}

const DotpmCompanion = module.exports = class DotpmCompanion extends Plugin {
  async onload() {
    this.tasks = new Map();
    this.pendingStamp = new Map();
    this.lastInput = 0;
    this.projectColors = {};
    this.projectNotes = {};
    this.capacity = {};
    this.capacityDays = {};
    this.ticks = 0;
    this.result = null;
    this.pendingProgress = new Map();
    this.diag = { fromFile: 0, dotpmConfig: "not read yet", lastIndex: null, files: 0 };
    this.dates = new Map(); this.reasons = new Map(); this.logGroup = []; this.logTimer = null; this.confirmDone = new Map();
    this.cfg = M.readDotpmConfig({});
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new CompanionView(leaf, this));
    this.addRibbonIcon("gauge", "dotpm Companion", () => this.activateView());
    this.addCommand({ id: "open", name: "Open view", callback: () => this.activateView() });
    this.addCommand({ id: "open-dotpm", name: "Open dotpm tab", callback: () => this.activateView("dotpm") });
    this.addCommand({ id: "open-today", name: "Open today's queue", callback: () => { this.settings.boardMode = "today"; this.activateView("board"); } });
    this.addCommand({ id: "create-capacity", name: "Create capacity file", callback: () => this.createCapacityFile() });
    this.addCommand({ id: "open-time", name: "Open time spent", callback: () => this.activateView("time") });
    this.addCommand({ id: "open-projects", name: "Open project progress", callback: () => this.activateView("projects") });
    this.addCommand({ id: "quick-add", name: "Quick add task", callback: () => new QuickAddModal(this).open() });
    this.addCommand({ id: "quick-capacity", name: "Quick capacity (change a day's hours)", callback: () => new QuickCapacityModal(this).open() });
    this.addCommand({ id: "log-time", name: "Log time…", callback: () => this.logTimePicker() });
    this.addCommand({ id: "log-time-here", name: "Log time on this task", checkCallback: checking => {
      const f = this.app.workspace.getActiveFile(); const t = f && this.tasks.get(f.path);
      if (!t) return false; if (!checking) new LogTimeModal(this, t).open(); return true; } });
    this.addCommand({ id: "new-from-template", name: "New project from template", callback: () => this.templatePicker() });
    this.addCommand({ id: "diagnostics", name: "Show diagnostics", callback: () => new DiagnosticsModal(this).open() });
    this.addCommand({ id: "reindex", name: "Re-read all tasks", callback: async () => { await this.reloadDotpmConfig(); await this.rebuildIndex(); new Notice(`Re-read ${this.tasks.size} tasks.`); } });
    this.addCommand({ id: "write-spillover", name: "Write last week's spillover now", callback: () => this.writeSpillover(true) });
    this.addCommand({ id: "sync-progress", name: "Update progress from Done-when checklists (all tasks)", callback: () => this.syncAllProgress() });
    this.addSettingTab(new CompanionSettings(this.app, this));

    this.scheduleRecompute = debounce(() => this.recompute(), 400, true);
    this.app.workspace.onLayoutReady(async () => {
      await this.reloadDotpmConfig();
      await this.rebuildIndex();
      try { await this.applyDotpmDueSort(); } catch (e) { console.warn("[dotpm-companion] could not set dotpm's default sort", e); }
      for (const t of this.taskList()) if (!t.workType) await this.applyProjectWorkType(t.path);
      this.claimLogDevice();
      await this.writeSpillover(false);
      this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => this.onChanged(file, data, cache)));
      // When Obsidian finishes (re)building its metadata cache — e.g. right after a sync — read everything again.
      const reindex = debounce(() => this.rebuildIndex(), 1500, true);
      this.registerEvent(this.app.metadataCache.on("resolved", () => { if (!this.indexing) reindex(); }));
      this.registerEvent(this.app.vault.on("create", f => { if (f instanceof TFile && this.inProjects(f.path)) this.indexFile(f).then(() => this.scheduleRecompute()); }));
      this.registerEvent(this.app.vault.on("delete", f => { if (this.tasks.delete(f.path)) this.scheduleRecompute(); if (f.path === this.settings.capacityFile) this.loadCapacity().then(() => this.scheduleRecompute()); }));
      this.registerEvent(this.app.vault.on("rename", (f, old) => { if (this.tasks.has(old)) { this.tasks.delete(old); this.indexFile(f).then(() => this.scheduleRecompute()); } }));
      this.registerEvent(this.app.vault.on("modify", f => {
        if (f.path === normalizePath(this.app.vault.configDir + "/plugins/project-manager/data.json")) this.reloadDotpmConfig().then(() => this.rebuildIndex());
      }));
      const touched = () => { this.lastInput = Date.now(); };
      this.registerDomEvent(window, "keydown", touched, true);
      this.registerDomEvent(window, "pointerdown", touched, true);
      this.registerInterval(window.setInterval(() => {
        if (this.result && this.result.today !== M.localToday()) { this.settings.undo = {}; this.settings.pulled = {}; this.saveSettings(); this.recompute(); this.writeSpillover(false); }
        else if (++this.ticks % 15 === 0) this.recompute(); // today's hours left shrink as the day goes on
      }, 60 * 1000));
      if (this.settings.openOnStartup && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) this.activateView("dotpm");
    });
  }
  onunload() { for (const t of this.pendingProgress.values()) clearTimeout(t); for (const p of (this.pendingStamp || new Map()).values()) clearTimeout(p.timer); if (this.logTimer) { clearTimeout(this.logTimer); this.flushScheduleLog(); } }

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
    try { this.cfg = M.readDotpmConfig(JSON.parse(await this.app.vault.adapter.read(p))); this.diag.dotpmConfig = "read"; }
    catch (e) { this.diag.dotpmConfig = `not found (${String(e && e.message || e).slice(0, 80)}) — using defaults`; console.warn("[dotpm-companion] could not read dotpm settings; using defaults", e); }
    if (M.ensureMultipliers(this.settings, V.typeKeys(this.cfg), M.localToday())) await this.saveSettings();
    this.cfg.extraTypes = [];
  }

  inProjects(path) { return path.startsWith(this.cfg.projectsFolder) && path.endsWith(".md") && !path.includes("/Archive/"); }
  taskList() { return [...this.tasks.values()]; }

  async indexFile(file, content) {
    if (!(file instanceof TFile) || !this.inProjects(file.path)) return null;
    let fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
    let text = content;
    // On a device that just synced, Obsidian's metadata cache may not be built yet: read the file itself.
    if (!fm) {
      text = text != null ? text : await this.app.vault.cachedRead(file);
      fm = M.frontmatterOf(text, typeof parseYaml === "function" ? parseYaml : null);
      if (fm) this.diag.fromFile++;
    }
    if (fm && fm["pm-project"] === true && typeof fm.title === "string") {
      this.projectColors[fm.title] = typeof fm.color === "string" ? fm.color : null;
      text = text != null ? text : await this.app.vault.cachedRead(file);
      const body = M.bodyOf(text).replace(/^\s*#[ \t][^\n]*\n?/, "").replace(/(?:^|\n)## Tasks[\s\S]*$/, "").trim();
      this.projectNotes[file.path] = { path: file.path, title: fm.title, parent: typeof fm.parent === "string" && fm.parent ? fm.parent : null,
        icon: typeof fm.icon === "string" ? fm.icon : "📋", color: typeof fm.color === "string" ? fm.color : null, description: body, archived: fm.archived === true };
    }
    if (!fm || fm["pm-task"] !== true) { this.tasks.delete(file.path); return null; }
    text = text != null ? text : await this.app.vault.cachedRead(file);
    const t = M.parseTask(file.path, fm, M.bodyOf(text), this.cfg);
    if (t) this.tasks.set(file.path, t); else this.tasks.delete(file.path);
    if (t) this.trackDates(t);
    return t;
  }
  async rebuildIndex() {
    this.tasks.clear();
    this.dates = new Map(); this.indexing = true;
    const files = this.app.vault.getMarkdownFiles().filter(f => this.inProjects(f.path));
    this.diag.fromFile = 0; this.diag.files = files.length;
    await Promise.all(files.map(f => this.indexFile(f)));
    this.diag.lastIndex = new Date().toLocaleTimeString();
    this.indexing = false;
    await this.loadCapacity();
    this.recompute();
  }
  async loadCapacity() {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.capacityFile));
    const md = f instanceof TFile ? await this.app.vault.cachedRead(f) : null;
    this.capacity = md ? M.parseCapacity(md) : {};
    this.capacityDays = md ? M.parseCapacityDays(md) : {};
    const rules = await this.readRules();
    this.workWindow = rules && !rules.__error && rules.window ? rules.window : null;
  }
  async onChanged(file, data) {
    if (file.path === normalizePath(this.settings.capacityFile)) { this.capacity = M.parseCapacity(data); this.capacityDays = M.parseCapacityDays(data); this.scheduleRecompute(); return; }
    if (!this.inProjects(file.path)) return;
    const prev = this.tasks.get(file.path);
    const t = await this.indexFile(file, data);
    if (t) this.watchLogs(file.path, prev);
    this.scheduleRecompute();
    if (t) this.queueProgress(file.path);
    if (t && !t.workType) this.applyProjectWorkType(file.path);
    if (!t && data && /^---[\s\S]*?pm-project: true/.test(data)) this.applyDotpmDueSort();
  }

  recompute() {
    const today = M.localToday();
    // work types still on tasks but no longer in dotpm's list (e.g. a renamed option) stay visible
    this.cfg.extraTypes = [...new Set(this.taskList().map(t => t.workType).filter(w => w && !this.cfg.workTypes.includes(w)))].sort();
    const now = new Date();
    this.result = M.compute(this.taskList(), this.cfg, { ...this.settings, capacity: this.capacity, capacityDays: this.capacityDays || {},
      workWindow: this.workWindow || null, nowHours: now.getHours() + now.getMinutes() / 60 }, today);
    // Freeze this week's plan the first time it is seen (Week projection compares it with logged time).
    if (!this.indexing && this.tasks.size && M.recordWeekPlan(this.settings, this.result, this.taskList(), today)) this.saveSettings();
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
    for (const k in patch) { if (typeof patch[k] === "object" && patch[k] !== null) return; lines[k] = typeof patch[k] === "number" ? String(patch[k]) : JSON.stringify(patch[k]); }
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
    const pct = M.targetProgress(this.cfg, t, this.settings.progressFromChecklist);
    if (pct == null || pct === t.progress) return;
    await this.updateTask(path, { progress: pct });
  }
  async syncAllProgress() {
    let n = 0;
    for (const t of this.taskList()) {
      const pct = M.targetProgress(this.cfg, t, this.settings.progressFromChecklist);
      if (pct != null && pct !== t.progress) { await this.updateTask(t.path, { progress: pct }); n++; }
    }
    new Notice(n ? `Updated progress on ${n} task${n === 1 ? "" : "s"}.` : "Progress already matches every checklist.");
  }
  async markDone(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    const left = t.checklist ? t.checklist.total - t.checklist.done : 0;
    const asked = this.confirmDone.get(path);
    if (left > 0 && !(asked && Date.now() - asked < 8000)) {
      this.confirmDone.set(path, Date.now());
      new Notice(`“${t.title}” has ${left} Done-when item${left === 1 ? "" : "s"} not ticked. Press ✓ again to mark it done anyway.`, 8000);
      return;
    }
    this.confirmDone.delete(path);
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
    this.settings.pulled[path].kind = "added";
    await this.saveSettings();
    this.noteReason(path, "Start now (Today)");
    await this.updateTask(path, patch);
    this.noticeWithUndo(`“${t.title}” added to the queue.`, () => this.undoStart(path));
  }
  // Put a pulled-in task back on its original dates.
  async undoStart(path) {
    const t = this.tasks.get(path), u = this.settings.pulled[path];
    if (!t || !u) return;
    delete this.settings.pulled[path];
    await this.saveSettings();
    this.noteReason(path, "undo in Today");
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
    this.noteReason(path, "moved on the Board");
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
  // Today: push a started task to tomorrow (start, and due if it would fall before), with undo.
  async notToday(path) {
    const t = this.tasks.get(path);
    if (!t) return;
    const today = M.localToday(), tomorrow = M.addDays(today, 1);
    if (!this.settings.pulled[path]) this.settings.pulled[path] = { start: t.start, due: t.due, date: today };
    this.settings.pulled[path].kind = "deferred";
    await this.saveSettings();
    const patch = { start: tomorrow };
    if (t.due && t.due < tomorrow) patch.due = tomorrow;
    this.noteReason(path, "Not today (Today)");
    await this.updateTask(path, patch);
    this.noticeWithUndo(`“${t.title}” moved to tomorrow${patch.due ? " (due date too)" : ""}.`, () => this.undoStart(path));
  }

  // ---- time log ----
  // The file's time logs, keeping every field already on each log (start/end, anything dotpm adds later).
  rawLogs(f) {
    const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
    return (Array.isArray(fm.timeLogs) ? fm.timeLogs : []).map(l => {
      const o = { ...l, date: M.normDate(l.date) || String(l.date || ""), hours: Number(l.hours) || 0, note: typeof l.note === "string" ? l.note : "" };
      for (const k of ["start", "end"]) { if (k in l) { const c = M.normClock(l[k]); if (c) o[k] = c; else delete o[k]; } }
      return o;
    });
  }
  // dotpm's time panel saves only a date and hours. When a log appears that way on this computer, add the time it
  // was noticed as its end and `hours` before that as its start, so the Time tab can place it in the day.
  // Only the computer you were using does this (input in the last 2 minutes); one that just received the file
  // through sync leaves it alone. Waits until the file has been quiet for 15 s so a note being typed isn't cut off.
  watchLogs(path, prev) {
    if (!this.settings.stampDotpmLogs || this.indexing || !prev) return;
    let p = this.pendingStamp.get(path);
    if (!p) {
      if (Date.now() - (this.lastInput || 0) > STAMP_INPUT_MS) return;
      const now = new Date();
      p = { before: prev.logs.map(l => ({ ...l })), at: now.getHours() * 60 + now.getMinutes(), day: M.localToday() };
      this.pendingStamp.set(path, p);
    }
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { this.pendingStamp.delete(path); this.stampLogs(path, p).catch(e => console.warn("[dotpm-companion] could not add times to a log", e)); }, STAMP_QUIET_MS);
  }
  async stampLogs(path, p) {
    const f = this.app.vault.getAbstractFileByPath(path), t = this.tasks.get(path);
    if (!(f instanceof TFile) || !t) return;
    const logs = this.rawLogs(f), idx = M.logsToStamp(p.before, logs, p.day), fix = M.logsToRestamp(p.before, logs);
    if (!idx.length && !fix.length) return;
    for (const i of idx) Object.assign(logs[i], M.stampTimes(logs[i].hours, p.at));
    // hours changed on a log whose times matched the old hours: keep its end, move its start
    for (const i of fix) { const [hh, mm] = logs[i].end.split(":").map(Number); Object.assign(logs[i], M.stampTimes(logs[i].hours, hh * 60 + mm)); }
    await this.updateTask(path, { timeLogs: logs });
    const all = [...idx, ...fix];
    new Notice(`${idx.length ? "Added" : "Updated"} times on your log on “${t.title}”: ${all.map(i => `${logs[i].start}–${logs[i].end}`).join(", ")}. Change them in dotpm if they're off.`);
  }
  logTimePicker() {
    const f = this.app.workspace.getActiveFile(), here = f && this.tasks.get(f.path);
    if (here) { new LogTimeModal(this, here).open(); return; }
    new TaskSuggestModal(this, t => new LogTimeModal(this, t).open()).open();
  }
  async logTime(path, v) {
    const t = this.tasks.get(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!t || !(f instanceof TFile)) return;
    const logs = this.rawLogs(f);
    const today = M.localToday(), hours = v.hours;
    const entry = { date: v.dayOffset ? M.addDays(today, v.dayOffset) : today, hours, note: v.note || "" };
    if (v.start) { entry.start = v.start; entry.end = v.end; }
    logs.push(entry);
    if (this.dotpm()) await this.updateTask(path, { timeLogs: logs });
    else await this.app.vault.process(f, text => M.appendTimeLog(text, logs[logs.length - 1]));
    new Notice(`Logged ${M.describeLog(v)} on “${t.title}”.`);
  }

  // ---- quick-add and templates: create through dotpm's store ----
  projectPathByTitle(title) { return Object.keys(this.projectNotes).find(k => this.projectNotes[k].title === title) || null; }
  newTaskObject(fields) {
    const now = new Date().toISOString(), today = M.localToday();
    const t = { id: newId(), title: fields.title, description: fields.description || "", type: "task", status: "todo", priority: fields.priority || "medium",
      start: fields.start || today, due: fields.due || "", progress: 0, completed: "", assignees: [], tags: fields.tags || [], subtasks: [], dependencies: fields.dependencies || [],
      customFields: fields.workType && this.cfg.workTypeFieldId ? { [this.cfg.workTypeFieldId]: fields.workType } : {}, createdAt: now, updatedAt: now };
    if (fields.estimate != null) t.timeEstimate = fields.estimate;
    return t;
  }
  async createTask(projectTitle, fields) {
    const pm = this.dotpm(), path = this.projectPathByTitle(projectTitle);
    if (!path) throw new Error(`No project called “${projectTitle}”.`);
    const task = this.newTaskObject(fields);
    if (pm && typeof pm.store.insertTask === "function") {
      const project = await pm.store.loadProjectByPath(path);
      if (!project) throw new Error(`dotpm couldn't load “${projectTitle}”.`);
      await pm.store.insertTask(project, task, null);
      if (typeof pm.refreshViews === "function") pm.refreshViews();
      return task;
    }
    const folder = path.replace(/\/[^/]+$/, "") + "/_tasks";
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    await this.app.vault.create(normalizePath(`${folder}/${M.slug(task.title)}.md`), M.taskFile(task, projectTitle));
    return task;
  }
  async templatePicker() {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatesFolder));
    let files = folder instanceof TFolder ? folder.children.filter(f => f instanceof TFile && f.extension === "md") : [];
    if (!files.length) { files = [await this.createExampleTemplate()]; new Notice(`Created an example template in ${this.settings.templatesFolder}.`); }
    new FileSuggestModal(this, files, f => new TemplateModal(this, f).open()).open();
  }
  async createExampleTemplate() {
    const dir = normalizePath(this.settings.templatesFolder);
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    return this.app.vault.create(normalizePath(`${dir}/Case study.md`), M.EXAMPLE_TEMPLATE);
  }
  async createFromTemplate(file, title, start, parentPath) {
    const pm = this.dotpm();
    if (!pm || typeof pm.store.createProject !== "function" || typeof pm.store.insertTask !== "function") throw new Error("dotpm needs to be enabled to create projects.");
    const rows = M.templateTasks(M.parseTemplate(await this.app.vault.cachedRead(file)), start);
    if (!rows.length) throw new Error("The template has no task table.");
    const parentFolder = parentPath ? parentPath.replace(/\/[^/]+\/[^/]+$/, "") || this.cfg.projectsFolder : null;
    const base = parentFolder || (this.app.vault.getAbstractFileByPath(normalizePath(this.cfg.projectsFolder + "Fall 2026")) ? normalizePath(this.cfg.projectsFolder + "Fall 2026") : this.cfg.projectsFolder.replace(/\/$/, ""));
    const project = await pm.store.createProject(title, base, { icon: "📋", description: `Made from the ${file.basename} template.`, parentPath: parentPath || undefined });
    const ids = {};
    for (const r of rows) ids[r.title.toLowerCase()] = newId();
    for (const r of rows) {
      const desc = r.doneWhen.length ? "## Done when\n" + r.doneWhen.map(d => `- [ ] ${d}`).join("\n") : "";
      const t = this.newTaskObject({ title: r.title, workType: this.cfg.workTypes.find(w => w.toLowerCase() === String(r.workType || "").toLowerCase()) || null,
        estimate: r.hours, start: r.start, due: r.due, description: desc, dependencies: r.after.map(a => ids[a.toLowerCase()]).filter(Boolean) });
      t.id = ids[r.title.toLowerCase()];
      await pm.store.insertTask(project, t, null);
    }
    if (typeof pm.refreshViews === "function") pm.refreshViews();
    new Notice(`Created “${title}” with ${rows.length} tasks.`);
  }

  // ---- schedule change log (one device writes it) ----
  deviceId() {
    let id = null;
    try { id = this.app.loadLocalStorage ? this.app.loadLocalStorage("dpc-device-id") : window.localStorage.getItem("dpc-device-id"); } catch (e) { /* ignore */ }
    if (!id) { id = newId(); try { this.app.saveLocalStorage ? this.app.saveLocalStorage("dpc-device-id", id) : window.localStorage.setItem("dpc-device-id", id); } catch (e) { /* ignore */ } }
    return id;
  }
  // Per-device choice (kept in this device's local storage, not synced): "yes", "no" or unset.
  localLogChoice() { try { return (this.app.loadLocalStorage ? this.app.loadLocalStorage("dpc-log-here") : window.localStorage.getItem("dpc-log-here")) || null; } catch (e) { return null; } }
  setLocalLogChoice(v) { try { this.app.saveLocalStorage ? this.app.saveLocalStorage("dpc-log-here", v) : window.localStorage.setItem("dpc-log-here", v); } catch (e) { /* ignore */ } }
  // This device logs only while it holds the synced claim. A local "no" always wins.
  isLogDevice() { return this.localLogChoice() !== "no" && !!this.settings.logDeviceId && this.settings.logDeviceId === this.deviceId(); }
  async setLogHere(on) {
    this.setLocalLogChoice(on ? "yes" : "no");
    if (on) this.settings.logDeviceId = this.deviceId();          // other devices see the claim and stop
    else if (this.settings.logDeviceId === this.deviceId()) this.settings.logDeviceId = "";
    await this.saveSettings();
  }
  // Only one device writes the logs. A device claims it automatically only if nobody has yet: no device id in
  // the (synced) settings and no log file already in the vault, which would mean another device is logging.
  claimLogDevice(force) {
    const taken = this.settings.logDeviceId || this.app.vault.getAbstractFileByPath(normalizePath(this.settings.scheduleLogFile))
      || this.app.vault.getAbstractFileByPath(normalizePath(this.settings.spilloverFile));
    if (force || (!taken && this.localLogChoice() !== "no" && Platform && Platform.isDesktopApp)) { this.settings.logDeviceId = this.deviceId(); this.saveSettings(); }
  }
  noteReason(path, why) { this.reasons.set(path, { why, at: Date.now() }); }
  trackDates(t) {
    const cur = { start: t.start, due: t.due }, prev = this.dates.get(t.path);
    this.dates.set(t.path, cur);
    if (!prev || this.indexing || !this.settings.scheduleLog || !this.isLogDevice()) return;
    const changes = M.dateChanges(prev, cur);
    if (!changes.length) return;
    const r = this.reasons.get(t.path);
    this.logGroup.push({ task: t, changes, reason: r && Date.now() - r.at < 6000 ? r.why : null });
    clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => this.flushScheduleLog(), 2500);
  }
  async flushScheduleLog() {
    const group = this.logGroup; this.logGroup = []; this.logTimer = null;
    if (!group.length) return;
    const d = new Date(), when = `${M.localToday()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await this.prependTo(this.settings.scheduleLogFile, M.SCHEDULE_HEADER, M.scheduleRows(group, when));
  }
  async prependTo(name, header, rows) {
    const p = normalizePath(name), f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.app.vault.process(f, md => M.prependRows(md, header, rows));
    else await this.app.vault.create(p, M.prependRows("", header, rows));
  }
  // ---- spillover: each Monday, last week's unfinished tasks ----
  async writeSpillover(force) {
    if (!force && !this.isLogDevice()) return;
    const today = M.localToday(), week = M.isoWeek(today);
    if (!force && (this.settings.lastSpilloverWeek === week || this.spilloverBusy)) return;
    // mark the week first, so a second call (plugin reload, another trigger) can't write it again
    this.spilloverBusy = true;
    this.settings.lastSpilloverWeek = week; await this.saveSettings();
    const prevWeek = M.isoWeek(M.addDays(M.mondayOf(today), -7));
    const rows = M.spilloverRows(M.spillover(this.taskList(), this.cfg, M.mondayOf(today)), prevWeek);
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.spilloverFile));
    const existing = f instanceof TFile ? await this.app.vault.read(f) : "";
    if (force || !existing.includes(`| ${prevWeek} |`)) await this.prependTo(this.settings.spilloverFile, M.SPILLOVER_HEADER, rows);
    this.spilloverBusy = false;
    if (force) new Notice(`Wrote ${prevWeek} to ${this.settings.spilloverFile}.`);
  }

  async setMultiplier(key, value) {
    this.settings.multipliers[key] = value;
    this.settings.multiplierHistory = M.recordMultiplier(this.settings.multiplierHistory, M.localToday(), key, value);
    await this.saveSettings();
    this.recompute();
  }
  // ---- quick capacity: one-off changes to a day's hours ----
  // The change is stored in the rules file (so the calendar rebuild keeps it) and applied to Capacity.md now.
  async readRules() {
    const p = normalizePath(this.settings.capacityRulesFile);
    try { if (!(await this.app.vault.adapter.exists(p))) return null; return JSON.parse(await this.app.vault.adapter.read(p)); }
    catch (e) { console.warn("[dotpm-companion] could not read capacity rules", e); return { __error: String(e.message || e) }; }
  }
  async writeRules(rules) {
    const p = normalizePath(this.settings.capacityRulesFile);
    await this.app.vault.adapter.write(p, JSON.stringify(rules, null, 2) + "\n");
  }
  async capacityText() {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.capacityFile));
    return f instanceof TFile ? await this.app.vault.read(f) : null;
  }
  // Everything the preview needs, without writing anything.
  async planCapacity(a) {
    const rules = await this.readRules();
    const md = await this.capacityText();
    const ctx = { rules: rules && !rules.__error ? rules : null, weekly: md ? M.parseCapacity(md) : {}, days: md ? M.parseCapacityDays(md) : {}, fallbackWeekly: this.settings.defaultWeeklyHours };
    const plan = M.planAdjustment(a, ctx);
    const w = this.result && this.result.weeks.find(x => x.week === plan.week);
    plan.load = w ? { adj: w.adj, before: plan.weekBefore > 0 ? w.adj / plan.weekBefore : null, after: plan.weekAfter > 0 ? w.adj / plan.weekAfter : null } : null;
    plan.rulesState = !rules ? "missing" : rules.__error ? "unreadable" : "ok";
    plan.hasFile = md != null;
    plan.inRange = a.date >= this.settings.rangeStart && a.date <= this.settings.rangeEnd;
    return plan;
  }
  async applyCapacity(a) {
    const plan = await this.planCapacity(a);
    if (!plan.hasFile) throw new Error(`${this.settings.capacityFile} not found.`);
    if (plan.rulesState === "unreadable") throw new Error(`Couldn't read ${this.settings.capacityRulesFile}; nothing changed.`);
    if (a.kind === "off" && plan.offAlready) throw new Error(`${M.dayLabel(a.date)} is already a day off.`);
    const added = new Date().toISOString();
    if (plan.rulesState === "ok") await this.writeRules(M.addToRules(await this.readRules(), a, plan.applied, added));
    const note = M.adjustmentNote(a);
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.capacityFile));
    await this.app.vault.process(f, md => M.applyCapacityDelta(md, a.date, plan.applied, note, null).text);
    if (plan.rulesState !== "ok") {
      // no rules file: keep the undo record in settings instead
      (this.settings.capacityLocal = this.settings.capacityLocal || []).push({ ...a, applied: plan.applied, added, note });
      await this.saveSettings();
    }
    await this.logCapacity(a, plan, false);
    await this.loadCapacity(); this.recompute();
    return plan;
  }
  async undoCapacity() {
    const rules = await this.readRules();
    const local = this.settings.capacityLocal || [];
    const r = rules && !rules.__error ? M.removeLastFromRules(rules) : null;
    const rulesAdded = r ? String(((rules.adjustments || []).concat((rules.holidays || []).filter(x => x.by === "quick-capacity"))).map(x => x.added || "").sort().pop()) : "";
    const lastLocal = local.length ? local[local.length - 1] : null;
    let removed;
    if (r && (!lastLocal || rulesAdded >= String(lastLocal.added))) { removed = r.removed; await this.writeRules(r.rules); }
    else if (lastLocal) { removed = lastLocal; local.pop(); this.settings.capacityLocal = local; await this.saveSettings(); }
    else throw new Error("Nothing to undo.");
    const a = { kind: removed.kind, date: removed.date, hours: removed.hours, reason: removed.reason };
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.capacityFile));
    let wb = this.settings.defaultWeeklyHours;
    if (f instanceof TFile) {
      const before = M.parseCapacity(await this.app.vault.read(f))[M.isoWeek(a.date)];
      if (before != null) wb = before;
      await this.app.vault.process(f, t => M.applyCapacityDelta(t, a.date, -removed.applied, null, M.adjustmentNote(a)).text);
    }
    await this.logCapacity(a, { week: M.isoWeek(a.date), applied: -removed.applied, weekBefore: wb, weekAfter: wb - removed.applied }, true);
    await this.loadCapacity(); this.recompute();
    return a;
  }
  async logCapacity(a, plan, undo) {
    if (!this.settings.scheduleLog) return;
    const d = new Date(), when = `${M.localToday()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    try { await this.prependTo(this.settings.scheduleLogFile, M.SCHEDULE_HEADER, [M.capacityLogRow(when, a, plan, undo)]); }
    catch (e) { console.warn("[dotpm-companion] could not log capacity change", e); }
  }
  async createCapacityFile() {
    const p = normalizePath(this.settings.capacityFile);
    if (this.app.vault.getAbstractFileByPath(p)) { new Notice(`${p} already exists.`); return; }
    const f = await this.app.vault.create(p, M.capacityTemplate(this.settings.rangeStart, this.settings.rangeEnd, this.settings.defaultWeeklyHours));
    await this.loadCapacity(); this.recompute();
    this.app.workspace.getLeaf(true).openFile(f);
  }
  // dotpm tab scope: the project chosen in settings, else every project in the vault.
  defaultScope() {
    const p = this.settings.dotpmScope;
    return p && this.projectNotes[p] ? { kind: "project", path: p } : { kind: "vault" };
  }
  // A remembered scope is only reused while its projects still exist.
  validScope(sc) {
    if (!sc || typeof sc !== "object") return null;
    if (sc.kind === "vault") return sc;
    if ((sc.kind === "project" || sc.kind === "subtree") && this.projectNotes[sc.path]) return sc;
    if (sc.kind === "picked" && Array.isArray(sc.paths)) { const ok = sc.paths.filter(x => this.projectNotes[x]); return ok.length ? { kind: "picked", paths: ok } : null; }
    return null;
  }
  async openDotpmInTab() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "pm-project", active: true, state: { scope: this.defaultScope() } });
  }

  // ---- dotpm default sort: due date, then priority ----
  // dotpm starts every view sorted by status. For each scope the companion hasn't seen yet and that is
  // still on dotpm's default, switch it to due → priority once; a sort you pick in dotpm afterwards is kept.
  async applyDotpmDueSort() {
    const pm = this.dotpm();
    if (!this.settings.dotpmDueSort || !pm || !pm.settings || typeof pm.settings.projectFilters !== "object") return;
    const pf = pm.settings.projectFilters;
    const seen = new Set(this.settings.dotpmSortSeen || []);
    const keys = new Set(["vault", ...Object.keys(this.projectNotes).map(k => `project:${k}`), ...Object.keys(pf)]);
    let changed = false;
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const e = pf[key];
      if (!e) {
        pf[key] = { filter: { conditions: [], showArchived: false }, activeSavedViewId: null, sort: M.DUE_SORT.map(x => ({ ...x })), group: { field: "status" },
          fields: structuredClone(pm.settings.defaultFields || {}), ganttGranularity: pm.settings.ganttGranularity || "week", nonWorkingDays: {} };
        changed = true;
      } else if (M.isDefaultSort(e.sort)) { e.sort = M.DUE_SORT.map(x => ({ ...x })); changed = true; }
    }
    this.settings.dotpmSortSeen = [...seen];
    await this.saveSettings();
    if (changed && typeof pm.saveSettings === "function") await pm.saveSettings();
  }

  // ---- default work-type from the project's name (IDSA, Fun, Misc…) ----
  async applyProjectWorkType(path) {
    if (!this.settings.workTypeFromProject || !this.cfg.workTypeFieldId) return;
    const t = this.tasks.get(path);
    if (!t || t.workType) return;
    const wt = this.cfg.workTypes.find(x => x.toLowerCase() === String(t.project || "").toLowerCase());
    if (!wt) return;
    await this.updateTask(path, { customFields: { ...(t.customFields || {}), [this.cfg.workTypeFieldId]: wt } });
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
    new Setting(el).setName("Diagnostics").setDesc(`Version ${p.manifest && p.manifest.version} · ${p.tasks.size} tasks and ${Object.keys(p.projectNotes).length} projects found in ${p.cfg.projectsFolder}`)
      .addButton(b => b.setButtonText("Show").onClick(() => new DiagnosticsModal(p).open()));
    new Setting(el).setName("Capacity file").setDesc("Markdown table with a Week column (2026-W43) and an Available hours column.")
      .addText(t => t.setValue(S.capacityFile).onChange(async v => { S.capacityFile = v.trim() || DEFAULTS.capacityFile; await save(); }));
    new Setting(el).setName("Capacity rules file").setDesc("Rules the calendar rebuild uses. Quick capacity stores its changes here so the next rebuild keeps them.")
      .addText(t => t.setValue(S.capacityRulesFile).onChange(async v => { S.capacityRulesFile = v.trim() || DEFAULTS.capacityRulesFile; await p.saveSettings(); }));
    new Setting(el).setName("Default hours per week").setDesc("Used for any week missing from the capacity file.")
      .addText(t => t.setValue(String(S.defaultWeeklyHours)).onChange(async v => { const n = parseFloat(v); if (n >= 0) { S.defaultWeeklyHours = n; await save(); } }));
    new Setting(el).setName("Planning range").setDesc("First and last day shown in the capacity view (YYYY-MM-DD).")
      .addText(t => t.setPlaceholder("start").setValue(S.rangeStart).onChange(async v => { if (M.isDate(v)) { S.rangeStart = v; await save(); } }))
      .addText(t => t.setPlaceholder("end").setValue(S.rangeEnd).onChange(async v => { if (M.isDate(v)) { S.rangeEnd = v; await save(); } }));
    new Setting(el).setName("Overload threshold").setDesc("Flag a week at this share of available hours (%).")
      .addText(t => t.setValue(String(S.overloadPct)).onChange(async v => { const n = parseFloat(v); if (n > 0) { S.overloadPct = n; await save(); } }));
    new Setting(el).setName("Tight threshold (%)").setDesc("The queue marks a task Tight when its hours left (× multiplier) take at least this share of the hours available before it's due.")
      .addText(t => t.setValue(String(S.tightPct || 50)).onChange(async v => { const n = parseFloat(v); if (n > 0 && n <= 100) { S.tightPct = n; await save(); } }));
    new Setting(el).setName("Progress from Done-when checklist").setDesc("Set each task's progress to the share of ticked boxes under “## Done when”. Overwrites progress set by hand on those tasks.")
      .addToggle(t => t.setValue(S.progressFromChecklist).onChange(async v => { S.progressFromChecklist = v; await save(); }));
    new Setting(el).setName("dotpm tab project").setDesc("What the dotpm tab opens on.")
      .addDropdown(d => {
        d.addOption("", "All projects");
        for (const k of Object.keys(p.projectNotes).sort()) d.addOption(k, p.projectNotes[k].title + (p.projectNotes[k].parent ? "" : " (top level)"));
        d.setValue(S.dotpmScope || "").onChange(async v => { S.dotpmScope = v; S.dotpmState = null; await p.saveSettings(); });
      });
    new Setting(el).setName("Sort dotpm by due date").setDesc("Views dotpm hasn't been given a sort yet start sorted by due date, then priority. A sort you choose in dotpm is kept.")
      .addToggle(t => t.setValue(S.dotpmDueSort).onChange(async v => { S.dotpmDueSort = v; await p.saveSettings(); if (v) await p.applyDotpmDueSort(); }));
    new Setting(el).setName("Work type from project").setDesc("A task without a work type in a project named like a work type (IDSA, Fun, Misc…) gets that work type.")
      .addToggle(t => t.setValue(S.workTypeFromProject).onChange(async v => { S.workTypeFromProject = v; await p.saveSettings(); }));
    new Setting(el).setName("Add times to logs made in dotpm").setDesc("dotpm's time panel saves only the date and hours. When you add a log there, the companion sets its end to when it noticed the log and its start that many hours earlier, so the Time tab can place it in the day. Only the computer you're using does this.")
      .addToggle(t => t.setValue(S.stampDotpmLogs).onChange(async v => { S.stampDotpmLogs = v; await p.saveSettings(); }));
    new Setting(el).setName("Quick-add default project").setDesc("Where a quick-added task goes when the line names no project.")
      .addDropdown(d => { for (const k of Object.keys(p.projectNotes).sort()) d.addOption(p.projectNotes[k].title, p.projectNotes[k].title); d.setValue(S.quickAddProject).onChange(async v => { S.quickAddProject = v; await p.saveSettings(); }); });
    new Setting(el).setName("Templates folder").setDesc("Notes with a task table, used by “New project from template”.")
      .addText(t => t.setValue(S.templatesFolder).onChange(async v => { S.templatesFolder = v.trim() || DEFAULTS.templatesFolder; await p.saveSettings(); }));
    new Setting(el).setName("Schedule log").setDesc(`Record every start/due change in “${S.scheduleLogFile}”, and last week's unfinished tasks in “${S.spilloverFile}” each Monday.`)
      .addToggle(t => t.setValue(S.scheduleLog).onChange(async v => { S.scheduleLog = v; await p.saveSettings(); }));
    new Setting(el).setName("Write the logs from this device")
      .setDesc(p.isLogDevice() ? "On: this device writes the logs. Turn it on in one place only (your main computer), so Sync doesn't double them."
        : p.settings.logDeviceId ? "Off: another device writes the logs." : "Off: no device writes the logs yet. Turn this on for your main computer.")
      .addToggle(t => t.setValue(p.isLogDevice()).onChange(async v => { await p.setLogHere(v); this.display(); }));
    new Setting(el).setName("Open on startup").setDesc("Open the companion on the dotpm tab when Obsidian starts.")
      .addToggle(t => t.setValue(S.openOnStartup).onChange(async v => { S.openOnStartup = v; await p.saveSettings(); }));
    new Setting(el).setName("Multipliers").setHeading();
    for (const k of V.typeKeys(p.cfg)) {
      new Setting(el).setName(V.typeName(k, p.cfg)).addText(t => t.setValue(String(M.multiplierFor(S.multipliers, k))).onChange(v => {
        const n = parseFloat(v); if (isFinite(n) && n > 0) p.setMultiplier(k, Math.round(n * 100) / 100);
      }));
    }
  }
}
module.exports.CompanionView = CompanionView;

function newId() { return Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join(""); }

class TaskSuggestModal extends FuzzySuggestModal {
  constructor(plugin, onPick) { super(plugin.app); this.plugin = plugin; this.onPick = onPick; this.setPlaceholder("Log time on which task?"); }
  getItems() {
    const R = this.plugin.result, cfg = this.plugin.cfg;
    const open = this.plugin.taskList().filter(t => !M.isComplete(cfg, t.status));
    const q = R ? R.queue : [];
    return q.concat(open.filter(t => !q.includes(t)));
  }
  getItemText(t) { return `${t.title} — ${t.project}`; }
  onChooseItem(t) { this.onPick(t); }
}
class FileSuggestModal extends FuzzySuggestModal {
  constructor(plugin, files, onPick) { super(plugin.app); this.files = files; this.onPick = onPick; this.setPlaceholder("Choose a template"); }
  getItems() { return this.files; }
  getItemText(f) { return f.basename; }
  onChooseItem(f) { this.onPick(f); }
}
class LogTimeModal extends Modal {
  constructor(plugin, task) { super(plugin.app); this.plugin = plugin; this.task = task; }
  onOpen() {
    const { contentEl: el } = this, t = this.task;
    el.addClass("dpc-modal");
    el.createEl("h3", { text: "Log time" });
    el.createDiv({ cls: "dpc-muted", text: `${t.title} · ${t.project} · ${t.logged}/${t.estimate == null ? "?" : t.estimate}h so far` });
    const input = el.createEl("input", { type: "text", cls: "dpc-modal-input", attr: { placeholder: "1.5h, 2-3:30pm, or 2h at 10am — optional note after", "aria-label": "Time spent" } });
    const idle = "Ends now unless you give a time: “2-3:30pm”, “14:00-15:30” or “1.5h at 10am”. Enter to save.";
    const hint = el.createDiv({ cls: "dpc-muted dpc-modal-hint", text: idle });
    const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
    const go = async () => {
      const v = M.parseLogInput(input.value, nowMin());
      if (!v) { hint.setText("Couldn't read that. Try “2h”, “45m”, “2-3:30pm” or “1h30m at 10am fixed the hinge”."); return; }
      this.close(); await this.plugin.logTime(t.path, v);
    };
    input.addEventListener("input", () => { const v = M.parseLogInput(input.value, nowMin()); hint.setText(v ? `${M.describeLog(v)}. Enter to save.` : idle); });
    const recent = (t.logs || []).slice(-3).reverse();
    if (recent.length) el.createDiv({ cls: "dpc-muted dpc-modal-hint", text: "Recent: " + recent.map(l => `${l.date ? l.date.slice(5) : "?"}${l.start ? ` ${l.start}–${l.end}` : ""} ${l.hours}h`).join(" · ") });
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    setTimeout(() => input.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}
class QuickAddModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const p = this.plugin, { contentEl: el } = this;
    el.addClass("dpc-modal");
    el.createEl("h3", { text: "Quick add" });
    const input = el.createEl("input", { type: "text", cls: "dpc-modal-input", attr: { placeholder: "render toaster hero shot fri 3h p1 #cad", "aria-label": "New task" } });
    const prev = el.createDiv({ cls: "dpc-qa-preview" });
    el.createDiv({ cls: "dpc-muted dpc-modal-hint", text: "Project by name or @name · fri, nov 9, 12/5, +3d · 3h or 90m · p1–p4 · #worktype or #tag · Enter to add" });
    const parse = () => M.parseQuickAdd(input.value, { today: M.localToday(), projects: Object.values(p.projectNotes).map(x => x.title), workTypes: p.cfg.workTypes, priorities: p.cfg.priorities.map(x => x.id) });
    const show = () => {
      const q = parse(); prev.empty();
      const proj = q.project || p.settings.quickAddProject;
      const chip = (k, v, muted) => prev.createSpan({ cls: "dpc-qa-chip" + (muted ? " is-default" : ""), text: `${k}: ${v}` });
      chip("Task", q.title || "—"); chip("Project", proj || "—", !q.project); chip("Due", q.due || "—", !q.due);
      chip("Estimate", q.estimate != null ? `${q.estimate}h` : "—", q.estimate == null);
      chip("Priority", q.priority ? M.label(p.cfg.priorities, q.priority) : "Medium", !q.priority);
      chip("Work type", q.workType || (p.cfg.workTypes.find(w => w.toLowerCase() === String(proj).toLowerCase()) || "—"), !q.workType);
      if (q.tags.length) chip("Tags", q.tags.join(", "));
    };
    input.addEventListener("input", show); show();
    input.addEventListener("keydown", async e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = parse();
      if (!q.title) return;
      const proj = q.project || p.settings.quickAddProject;
      try { await p.createTask(proj, q); new Notice(`Added “${q.title}” to ${proj}.`); this.close(); }
      catch (err) { new Notice(String(err.message || err)); }
    });
    setTimeout(() => input.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}
class QuickCapacityModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.seq = 0; }
  onOpen() {
    const p = this.plugin, { contentEl: el } = this;
    el.addClass("dpc-modal");
    el.createEl("h3", { text: "Quick capacity" });
    const input = el.createEl("input", { type: "text", cls: "dpc-modal-input", attr: { placeholder: "-1.5 sleep · -3 thu dentist · +2 sat crunch · off fri sick · undo", "aria-label": "Capacity change" } });
    const prev = el.createDiv({ cls: "dpc-qa-preview" });
    const warn = el.createDiv({ cls: "dpc-muted dpc-modal-hint" });
    el.createDiv({ cls: "dpc-muted dpc-modal-hint", text: "−/+ hours (1.5, 45m, 1h30m) · day: today, tomorrow, yesterday, thu, nov 9, 11/9 (default today) · off = whole day · undo = last change · Enter to apply" });
    const pct = v => v == null || !isFinite(v) ? "—" : `${Math.round(v * 100)} %`;
    const h = v => `${Math.round(v * 100) / 100} h`;
    const show = async () => {
      const seq = ++this.seq, a = M.parseCapacityInput(input.value, M.localToday());
      prev.empty(); warn.setText("");
      if (!input.value.trim()) return;
      if (!a) { warn.setText("Start with a change like “-2”, “+1.5h”, “-45m”, “off” or “undo”."); return; }
      const chip = (k, v, muted) => prev.createSpan({ cls: "dpc-qa-chip" + (muted ? " is-default" : ""), text: `${k}: ${v}` });
      if (a.kind === "undo") { chip("Undo", "the last Quick capacity change"); return; }
      const plan = await p.planCapacity(a);
      if (seq !== this.seq) return;
      chip("Day", M.dayLabel(a.date));
      chip("That day", `${h(plan.dayBefore)} → ${h(plan.dayAfter)}${plan.estimated ? " (est.)" : ""}`);
      chip(plan.week, `${h(plan.weekBefore)} → ${h(plan.weekAfter)}`);
      if (plan.load) chip("Load", `${pct(plan.load.before)} → ${pct(plan.load.after)}`, !(plan.load.after >= (p.settings.overloadPct || 85) / 100));
      if (a.reason) chip("Why", a.reason);
      const notes = [];
      if (plan.clamped) notes.push(`A day holds 0–${plan.usable} h, so only ${plan.applied > 0 ? "+" : ""}${plan.applied} h applies.`);
      if (plan.offAlready) notes.push("That day is already off.");
      if (!plan.inRange) notes.push("Outside the planning range.");
      if (plan.estimated) notes.push(`${p.settings.capacityFile} has no Days table yet (it appears after the next calendar rebuild), so the day is estimated as a seventh of the week.`);
      if (plan.rulesState === "missing") notes.push(`${p.settings.capacityRulesFile} not found: the change goes into ${p.settings.capacityFile} only, and the next calendar rebuild will drop it.`);
      if (plan.rulesState === "unreadable") notes.push(`${p.settings.capacityRulesFile} can't be read, so nothing will be changed.`);
      if (!plan.hasFile) notes.push(`${p.settings.capacityFile} not found.`);
      warn.setText(notes.join(" "));
    };
    input.addEventListener("input", () => { show(); });
    input.addEventListener("keydown", async e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const a = M.parseCapacityInput(input.value, M.localToday());
      if (!a) return;
      try {
        if (a.kind === "undo") {
          const u = await p.undoCapacity();
          new Notice(`Undid ${M.adjustmentNote(u)}.`); this.close(); return;
        }
        const plan = await p.applyCapacity(a);
        const w = p.result && p.result.weeks.find(x => x.week === plan.week);
        const over = w && w.overloaded;
        new Notice(`${M.dayLabel(a.date)}: ${h(plan.dayBefore)} → ${h(plan.dayAfter)} · ${plan.week} now ${h(plan.weekAfter)}` +
          (w ? ` · load ${pct(w.pct)}` : "") + (over ? ` — over ${p.settings.overloadPct || 85} %, ask Claude to re-plan this week.` : "."), over ? 10000 : 5000);
        this.close();
      } catch (err) { new Notice(String(err.message || err)); }
    });
    setTimeout(() => input.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}
class TemplateModal extends Modal {
  constructor(plugin, file) { super(plugin.app); this.plugin = plugin; this.file = file; }
  onOpen() {
    const p = this.plugin, { contentEl: el } = this;
    el.addClass("dpc-modal");
    el.createEl("h3", { text: `New project from “${this.file.basename}”` });
    let title = "", start = M.localToday(), parent = "";
    new Setting(el).setName("Project name").addText(t => { t.setPlaceholder("e.g. Toaster case study").onChange(v => { title = v.trim(); }); setTimeout(() => t.inputEl.focus(), 0); });
    new Setting(el).setName("Start date").addText(t => t.setValue(start).onChange(v => { start = v.trim(); }));
    new Setting(el).setName("Inside project").addDropdown(d => {
      d.addOption("", "— top level —");
      for (const k of Object.keys(p.projectNotes).sort()) d.addOption(k, p.projectNotes[k].title);
      d.onChange(v => { parent = v; });
    });
    new Setting(el).addButton(b => b.setButtonText("Create").setCta().onClick(async () => {
      if (!title) { new Notice("Give the project a name."); return; }
      if (!M.isDate(start)) { new Notice("Start date must look like 2026-11-02."); return; }
      try { await p.createFromTemplate(this.file, title, start, parent || null); this.close(); } catch (err) { new Notice(String(err.message || err)); }
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class DiagnosticsModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const p = this.plugin, el = this.contentEl, ts = p.taskList();
    el.addClass("dpc-modal");
    el.createEl("h3", { text: "dotpm Companion diagnostics" });
    const caps = Object.keys(p.capacity || {}).length;
    const rows = [
      ["Version", p.manifest && p.manifest.version],
      ["Device", Platform && Platform.isMacOS ? "Mac" : Platform && Platform.isWin ? "Windows" : Platform && Platform.isMobile ? "Mobile" : "Other"],
      ["dotpm plugin loaded", p.dotpm() ? "yes" : "NO — enable dotpm"],
      ["dotpm settings", p.diag.dotpmConfig],
      ["Projects folder", p.cfg.projectsFolder],
      ["Markdown files in it", String(p.diag.files)],
      ["Projects found", String(Object.keys(p.projectNotes).length)],
      ["Tasks found", String(ts.length)],
      ["…with an estimate / a due date", `${ts.filter(t => t.estimate > 0).length} / ${ts.filter(t => t.due).length}`],
      ["…read from the file (cache not ready)", String(p.diag.fromFile)],
      ["Work-type field", p.cfg.workTypeFieldId ? `${p.cfg.workTypeFieldId} (${p.cfg.workTypes.length} options)` : "not found"],
      ["Tasks using that field id", (() => { const n = ts.filter(t => t.customFields && p.cfg.workTypeFieldId in t.customFields).length; const k = new Set(ts.flatMap(t => Object.keys(t.customFields || {}))); return `${n} of ${ts.length}${n < ts.length && k.size ? ` (tasks use: ${[...k].join(", ")})` : ""}`; })()],
      ["Open tasks / remaining hours", `${ts.filter(t => !M.isComplete(p.cfg, t.status)).length} / ${Math.round(ts.filter(t => !M.isComplete(p.cfg, t.status)).reduce((a, t) => a + M.remaining(t), 0))}h`],
      ["Hours in planning range", p.result ? `${Math.round(p.result.weeks.reduce((a, w) => a + w.raw, 0))}h raw` : "not computed"],
      ["Capacity weeks read", `${caps} from ${p.settings.capacityFile}`],
      ["Planning range", `${p.settings.rangeStart} → ${p.settings.rangeEnd}`],
      ["Last read", p.diag.lastIndex || "never"],
      ["Logs written here", p.isLogDevice() ? "yes" : "no"],
    ];
    const tbl = el.createEl("table", { cls: "dpc-table" });
    for (const [k, v] of rows) { const tr = tbl.createEl("tr"); tr.createEl("td", { text: k }); tr.createEl("td", { text: String(v) }); }
    const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
    new Setting(el).addButton(b => b.setButtonText("Copy").onClick(() => { navigator.clipboard.writeText(text); new Notice("Copied diagnostics."); }))
      .addButton(b => b.setButtonText("Re-read all tasks").setCta().onClick(async () => { await p.reloadDotpmConfig(); await p.rebuildIndex(); this.close(); new DiagnosticsModal(p).open(); }));
  }
  onClose() { this.contentEl.empty(); }
}
