# Guide for AI agents working on dotpm Companion

Read this before changing code. User-facing setup is in [docs/SETUP.md](docs/SETUP.md).

## What this is

An Obsidian plugin that sits beside **dotpm** (`project-manager`) and adds planning views across all
projects. dotpm owns the data (Markdown notes with frontmatter); the companion reads it and writes back
**through dotpm's own in-memory store** whenever possible.

## Layout

| Path | Role |
| --- | --- |
| `src/model.js` | Pure logic, no Obsidian imports: date helpers, dotpm config, task parsing, capacity/spread/at-risk, queue, board, multipliers + history + measured series, project stats, quick-add and time-log parsing, schedule/spillover rows, templates, file fallbacks. Unit-tested. |
| `src/views.js` | Plain-DOM rendering of every tab (`render(root, state, handlers)`). No Obsidian helpers, so it renders in a browser for tests. |
| `src/main.js` | Obsidian glue: plugin class, `CompanionView` (an `ItemView`), dotpm bridge, indexing, commands, modals, settings tab, logs. |
| `styles.css` | All styles, scoped under `.dpc-root` / `.dpc-*`; colors via Obsidian CSS variables and `--dpc-s1…s9`. |
| `build.js` | Dependency-free bundler: wraps `src/*.js` into one CommonJS `main.js`. **`main.js` is generated — edit `src/`.** |
| `test/*.test.js` | `node --test`. `fixture/vault.json` is sample data shaped like a real vault. `embed.test.js` fakes dotpm's view; `bridge.test.js` fakes dotpm's store. |
| `test/render.js` + `test/shots.py` | Build `test/build/render.html` and screenshot tabs with Playwright (Chromium at `/opt/pw-browsers/...` in Claude's sandbox). |
| `.github/workflows/release.yml` | On push to `main`: build, test, and if `manifest.json`'s version has no release yet, publish one with `main.js`, `manifest.json`, `styles.css`. |

## Commands

```bash
node build.js                 # bundle src/ → main.js
node --test test/*.test.js    # all tests (must pass before a release)
node test/render.js && python3 test/shots.py <outdir>   # visual check
```

No npm dependencies (the sandbox couldn't reach the registry); keep it that way.

## Releasing

1. Bump `version` in `manifest.json` and `package.json`, add it to `versions.json` (`"x.y.z": "1.13.0"`).
2. `node build.js && node --test test/*.test.js`.
3. Commit (including the built `main.js`) and push to `main`. The workflow publishes the release; BRAT installs it.
Tags can't be pushed from Claude sessions and releases can't be created directly, which is why releases are
cut by the workflow.

## dotpm internals used (not a public API — guard every call)

`app.plugins.plugins["project-manager"]` (`pm`):

| Use | Call |
| --- | --- |
| Find a task's project | `pm.index.task(taskId) → { projectPath }` |
| Load a project | `await pm.store.loadProjectByPath(path)` |
| Update a task | `await pm.store.updateTask(project, taskId, patch)` — patch is merged with `Object.assign` (`status`, `priority`, `start`, `due`, `progress`, `timeLogs`, `customFields` (whole object), …). After `start/due/status/dependencies/type` changes call `pm.store.scheduleAfterChange(project, taskId)`. |
| Create a task | `await pm.store.insertTask(project, taskObject, null)`; task shape mirrors dotpm's `Zu()` factory (see `newTaskObject` in `src/main.js`). |
| Create a project | `await pm.store.createProject(title, folder, { icon, color, description, parentPath })` → project |
| Redraw dotpm | `pm.refreshViews()` |
| Open dotpm's task editor | `pm.router.openTask({ filePath })` |
| Default sort per view | `pm.settings.projectFilters[scopeKey].sort` (scope keys: `vault`, `project:<path>`, `picked:<sorted paths joined by \|>`), then `pm.saveSettings()`. Sortable keys: `title,status,priority,due,assignees,progress`; priority sorts by list index. |
| Host dotpm's view | `app.viewRegistry.viewByType["pm-project"](leaf)` with a stand-in leaf (`Object.create(realLeaf)`) whose `setViewState` routes `pm-project` state back into the hosted view and opens other types in a new tab. State: `{ scope: { kind: "vault" } }` or `{ scope: { kind: "project", path } }`. |

If any of these is missing or throws, `updateTask` falls back to a one-line frontmatter edit
(`setFrontmatterLines`) and the progress writer waits 6 s, because **dotpm ignores outside edits to a file
for 5 s after it saves that file itself** (`SELF_WRITE_WINDOW_MS`). Writing files directly while dotpm has a
task in memory otherwise leaves dotpm showing stale values until it reloads.

## Invariants

- Never rename, move or re-ID dotpm files. Write only fields dotpm defines.
- Every write goes through `updateTask` (one save path).
- Dates are `YYYY-MM-DD` strings; YAML may give unquoted dates or `Date` objects → always `normDate`.
- Work types come from dotpm's `work-type` field options; values no longer in the list are shown as extra types.
- Colors: categorical slots follow the work-type option order (validated palette, 9th = neutral gray).
- Logs are written by one device (`settings.logDeviceId` vs a per-device id in local storage).
- Undo state (`settings.undo`, `settings.pulled`) only lives for the day it was made.

## Gotchas met so far

- dotpm rewrites task files on save (slug file names, unquoted YAML). Match by `id`/`title`, not file name.
- `metadataCache.on("changed")` fires for the companion's own writes; writers must be idempotent.
- On a freshly synced device the metadata cache can be empty at startup: `indexFile` falls back to parsing the frontmatter from the file text, and the index is rebuilt on `metadataCache.on("resolved")`.
- `test/render.js` builds HTML inside a template literal — no backticks in code you inject there.
- Windows: folders created by another process can need `takeown`/`icacls` before deletion.
