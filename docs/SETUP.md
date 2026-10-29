# dotpm Companion — setup guide

This guide is written so that a person **or an AI assistant** can set up a vault for the
dotpm Companion from scratch, or check an existing one, without other context.
Everything here matches version 0.6.x of the plugin.

- Plugin id: `dotpm-companion` · repo: `OrangeXpl02ion/dotpm-companion`
- Works on desktop and mobile (no Node APIs). Obsidian **1.13.0+**.
- Requires the community plugin **dotpm** (plugin id `project-manager`, tested with 2.6.0).

---

## 1. Install

1. Install and enable **dotpm** from Obsidian's community plugin store.
2. Install and enable **BRAT** (`obsidian42-brat`) from the store.
3. BRAT settings → **Add beta plugin** → `OrangeXpl02ion/dotpm-companion` → keep "latest" → enable auto-update.
   The repo is public, so no GitHub token is needed.
4. Settings → Community plugins → enable **dotpm Companion**.
5. Open it from the gauge icon in the ribbon or the command **dotpm Companion: Open view**.
   It also opens on startup (setting *Open on startup*).

**Updates:** BRAT checks at startup. To update now: command *BRAT: Check for updates to all beta plugins and UPDATE*,
then turn the companion off and on (or *Reload app without saving*).

**Manual install (no BRAT):** copy `main.js`, `manifest.json`, `styles.css` from the latest
[release](https://github.com/OrangeXpl02ion/dotpm-companion/releases) into `<vault>/.obsidian/plugins/dotpm-companion/`.

**Obsidian Sync:** turn on *Installed community plugins* and *Community plugin settings* on every device
(these toggles are per device). The companion's settings, multipliers and history travel with plugin settings.

---

## 2. Vault conventions the companion relies on

The companion reads dotpm's own files. It never renames, moves or re-IDs them.

| Thing | Where / format |
| --- | --- |
| Projects folder | dotpm setting *Projects folder* (stored as `projectsFolder` in `.obsidian/plugins/project-manager/data.json`, e.g. `Project/`). Everything under it is scanned except `Archive/` folders. |
| Project note | `<folder>/<Title>/<Title>.md` with frontmatter `pm-project: true`, `id`, `title`, `color`, `icon`, `taskIds`, optional `parent: "[[Project/…/Parent/Parent]]"` (vault path without `.md`). A sub-project's folder normally sits inside its parent's folder, but dotpm goes by `parent`, not by the folder. |
| Task note | `<project folder>/_tasks/<name>.md` with frontmatter `pm-task: true`, `projectId: "[[Title\|Title]]"`, `id` (16 chars), `title`, `type` (`task` · `milestone` · `subtask`), `status`, `priority`, `start`, `due` (`YYYY-MM-DD`, may be unquoted or `""`), `progress` (0–100), `dependencies` (wikilinks to task notes), optional `timeEstimate` (hours), `timeLogs` (list of `{date, hours, note}`), `completed` (date), `customFields` (`{<fieldId>: value}`). |
| Work type | A dotpm **vault-level custom field** named exactly `work-type`, type *select*. Its option order sets the companion's colors. Tasks store it under `customFields.<fieldId>`. |
| Statuses / priorities | dotpm's lists. A status with `complete: true` counts as done (default ids: `todo`, `in-progress`, `blocked`, `review`, `done`, `cancelled`). Priority order is list order (default `critical`, `high`, `medium`, `low`). |
| Done when | A `## Done when` heading in the task body followed by `- [ ]` / `- [x]` items. Progress = ticked share; a task marked done is set to 100 % whatever is ticked (0.12.0). |
| Capacity | `Capacity.md` at the vault root (see §4). |

Minimal task body:

```markdown
## Done when
- [ ] Hero render final
- [ ] Exported at full resolution

Project: [[Toaster|Toaster]]
```

To create projects and tasks **by writing files** (e.g. an assistant with file access): close Obsidian
first, follow the formats above, give every task a unique 16-character `id` (`[a-z0-9]`), and list the
tasks in the project's `taskIds` as `"[[note-name|Title]]"`. dotpm will rename task files to slugs and
re-quote YAML on its next save; that is expected. Inside Obsidian, prefer the companion's *Quick add task*
and *New project from template* commands, which go through dotpm itself.

---

## 3. Tabs

| Tab | What it shows |
| --- | --- |
| **dotpm** | dotpm's own project view (table, Gantt, Kanban, filters, task editor) hosted inside the companion, on **all projects** by default (dotpm's "vault" scope). Pick one project instead in settings. If hosting fails, an *Open dotpm* button opens it normally. |
| **Tasks → Today** (was Board) | Next 7 days of committed hours (bars split by work type; dashed line = that day's available hours; hover for the tasks), then started tasks (status In Progress or In Review, even if the planned start is later, or start date reached), each showing a status pill, ranked by urgency tier first — **Now** (overdue, due today or tomorrow, or fewer hours available before the due date than it needs), **Tight** (needs at least 50 % of those hours; setting *Tight threshold*), then the rest — then **slack**, smallest first, then priority → due → hours left. Slack = hours available from now to the due date (each day from the Days table in Capacity.md, and only what's left of today's work window) − hours left × multiplier − hours left on unfinished tasks it waits on. A task takes the tier and slack of any open task waiting on it. The same order is used on the Board (both modes), *Starting later*, *At risk* and the Projects task lists, and each shows the slack. The *Why* column gives the reason (e.g. `Now · Due tomorrow`, `Tight · 4h slack`, `Unblocks …`). Hours left are estimate × multiplier − logged; a task whose logged time has reached estimate × multiplier shows *Over budget*. Per task: `+h` log time, *Not today* (move to tomorrow, undo), ✓ done (asks twice if Done-when boxes are unticked). *Done today* (undo until midnight), *Moved to tomorrow*, *Find more tasks* → *Start now* (undo): ready tasks needed by Sunday (due this week, or something due this week waits on them) come first under *Needed this week*, then least slack. |
| **Tasks → By week** | A column per week; each card sits in the week it's due, in queue order, with committed vs available hours. Drag or *Move…* shifts start and due by whole weeks. |
| **Projects** | A card per project like dotpm's overview: progress vs plan, tasks done, overdue, time logged/estimate, milestones, and a Tasks dropdown. Sub-projects nest and roll up. Behind/at-risk first. |
| **Capacity** | Weekly committed hours (raw and × multipliers) vs `Capacity.md`; overloaded weeks; at-risk tasks; tasks waiting on an overdue task; last week's spillover. |
| **Time** | Where logged time went. **Day** (opens on today; ‹ › and *Today* to move): total worked, available hours (Capacity.md Days table) and the share used, minutes worked in each hour of the work window (from each log's `start`/`end`, coloured by work type; logs without times count in the total only), and a *now* line. **Week** (Mon–Sun): a bar per day over that day's available hours, the daily average over the days so far (dashed line); click a day to open it. Then **Where the time went** (by work type or project) and **Time by task**: every task with time logged in the period, most time first, with a bar of time logged — this period solid, earlier faded, over-budget hatched — against estimate × multiplier (the tick), plus the period's sessions and notes. Day/Week and the grouping are remembered. dotpm's time panel saves only a date and hours; the companion adds `start`/`end` to a log made there (end = when it noticed the log, start = that many hours earlier), on the computer you were using in the last 2 minutes only and once the panel has been quiet for 15 s, with a notice showing the times. Setting *Add times to logs made in dotpm*. |
| **Week projection** (was Work types) | Each week of the planning range as a pair of bars — projected (light, left) and logged (solid, right) — split by work type or top-level project; *Side by side*, *Projected* or *Actual*. The projection is the plan frozen the first time the companion runs in a week (hours logged earlier that week + hours committed from then on, saved in `weekPlans`); a week still ahead shows the current committed hours; a past week with no frozen plan is rebuilt from task dates (estimate × the multiplier then, spread over start–due). Click a week (or ‹ ›) for its breakdown: planned, logged, available, difference (pace for the current week), projected vs actual per type or project, the tasks that took the most time against what was planned for them that week, and planned tasks that got no time. *Days in Time →* opens the week in Time. |
| **Multipliers** | One multiplier per work type (default 2.0×), change history, trend chart with the measured factor (logged ÷ estimate of done tasks) as dashed lines. |

### How the numbers are computed

- **Hours left** = `timeEstimate × multiplier − sum(timeLogs.hours)`, never below 0 (raw estimates mode: `timeEstimate − sum(timeLogs.hours)`).
- **Spread rule**: remaining hours are spread evenly over each day from `max(start, today)` to `due`; overdue work lands on today; tasks without a due date are listed as unscheduled.
- **× multipliers**: remaining hours × the task's work-type multiplier (no work type → its own multiplier).
- **Overloaded week**: committed (× multipliers) ≥ *Overload threshold* (default 85 %) of available.
- **At risk**: remaining × multiplier > hours available from today to the due date (weekly capacity ÷ 7 per day).
- **Project progress**: average task completion weighted by estimate (done = 100 %, otherwise `progress`). **Planned** = share of each task's start→due window already passed, same weights. Health: *Behind* if anything is overdue or actual is >25 points under plan; *Watch* if something is at risk or >10 points under; else *On track*.

---

## 4. Capacity.md

```markdown
| Week | Starts | Available hours | Busy in calendar | Notes |
| --- | --- | --- | --- | --- |
| 2026-W43 | 2026-10-19 | 58 | 22.0 | |
```

Rules: the companion reads the first column whose header contains "week" (`2026-W43` or a date in that
week) and the first whose header contains "available" or "hours". Other columns are ignored. Weeks missing
from the table use *Default hours per week*. *Create capacity file* writes a blank table for the planning range.

**Filling it from Google Calendar:** `tools/capacity_from_calendar.py <rules.json> <events.json> <Capacity.md>`
rebuilds the file from calendar events. Rules (`tools/capacity-rules.example.json`; the vault copy lives at
`Claude/capacity-rules.json`): a usable window per day (weekdays 9:00–23:00, weekends 10:00–22:00), 2 h for meals,
**every timed event you've accepted or created is subtracted** (classes, meetings, personal and professional events,
clipped to the window, overlaps counted once), **classes listed in `workTimeClasses` stay as work time**, **1 h of
travel** comes off each day with an in-person event, regular **chores** (e.g. 20 min laundry on Sundays) come off their days, holidays are days off, and all-day items, free events and
unaccepted invites are ignored. A scheduled Claude task re-runs it three times a day.

The script also writes a **Days** table (one row per day: available hours, usable hours, adjustments) below the
weekly table; the companion uses it only to preview *Quick capacity* changes and never for the weekly numbers.

**One-off changes (*Quick capacity*):** don't edit the numbers by hand — the next rebuild overwrites them. The
*Quick capacity* command stores each change in the rules file's `adjustments` list
(`{"date": "2026-10-22", "hours": -3, "reason": "dentist"}`), or a day off in `holidays`, and changes
`Capacity.md` at once (Available hours, *Adjusted*, *Notes*, and the day's row). The script applies adjustments after
everything else, so the next rebuild gives the same number. A day stays between 0 and its usable hours
(window − meals: 12 h weekdays, 10 h weekends with the default rules). Sleep isn't counted inside the window, so log
it only when it eats into the window (a late start, a nap). The rules file is JSON: for changes made on the Mac or
laptop to reach the desktop that runs the rebuild, Obsidian Sync needs *Sync all other types* on.

---

## 5. Commands

| Command | Use |
| --- | --- |
| Open view / Open dotpm tab / Open today's queue / Open project progress / Open time spent | Jump to a tab. |
| **Quick add task** (press **N** in the companion; assign a global hotkey in Settings → Hotkeys) | One line, e.g. `render toaster hero shot fri 3h p1 #cad`. Project by full name or `@prefix`; dates `today`, `tomorrow`, `fri`, `nov 9`, `9 nov`, `12/5`, `2026-12-05`, `+3d`, `+2w`, `next week`; estimate `3h`, `90m`; priority `p1`–`p4` (= dotpm priority order); `#worktype` sets the work type (and files into a project of the same name, e.g. `#fun` → Fun), other `#tags` become tags. No project → *Quick-add default project*. |
| **Quick capacity (change a day's hours)** (press **C** in the companion, or *± Change hours* on the Capacity tab) | One line: `-1.5 sleep`, `-3 thu dentist`, `+2 sat crunch`, `-45m nap`, `-1h30m call`, `off fri sick` (whole day off), `undo` (reverses the last change). Day words: `today` (default), `tomorrow`, `yesterday`, `mon`…`sun` (next one, today included), `nov 9`, `11/9`, `2026-11-09`. The preview shows the day and week before → after and the week's load; Enter applies it, adds a row to `Schedule log.md`, and warns when the week goes over the overload threshold. See §4. |
| **Log time…** / **Log time on this task** | `1.5`, `2h`, `45m`, `1h30m` (ends now), a range `2-3:30pm`, `14:00-15:30`, `9am–noon`, or `1.5h at 10am` / `2h from 14:00`, optionally followed by a note (`2-3:30pm sanding`). Each log is saved with its date plus `start` and `end` times (`"14:00"`, `"15:30"`); work that began before midnight is dated the day before. The box previews what it will save and shows the task's last three logs. |
| **New project from template** | Templates are notes in *Templates folder* (default `Templates/Projects`) containing a table `\| Task \| Work type \| Hours \| Start day \| Days \| After \| Done when \|`. *Start day* counts from the project start (0 = first day), *After* = comma-separated task names it waits on, *Done when* items separated by `;`. An example *Case study* template is created the first time. |
| Write last week's spillover now | Writes the previous week's unfinished tasks to `Spillover.md`. |
| Update progress from Done-when checklists (all tasks) | One-off sync of every task's progress. |
| Create capacity file | Writes a `Capacity.md` template. |
| **Show diagnostics** | What the companion sees on this device: version, dotpm loaded, projects folder, projects/tasks found, capacity weeks read. *Copy* puts it on the clipboard. |
| Re-read all tasks | Rebuild the index (e.g. after a big sync). |

---

## 6. Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Capacity file | `Capacity.md` | |
| Capacity rules file | `Claude/capacity-rules.json` | Where *Quick capacity* stores its changes for the calendar rebuild. If it's missing, changes go into `Capacity.md` only and the next rebuild drops them. |
| Default hours per week | 40 | For weeks missing from the capacity file. |
| Planning range | 2026-10-19 → 2026-12-11 | Weeks shown in Capacity / Board / Work types. |
| Overload threshold | 85 % | |
| Progress from Done-when checklist | on | Overwrites hand-set progress on tasks that have a checklist. |
| dotpm tab project | All projects | Or a single project (its sub-projects included). |
| Sort dotpm by due date | on | dotpm views still on dotpm's default (status) sort are switched **once** to due date, then priority. A sort you pick later is kept. |
| Work type from project | on | A task with no work type in a project named like a work type (IDSA, Fun, Misc…) gets it. |
| Quick-add default project | Misc | |
| Templates folder | `Templates/Projects` | |
| Schedule log | on | Writes `Schedule log.md` and Monday `Spillover.md`. |
| Write the logs from this device | first desktop | A switch on each device (stored locally). Turn it on only on your main computer; turning it on takes over from other devices. |
| Open on startup | on | |
| Multipliers | 2.0× each | Every change is kept in the history. |

---

## 7. Files the companion writes

| File | When |
| --- | --- |
| Task frontmatter (`progress`, `status`, `priority`, `start`, `due`, `timeLogs`, `customFields`) | Your actions in the companion, checklist progress, project work types. Normally through dotpm's own store, so dotpm saves the file and redraws. |
| New project / task notes | Quick add and templates, through dotpm's store. |
| `Schedule log.md` | Every start/due change (logging device only). |
| `Spillover.md` | Once per week, on Monday (logging device only). |
| `Capacity.md` | Only via *Create capacity file*. |
| dotpm's `projectFilters` (in dotpm's settings) | Once per view, the due-date default sort. |
| `.obsidian/plugins/dotpm-companion/data.json` | The companion's settings, multipliers and history, undo state. |

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Tabs show 0h / no tasks on one device | Run **Show diagnostics** there. *Tasks found: 0* → press *Re-read all tasks*; still 0 → check *Projects folder* and *Markdown files in it* (Sync may not have finished). |
| New version not showing | Run the BRAT update command, then toggle the plugin off/on. |
| dotpm tab shows an error | Make sure dotpm is enabled; use *Open dotpm*; report the message. |
| dotpm doesn't show a change | It should update at once; if not, the companion fell back to editing the file and waited 6 s for dotpm's self-write guard. Reopen the dotpm view. |
| A work type shows "(not in dotpm's list)" | The option was removed in dotpm's settings; change those tasks' work type in dotpm. |
| Every week is "Over" | `Capacity.md` missing or multipliers still at 2.0×. |
| A folder can't be deleted on Windows ("You require permission from …") | Close Obsidian; in an admin PowerShell: `takeown /f "<folder>" /r /d y`, `icacls "<folder>" /grant "${env:USERNAME}:F" /t`, `Remove-Item "<folder>" -Recurse -Force`. |
