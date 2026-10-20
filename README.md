# dotpm Companion

An Obsidian plugin that sits beside [dotpm](https://dotpm.pm) and adds cross-project planning views. It reads dotpm's Markdown task files as the only source of truth and never renames, moves or re-IDs them.

## Tabs (0.5.0)

- **dotpm** (opens on startup): dotpm's own project view — its table, Gantt and Kanban, filters and editor — hosted inside the companion, opened on all projects (dotpm's vault scope; pick one project in settings instead), so every task shows without the project menu. When dotpm switches scope it stays in this tab; other dotpm screens (overview, task editor) open in their own tab. If dotpm can't be hosted, an *Open dotpm* button opens it normally.
- **Board**
  - *Today* (micro): open tasks that have started, ranked by priority, then due date, then remaining hours. ✓ marks done; *Done today* keeps Undo until midnight; *Find more tasks* suggests ready tasks (dependencies done) and *Start now* pulls one in, with *Undo add*.
  - *By week* (macro): a column per week; each card sits in the week it's due, in queue order, with committed vs available hours on the column. Drag or *Move…* shifts start and due by whole weeks.
- **Capacity**: committed hours per ISO week against `Capacity.md`, raw and × multipliers; weeks at 85 % or more flagged; at-risk tasks listed. Remaining hours are spread evenly from max(start, today) to due; overdue work lands today.
- **Work types**: stacked hours per week by `work-type`, with the available-hours line and a table.
- **Multipliers**: one per work-type (default 2.0×), change history and trend chart, with the measured factor (cumulative logged ÷ estimate of done tasks, by completion date) as a dashed line beside it.
- **Progress from checklist**: progress = ticked share of the `## Done when` checklist.
- **dotpm default sort**: any dotpm view still on dotpm's default (status) is switched once to due date, then priority. A sort you pick in dotpm afterwards is kept.
- **Work type from project**: a task without a work type in a project named like a work type (IDSA, Fun, Misc…) gets that work type.
- Work types that are on tasks but no longer in dotpm's list stay visible, marked "not in dotpm's list".

## How it writes

Changes (progress, status, priority) go through dotpm's own store (`store.updateTask`, then `refreshViews`), so dotpm saves the file, reschedules dependents and redraws. That is an internal dotpm API; if it is missing or fails, the companion edits the one frontmatter line instead and waits 6 s so dotpm's self-write guard doesn't hide the change.

Other files it writes:
- `Capacity.md` only when you run *Create capacity file*
- its own settings (multipliers and history) in `.obsidian/plugins/dotpm-companion/data.json`

## Capacity.md

```
| Week | Starts | Available hours | Notes |
| --- | --- | --- | --- |
| 2026-W43 | 2026-10-19 | 40 | |
```

Weeks missing from the table use the default hours per week from settings.

## Development

No dependencies. `node build.js` bundles `src/` into `main.js`; `node --test test/*.test.js` runs the calculation tests against a snapshot of a real vault.
