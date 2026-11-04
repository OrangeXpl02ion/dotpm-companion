"use strict";
// Start / End time fields inside dotpm's own task page (its "Time tracking" section).
// dotpm draws each log as a row: date · hours · note · ×, bound to a log object in the editor's draft task
// (`editor.task.timeLogs[i]`), and writes the draft when you press Save. We add two time inputs after the date and
// write `start` / `end` onto that same object, so dotpm saves them with the rest (it copies log objects whole).
// Both times set → hours follow. Hours changed with a start set → end follows. The date stays dotpm's.
// No Obsidian imports, so it can run against a fake page in tests.
const M = require("./model");

const ROW = "pm-time-log-row", LIST = "pm-time-log-list", MARK = "dpcTimes";

function toMin(v) { const c = M.normClock(v); if (!c) return null; const [h, m] = c.split(":").map(Number); return h * 60 + m; }
const round2 = x => Math.round(x * 100) / 100;

// Apply a change to one log. `which` is "start", "end" or "hours"; returns what the row should now show.
function applyTimes(log, which, value) {
  if (which === "start" || which === "end") {
    const c = M.normClock(value);
    if (c) log[which] = c; else delete log[which];
  } else {
    const h = parseFloat(value);
    log.hours = isFinite(h) && h > 0 ? h : 0;
  }
  const s = toMin(log.start), e = toMin(log.end);
  if (which !== "hours" && s != null && e != null) {
    let len = e - s; if (len <= 0) len += 1440; // past midnight
    log.hours = round2(len / 60);
  } else if (which === "hours" && log.hours > 0) {
    if (s != null) log.end = M.fmtClock(s + log.hours * 60);
    else if (e != null) log.start = M.fmtClock(e - log.hours * 60);
  }
  return { start: log.start || "", end: log.end || "", hours: log.hours };
}

function enhanceRow(row, log) {
  if (!row || !log || row.dataset[MARK]) return false;
  const doc = row.ownerDocument, date = row.querySelector(".pm-time-log-date"), hours = row.querySelector(".pm-time-log-hours");
  if (!hours) return false;
  row.dataset[MARK] = "1";
  const wrap = doc.createElement("span");
  wrap.className = "dpc-tl-times";
  const mk = (which, label) => {
    const i = doc.createElement("input");
    i.type = "time"; i.step = "60"; i.className = "pm-prop-text dpc-tl-time dpc-tl-" + which;
    i.setAttribute("aria-label", label); i.title = label;
    i.value = M.normClock(log[which]) || "";
    return i;
  };
  const start = mk("start", "Start time"), dash = doc.createElement("span"), end = mk("end", "End time");
  dash.className = "dpc-tl-dash"; dash.textContent = "–";
  const now = doc.createElement("button");
  now.type = "button"; now.className = "dpc-tl-now clickable-icon"; now.textContent = "now";
  now.title = "Set the end time to now"; now.setAttribute("aria-label", "Set the end time to now");
  wrap.append(start, dash, end, now);
  if (date && date.nextSibling) row.insertBefore(wrap, date.nextSibling); else row.insertBefore(wrap, hours);
  const show = v => { start.value = v.start; end.value = v.end; hours.value = String(v.hours); };
  const onTime = which => () => {
    const v = applyTimes(log, which, which === "start" ? start.value : end.value);
    show(v);
    hours.dispatchEvent(new Event("change", { bubbles: true })); // dotpm reads the hours box back into the log
  };
  start.addEventListener("change", onTime("start"));
  end.addEventListener("change", onTime("end"));
  // after dotpm's own handler (added earlier) has stored the hours, move the end (or start) to match
  hours.addEventListener("change", e => { if (e.target !== hours || e.isTrusted === false) return; show(applyTimes(log, "hours", hours.value)); });
  now.addEventListener("click", () => { const d = new Date(); end.value = M.fmtClock(d.getHours() * 60 + d.getMinutes()); onTime("end")(); });
  return true;
}

// Add the fields to every row of one time-log list. `logs` is the editor's draft timeLogs array.
function enhanceList(list, logs) {
  if (!list || !Array.isArray(logs)) return 0;
  const rows = [...list.children].filter(r => r.classList && r.classList.contains(ROW));
  let n = 0;
  rows.forEach((r, i) => { if (enhanceRow(r, logs[i])) n++; });
  return n;
}

// Watch a document for dotpm time panels. `findLogs(listEl)` returns that editor's draft timeLogs (or null).
function watch(doc, findLogs) {
  let queued = false;
  const scan = () => {
    queued = false;
    for (const list of doc.querySelectorAll("." + LIST)) {
      if (![...list.children].some(r => r.classList && r.classList.contains(ROW) && !r.dataset[MARK])) continue;
      let logs = null;
      try { logs = findLogs(list); } catch (e) { logs = null; }
      enhanceList(list, logs);
    }
  };
  const win = doc.defaultView || globalThis, later = win.requestAnimationFrame ? f => win.requestAnimationFrame(f) : f => setTimeout(f, 0);
  const obs = new win.MutationObserver(() => { if (!queued) { queued = true; later(scan); } });
  obs.observe(doc.body, { childList: true, subtree: true });
  scan();
  return { scan, stop: () => obs.disconnect() };
}

module.exports = { applyTimes, enhanceRow, enhanceList, watch };
