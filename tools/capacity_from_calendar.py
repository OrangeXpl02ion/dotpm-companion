#!/usr/bin/env python3
"""Build Capacity.md from calendar events.

Usage:  python3 capacity_from_calendar.py <rules.json> <events.json> <out Capacity.md>

events.json is a list of events as read from Google Calendar:
  {"title": "...", "calendar": "...", "start": "2026-10-20T09:30:00-04:00", "end": "...",
   "allDay": false, "response": "accepted|owner|needsAction|declined|tentative",
   "transparent": false, "online": false}

Rules (rules.json): usable window per weekday, meals, travel, which classes count as work time,
holidays and the planning range. Every timed event you've accepted is subtracted from capacity,
except classes listed in "workTimeClasses", which stay as available work time.
"""
import json, sys, datetime as dt
from zoneinfo import ZoneInfo

def hm(s):
    h, m = s.split(":"); return int(h) + int(m) / 60

def load(p):
    with open(p, encoding="utf-8") as f: return json.load(f)

def main(rules_p, events_p, out_p):
    R = load(rules_p); E = load(events_p)
    tz = ZoneInfo(R.get("timeZone", "America/New_York"))
    start = dt.date.fromisoformat(R["rangeStart"]); end = dt.date.fromisoformat(R["rangeEnd"])
    monday = start - dt.timedelta(days=start.weekday())
    last = end + dt.timedelta(days=6 - end.weekday())
    holidays = {h["date"]: h.get("note", "holiday") for h in R.get("holidays", [])}
    credit = [s.lower() for s in R.get("workTimeClasses", [])]
    counts = set(R.get("countResponses", ["accepted", "owner"]))
    ignore = [s.lower() for s in R.get("ignoreTitles", [])]

    days = {}
    d = monday
    while d <= last:
        w = R["window"]["weekend" if d.weekday() >= 5 else "weekday"]
        days[d] = {"win": (hm(w[0]), hm(w[1])), "busy": [], "credit": [], "inPerson": False, "notes": []}
        d += dt.timedelta(days=1)

    used = []
    for e in E:
        if e.get("allDay") or e.get("transparent"): continue
        if e.get("response", "owner") not in counts: continue
        title = e.get("title", "")
        if any(k in title.lower() for k in ignore): continue
        s = dt.datetime.fromisoformat(e["start"]).astimezone(tz); f = dt.datetime.fromisoformat(e["end"]).astimezone(tz)
        day = s.date()
        if day not in days or f <= s: continue
        D = days[day]
        a, b = s.hour + s.minute / 60, (f.hour + f.minute / 60) if f.date() == day else 24
        lo, hi = max(a, D["win"][0]), min(b, D["win"][1])
        is_credit = any(k in title.lower() for k in credit)
        if not e.get("online"): D["inPerson"] = True
        if hi <= lo: continue
        (D["credit"] if is_credit else D["busy"]).append((lo, hi))
        used.append((day, title, round(hi - lo, 2), is_credit))

    def merged(iv):
        out = []
        for a, b in sorted(iv):
            if out and a <= out[-1][1]: out[-1] = (out[-1][0], max(out[-1][1], b))
            else: out.append((a, b))
        return sum(b - a for a, b in out)

    weeks = []
    d = monday
    while d <= last:
        wk = {"start": d, "avail": 0.0, "busy": 0.0, "travel": 0.0, "credit": 0.0, "notes": []}
        for i in range(7):
            day = d + dt.timedelta(days=i); D = days[day]; iso = day.isoformat()
            usable = D["win"][1] - D["win"][0] - R.get("mealsHours", 2)
            if iso in holidays:
                wk["busy"] += max(0, usable); wk["notes"].append(f"{day.strftime('%a %b')} {day.day}: {holidays[iso]}"); continue
            busy = merged(D["busy"])
            travel = R.get("travelHours", 1) if D["inPerson"] else 0
            wk["busy"] += busy; wk["travel"] += travel; wk["credit"] += merged(D["credit"])
            wk["avail"] += max(0, usable - busy - travel)
        for (day, title, h, c) in used:
            if d <= day < d + dt.timedelta(days=7) and not c and not any(k.lower() in title.lower() for k in R.get("routineTitles", [])):
                wk["notes"].append(f"{day.strftime('%a')} {title} ({h:g} h)")
        weeks.append(wk); d += dt.timedelta(days=7)

    now = dt.datetime.now(tz).strftime("%Y-%m-%d %H:%M")
    lines = [
        "# Capacity", "",
        "Available hours per week for planning. The dotpm Companion reads the **Available hours** column.", "",
        f"Rebuilt from Google Calendar on {now} by Claude (rules: `{R.get('rulesFile', 'Claude/capacity-rules.json')}`).", "",
        f"- Usable time: weekdays {R['window']['weekday'][0]}–{R['window']['weekday'][1]}, weekends {R['window']['weekend'][0]}–{R['window']['weekend'][1]}, minus {R.get('mealsHours', 2):g} h a day for meals.",
        "- Subtracted: every timed event you've accepted or created (classes, TEF, IDSA, personal and professional events), clipped to the usable window; overlapping events count once.",
        f"- Kept as work time: {', '.join(R.get('workTimeClasses', []))} (class time you can spend on the project).",
        f"- Travel: {R.get('travelHours', 1):g} h subtracted on each day with an in-person event (bus in, walk home, moving around campus).",
        "- Not subtracted: all-day items, events marked free, invites you haven't accepted, online-only events still count as busy but add no travel.",
        "",
        "| Week | Starts | Available hours | Busy in calendar | Travel | Class work time | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for wk in weeks:
        iso = wk["start"].isocalendar()
        lines.append(f"| {iso[0]}-W{iso[1]:02d} | {wk['start'].isoformat()} | {round(wk['avail'] * 2) / 2:g} | {wk['busy']:.1f} | {wk['travel']:g} | {wk['credit']:.1f} | {'; '.join(wk['notes'])} |")
    text = "\n".join(lines) + "\n"
    with open(out_p, "w", encoding="utf-8", newline="\n") as f: f.write(text)
    print(text)

if __name__ == "__main__":
    main(*sys.argv[1:4])
