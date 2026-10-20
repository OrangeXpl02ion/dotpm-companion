"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const M = require("../src/model.js");
const rules = require("../tools/capacity-rules.example.json");
const T = "2026-10-20"; // a Tuesday

test("quick capacity: reads one line", () => {
  const p = s => M.parseCapacityInput(s, T);
  assert.deepEqual(p("-1.5 sleep"), { kind: "adjust", hours: -1.5, date: T, reason: "sleep" });
  assert.deepEqual(p("-3 thu dentist"), { kind: "adjust", hours: -3, date: "2026-10-22", reason: "dentist" });
  assert.deepEqual(p("+2 sat crunch"), { kind: "adjust", hours: 2, date: "2026-10-24", reason: "crunch" });
  assert.equal(p("-45m nap").hours, -0.75);
  assert.equal(p("-1h30m call").hours, -1.5);
  assert.equal(p("+2h tomorrow").date, "2026-10-21");
  assert.equal(p("-1 yesterday late night").date, "2026-10-19");
  assert.equal(p("-2 nov 9 interview").date, "2026-11-09");
  assert.equal(p("-2 11/9").date, "2026-11-09");
  assert.equal(p("−2 migraine").hours, -2);
  assert.deepEqual(p("off fri sick"), { kind: "off", hours: null, date: "2026-10-23", reason: "sick" });
  assert.deepEqual(p("undo"), { kind: "undo" });
  assert.equal(p("sleep"), null);
  assert.equal(p("2 sleep"), null, "a change needs a sign");
  assert.equal(p("-30 sleep"), null, "more than a day");
});

test("quick capacity: usable hours and notes", () => {
  assert.equal(M.dayUsable(rules, "2026-10-20"), 12);
  assert.equal(M.dayUsable(rules, "2026-10-24"), 10);
  assert.equal(M.adjustmentNote({ kind: "adjust", date: "2026-10-22", hours: -3, reason: "dentist" }), "Thu Oct 22: −3 h dentist");
  assert.equal(M.adjustmentNote({ kind: "off", date: "2026-10-23", reason: "" }), "Fri Oct 23: day off");
});

const CAP = `# Capacity

| Week | Starts | Available hours | Busy in calendar | Travel | Chores | Adjusted | Class work time | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-W43 | 2026-10-19 | 64 | 10.0 | 4 | 0.3 | 0 | 6.0 |  |
| 2026-W44 | 2026-10-26 | 58.5 | 10.0 | 4 | 0.3 | 0 | 6.0 | Sun concert (3 h) |

## Days

| Day | Weekday | Available hours | Usable | Adjusted | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-22 | Thu | 9.5 | 12 | 0 |  |
| 2026-10-24 | Sat | 9 | 10 | 0 |  |
`;

test("Capacity.md: the Days table doesn't change the weekly numbers", () => {
  assert.deepEqual(M.parseCapacity(CAP), { "2026-W43": 64, "2026-W44": 58.5 });
  assert.deepEqual(M.parseCapacityDays(CAP), { "2026-10-22": 9.5, "2026-10-24": 9 });
});

test("plan: clamps a day to 0…usable", () => {
  const ctx = { rules, weekly: M.parseCapacity(CAP), days: M.parseCapacityDays(CAP), fallbackWeekly: 40 };
  const a = M.planAdjustment({ kind: "adjust", date: "2026-10-22", hours: -3 }, ctx);
  assert.equal(a.dayBefore, 9.5); assert.equal(a.dayAfter, 6.5); assert.equal(a.applied, -3); assert.equal(a.weekAfter, 61); assert.equal(a.clamped, false);
  const b = M.planAdjustment({ kind: "adjust", date: "2026-10-24", hours: 4 }, ctx);
  assert.equal(b.applied, 1); assert.equal(b.clamped, true);
  const c = M.planAdjustment({ kind: "off", date: "2026-10-22" }, ctx);
  assert.equal(c.applied, -9.5);
  const d = M.planAdjustment({ kind: "adjust", date: "2026-10-21", hours: -1 }, ctx);
  assert.equal(d.estimated, true);
});

