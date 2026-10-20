# dotpm Companion

An Obsidian plugin that sits beside [dotpm](https://dotpm.pm) and adds cross-project planning views. It reads dotpm's Markdown task files as the only source of truth and never renames, moves or re-IDs them.

## Views (0.2.0)

- **All tasks** (opens on startup): every task in the vault on one screen, grouped by project, with status and priority you can change in place, a filter box and a show-done toggle. Clicking a task opens dotpm's task editor.

- **Capacity**: committed hours per ISO week against available hours from `Capacity.md`, raw and × multipliers; weeks at 85 % or more are flagged. Remaining hours (estimate − logged) are spread evenly from max(start, today) to due; overdue work lands today.
- **At risk**: a task whose remaining hours × multiplier exceed the hours available between today and its due date.
- **Queue**: open tasks ranked by priority, then due date, then remaining hours; future starts listed under "Starting later". ✓ marks a task done.
- **Work types**: stacked hours per week by `work-type`, with the available-hours line and a table view.
- **Multipliers**: one per work-type (default 2.0×), with a change history and trend chart; shows the measured factor (logged ÷ estimate over done tasks) once there is data.
- **Progress from checklist**: progress = ticked share of the `## Done when` checklist, set through dotpm's own store so dotpm's views update at once.

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
