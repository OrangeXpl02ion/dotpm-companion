"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/model.js");
const fx = require("./fixture/vault.json");
const cfg = M.readDotpmConfig(fx.dotpm);

const today = "2026-10-20"; // Tuesday
const base = { status: "todo", start: null, logs: [], logged: 0, workType: "CAD", deps: [], priority: "medium", type: "task" };
const mk = (id, extra) => ({ ...base, id, path: `${id}.md`, title: id, ...extra });
// 10 h open every day, 50 % worked → 5 h a day; ×1 multipliers so hours are easy to read
const S = { rangeStart: "2026-10-19", rangeEnd: "2026-12-11", defaultWeeklyHours: 70, capacity: {}, workSharePct: 50, multipliers: { CAD: 1 } };

test("saved order wins; new tasks slot in by urgency", () => {
  const T = [mk("a", { due: "2026-11-20" }), mk("b", { due: "2026-10-22" }), mk("c", { due: "2026-11-01" })];
  const cmp = (x, y) => x.due.localeCompare(y.due);
  assert.deepEqual(M.queueOrder(T, [], cmp).map(t => t.id), ["b", "c", "a"], "no saved order: urgency");
  assert.deepEqual(M.queueOrder(T, ["a", "c"], cmp).map(t => t.id), ["b", "a", "c"], "b is new and more urgent than a, so it goes first");
  assert.deepEqual(M.queueOrder(T, ["c", "b", "a"], cmp).map(t => t.id), ["c", "b", "a"]);
});

test("moving in the order", () => {
  assert.deepEqual(M.moveInOrder(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"], "up: lands before the target");
  assert.deepEqual(M.moveInOrder(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"], "down: lands after the target");
  assert.deepEqual(M.moveInOrder(["a", "b"], "x", "b"), ["a", "b"], "unknown id: unchanged");
});

test("days fill in queue order and a big task spills into the next day", () => {
  const T = [mk("first", { estimate: 7, due: "2026-10-30" }), mk("second", { estimate: 4, due: "2026-10-21" })];
  const byName = new Map(T.map(t => [t.id, t]));
  const P = M.placeQueue(T, byName, cfg, S, today, t => M.adjusted(t, S.multipliers), 0);
  assert.deepEqual(P.tasks["first.md"].segs, [["2026-10-20", 5], ["2026-10-21", 2]]);
  assert.deepEqual(P.tasks["second.md"].segs, [["2026-10-21", 3], ["2026-10-22", 1]]);
  assert.equal(P.tasks["second.md"].finish, "2026-10-22");
  assert.equal(P.tasks["second.md"].late, true, "pushed past its due date by the task above it");
  assert.equal(P.tasks["first.md"].late, false);
  // drag second above first: it now fits
  const P2 = M.placeQueue([T[1], T[0]], byName, cfg, S, today, t => M.adjusted(t, S.multipliers), 0);
  assert.equal(P2.tasks["second.md"].finish, "2026-10-20");
  assert.equal(P2.tasks["second.md"].late, false);
});

test("start dates, dependencies and today's logged time", () => {
  const T = [
    mk("later", { estimate: 2, start: "2026-10-23", due: "2026-10-30" }),
    mk("child", { estimate: 1, due: "2026-10-30", deps: ["parent"] }),
    mk("parent", { estimate: 6, due: "2026-10-30" }),
  ];
  const byName = new Map(T.map(t => [t.id, t]));
  const P = M.placeQueue(T, byName, cfg, S, today, t => M.adjusted(t, S.multipliers), 3);
  assert.equal(P.tasks["later.md"].start, "2026-10-23", "waits for its start date");
  assert.deepEqual(P.tasks["parent.md"].segs, [["2026-10-20", 2], ["2026-10-21", 4]], "placed before its dependent; today holds 5 − 3 logged");
  assert.equal(P.tasks["child.md"].start, "2026-10-21", "starts the day its dependency finishes");
});

test("compute: queue follows the saved order and day bars come from placement", () => {
  const T = [mk("a", { estimate: 3, due: "2026-11-20" }), mk("b", { estimate: 3, due: "2026-10-22" })];
  const R0 = M.compute(T, cfg, S, today);
  assert.deepEqual(R0.queue.map(t => t.id), ["b", "a"]);
  const R = M.compute(T, cfg, { ...S, queueOrder: ["a", "b"] }, today);
  assert.deepEqual(R.queue.map(t => t.id), ["a", "b"]);
  assert.deepEqual(R.order, ["a", "b"]);
  assert.equal(R.days[0].adj, 5);
  assert.equal(R.days[0].available, 5);
  assert.deepEqual(R.days[0].byTask.map(x => [x.task.id, x.hours]), [["a", 3], ["b", 2]]);
  assert.equal(R.days[1].byTask[0].task.id, "b");
  assert.equal(R.placed["b.md"].finish, "2026-10-21");
});

test("worked share only counts days with capacity", () => {
  const T = [mk("a", { logs: [{ date: "2026-10-19", hours: 4 }, { date: "2026-10-10", hours: 9 }] })];
  const w = M.workedShare(T, { ...S, capacityDays: { "2026-10-19": 8 }, capacity: {} }, today, 14);
  assert.equal(w.open, 8); assert.equal(w.logged, 4); assert.equal(w.share, 0.5); assert.equal(w.from, "2026-10-19");
});
