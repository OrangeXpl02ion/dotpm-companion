# Scheduling playbook for AI assistants

How an AI assistant (written for Claude) should read, schedule and revise tasks in a dotpm + dotpm Companion vault when the user talks about their work. A personal copy with real dates and projects belongs in the user's vault.
Read this before changing anything in the vault.

---

## 1. Where everything lives

| What | Where |
| --- | --- |
| Vault | The Obsidian vault with dotpm and the dotpm Companion (see [SETUP.md](SETUP.md)). |
| Projects and tasks | dotpm notes under the projects folder (`pm-project: true` / `pm-task: true`); task notes in each project's `_tasks/` folder. |
| Weekly availability | `Capacity.md` (vault root). Column *Available hours* is what the planner uses. |
| Date-change history | `Schedule log.md` (vault root, newest first), written by the companion on one device. |
| Last week's unfinished work | `Spillover.md` (vault root), written each Monday. |
| Multipliers and history | `.obsidian/plugins/dotpm-companion/data.json` → `multipliers`, `multiplierHistory`. |
| dotpm settings (statuses, priorities, work types) | `.obsidian/plugins/project-manager/data.json` |
| Calendar | The user's calendar(s). Put proposed work blocks only in a calendar the user set aside for that; never edit others. |

---

## 2. Facts to fill in for your vault

Keep a personal copy of this playbook in the vault (for example `Claude scheduling playbook.md`) and fill in:

- **Term / planning range** and the **hard dates** (presentations, finals, showcases) as a table.
- **Projects and their priority**, including parents and anything that unlocks other work.
- **Work types** (the options of dotpm's `work-type` field) and any values awaiting a remap.
- **Availability**: how `Capacity.md` was built (usable hours per day, what was subtracted) and the weekly numbers.
- **Multipliers**: their starting values and when they were set.
- **Open decisions** the assistant should ask about rather than guess.

---

## 3. Before changing anything

1. **Read the current state.** List `Project/` and read the task notes you'll touch, plus `Capacity.md`, the newest rows of `Schedule log.md` and `Spillover.md`, and the multipliers. dotpm renames task files to slugs (e.g. `toaster-cad-assembly.md`), so find tasks by `title` or `id`, not by file name.
2. **Work out the load.** For each week: remaining hours = estimate − logged, spread evenly from max(start, today) to due, × the work-type multiplier. Compare with *Available hours*. A week at 85 % or more is overloaded.
3. **Check whether Obsidian is open** (recently modified `.obsidian/workspace.json`, or ask). dotpm keeps tasks in memory: if Obsidian is open, a file edit can be overwritten by dotpm's next save, and dotpm ignores outside edits for 5 seconds after it saves a file itself.
   - **Many changes (re-plans, new projects):** ask the user to close Obsidian, write the files, then ask them to reopen.
   - **One or two field changes while Obsidian is open:** fine — change only the frontmatter lines involved, then ask them to glance at dotpm.
4. **Never** rename, move or re-ID a task or project file, never delete files, and never touch `.obsidian/` settings except the companion's `data.json` when asked.

---

## 4. How to write changes

- Task frontmatter fields: `status` (`todo`, `in-progress`, `blocked`, `review`, `done`, `cancelled`), `priority` (`critical`, `high`, `medium`, `low`), `start`, `due` (`YYYY-MM-DD`), `progress` (0–100), `timeEstimate` (hours), `timeLogs` (list of `{date, hours, note}`), `completed` (date, set when marking done), `dependencies` (wikilinks to task notes), `customFields: { <work-type field id>: <work type> }`. Check the field id in dotpm's `data.json` before writing.
- New task: new file in the project's `_tasks/` with all fields above, a unique 16-character `id` (`a-z0-9`), `projectId: "[[Project Title|Project Title]]"`, a `## Done when` checklist (2–4 items), and add `"[[file-name|Title]]"` to the project's `taskIds`.
- Moving dates: keep the duration (shift start and due together) unless the user says otherwise; move dependents that would now start before their dependency is due.
- After writing, add a row to the top of `Schedule log.md` for every date you changed:
  `| 2026-10-21 14:05 | Task | Project | due 11-13 → 11-17 | Claude: <reason the user gave> |`
  (the companion only logs changes it sees while Obsidian is running).

---

## 5. What the user says → what to do

| The user says | Do |
| --- | --- |
| "I finished X" | `status: done`, `completed: <today>`, `progress: 100`, tick its Done-when boxes. If they say how long it took, add a time log. Mention what that unblocks. |
| "I spent 3 h on X" / "X took longer" | Add `{date: today, hours, note}` to `timeLogs`. If logged > estimate, ask whether to raise the estimate for the rest. |
| "Add a task …" | Create it in the right project with work type, estimate, due date, priority and Done-when. If they give none of these, propose them in one line and ask once. |
| "Move X" / "X slipped to Friday" | Shift its dates, then its dependents; report the knock-ons. |
| "I'm behind" / "too much this week" | Compute the week's load. Propose moves in this order: lowest priority first, latest due first, never past a hard date, never break a dependency. Show the before/after load and wait for a yes. |
| "I'm sick" / "I lose Thursday" / "I slept in" / "I can work extra Saturday" | If `Capacity.md` is rebuilt from a rules file, add an entry to its `adjustments` (`{date, hours, reason}`, negative = lost) or a whole day to `holidays`, then re-run the rebuild — or tell the user to type it into *Quick capacity* (`-3 thu sick`, `off fri sick`). Otherwise lower that week's *Available hours* in `Capacity.md` (reason in *Notes*). Then re-check the load and propose moves as above. |
| "New deadline for X" | Change the due date, check whether the work still fits, move dependents. |
| "What should I do today?" | Started, unfinished tasks by priority → due date → hours left; flag anything at risk or waiting on an overdue task. Suggest at most three. |
| "Plan my week" (Sunday) | Read `Spillover.md` and last week's logs, re-check estimates, list what's due this week, propose the order and any moves. Offer to put work blocks in the calendar set aside for proposed work. |
| "Change my multiplier" / "CAD always takes longer" | Update `multipliers` and append a `multiplierHistory` entry `{date, type, value}` in the companion's `data.json` (Obsidian closed), or tell the user to change it on the Multipliers tab. |

---

## 6. Scheduling rules

1. Hard dates don't move without the user saying so. Critical tasks don't move without asking.
2. A task starts no earlier than the latest due date of the tasks it depends on.
3. Keep each week at or under 85 % of *Available hours* after multipliers; if that's impossible, say which hard date is at risk and by how many hours.
4. Nothing planned on days marked off in `Capacity.md` notes (holidays).
5. Prefer moving Low → Medium → High; never move a task to make room for a lower-priority one.
6. Every task has a work type, an estimate in hours and a Done-when checklist.
7. Fun and Misc are fine to schedule but never at the expense of a hard date.

---

## 7. Revising estimates and multipliers

- After a task is done, compare logged hours with the estimate.
- When three or more done tasks of one work type agree (measured factor within ±0.2), suggest moving that multiplier toward the measured value — say the old and new number and the tasks behind it.
- Never change estimates of finished tasks.

---

## 8. Reporting back

- After any change, list each task as `Task: field old → new` and the week loads that changed.
- Ask first before: more than five changes at once, moving a hard date or a Critical task, deleting or cancelling anything, editing a calendar.
- Never send messages or emails, and never post anything on the user's behalf.

---

## 9. Open decisions

Keep the user's open decisions in the personal copy; ask about them instead of guessing.