test("Capacity.md edit and its undo", () => {
  const note = "Thu Oct 22: −3 h dentist";
  const r = M.applyCapacityDelta(CAP, "2026-10-22", -3, note, null);
  assert.equal(r.found, true);
  assert.equal(M.parseCapacity(r.text)["2026-W43"], 61);
  assert.equal(M.parseCapacityDays(r.text)["2026-10-22"], 6.5);
  assert.match(r.text, /\| 2026-W43 \| 2026-10-19 \| 61 \| .* \| -3 \| 6\.0 \| Thu Oct 22: −3 h dentist \|/);
  assert.match(r.text, /\| 2026-10-22 \| Thu \| 6\.5 \| 12 \| -3 \| −3 h dentist \|/);
  const back = M.applyCapacityDelta(r.text, "2026-10-22", 3, null, note).text;
  assert.deepEqual(M.parseCapacity(back), M.parseCapacity(CAP));
  assert.match(back, /\| 2026-10-22 \| Thu \| 9\.5 \| 12 \| 0 \|  \|/);
  assert.match(M.applyCapacityDelta(CAP, "2026-10-27", -1, "x", null).text, /\| 2026-W44 \| 2026-10-26 \| 57\.5 \|/);
});

test("rules: add, then remove the newest Quick capacity entry", () => {
  let r = M.addToRules(rules, { kind: "adjust", date: "2026-10-22", hours: -3, reason: "dentist" }, -3, "2026-10-20T10:00:00Z");
  r = M.addToRules(r, { kind: "off", date: "2026-10-23", reason: "sick" }, -9, "2026-10-20T11:00:00Z");
  assert.equal(r.adjustments.length, 1); assert.equal(r.holidays.length, 2);
  assert.equal(rules.adjustments, undefined, "input not changed");
  const u1 = M.removeLastFromRules(r);
  assert.deepEqual(u1.removed, { kind: "off", date: "2026-10-23", hours: undefined, reason: "sick", applied: -9 });
  assert.equal(u1.rules.holidays.length, 1, "Thanksgiving stays");
  const u2 = M.removeLastFromRules(u1.rules);
  assert.equal(u2.removed.applied, -3); assert.equal(u2.rules.adjustments.length, 0);
  assert.equal(M.removeLastFromRules(u2.rules), null);
});

test("log row", () => {
  const row = M.capacityLogRow("2026-10-20 13:05", { kind: "adjust", date: "2026-10-22", hours: -3, reason: "dentist" }, { week: "2026-W43", applied: -3, weekBefore: 64, weekAfter: 61 }, false);
  assert.equal(row, "| 2026-10-20 13:05 | Capacity | — | Thu Oct 22 −3 h (2026-W43 64 → 61 h) | Quick capacity: dentist |");
});

test("the calendar rebuild gives the same numbers as the instant edit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpc-cap-"));
  const R = { ...rules };
  const events = [{ title: "Culinary Mechanics", start: "2026-10-22T10:00:00-04:00", end: "2026-10-22T12:00:00-04:00", response: "accepted" }];
  fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify(events));
  const run = rr => { fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify(rr));
    execFileSync("python3", [path.join(__dirname, "..", "tools", "capacity_from_calendar.py"), path.join(dir, "rules.json"), path.join(dir, "events.json"), path.join(dir, "Capacity.md")]);
    return fs.readFileSync(path.join(dir, "Capacity.md"), "utf8"); };
  const before = run(R);
  const a = { kind: "adjust", date: "2026-10-22", hours: -3, reason: "dentist" };
  const ctx = { rules: R, weekly: M.parseCapacity(before), days: M.parseCapacityDays(before), fallbackWeekly: 40 };
  const plan = M.planAdjustment(a, ctx);
  const instant = M.applyCapacityDelta(before, a.date, plan.applied, M.adjustmentNote(a), null).text;
  const rebuilt = run(M.addToRules(R, a, plan.applied, "2026-10-20T10:00:00Z"));
  assert.deepEqual(M.parseCapacityDays(instant), M.parseCapacityDays(rebuilt));
  assert.ok(Math.abs(M.parseCapacity(instant)["2026-W43"] - M.parseCapacity(rebuilt)["2026-W43"]) <= 0.5);
  assert.ok(rebuilt.includes("Thu Oct 22: −3 h dentist"));
  const off = { kind: "off", date: "2026-10-23", reason: "sick" };
  const p2 = M.planAdjustment(off, ctx);
  assert.equal(M.parseCapacityDays(run(M.addToRules(R, off, p2.applied, "x")))["2026-10-23"], 0);
});
