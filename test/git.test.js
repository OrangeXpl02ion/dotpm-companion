"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const M = require("../src/model.js");

const NOW = Date.parse("2026-10-26T21:00:00Z");
const min = m => NOW - m * 60000;

test("parses git status --porcelain --branch", () => {
  const s = M.parseGitPorcelain([
    "## main...origin/main [ahead 2, behind 1]",
    " M Project/Fall 2026/Kettle/_tasks/kettle-renders.md",
    "?? \"Project/Fall 2026/Gardening Studio/_tasks/gardening-final-presentation-(nov-20).md\"",
    "R  old.md -> Capacity.md",
  ].join("\n"));
  assert.equal(s.branch, "main"); assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2); assert.equal(s.behind, 1);
  assert.deepEqual(s.paths, ["Project/Fall 2026/Kettle/_tasks/kettle-renders.md",
    "Project/Fall 2026/Gardening Studio/_tasks/gardening-final-presentation-(nov-20).md", "Capacity.md"]);
  assert.equal(M.parseGitPorcelain("## main").upstream, null);
  assert.equal(M.parseGitPorcelain("## No commits yet on main").branch, "main");
  assert.equal(M.parseGitPorcelain("## main...origin/main [gone]").gone, true);
});

test("push status: synced, pending, stale, behind, no remote, not a repo", () => {
  const base = { repo: true, now: NOW, warnMin: 10 };
  const clean = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, paths: [] };
  let g = M.gitPushStatus({ ...base, porcelain: clean, lastPushedMs: min(3) });
  assert.equal(g.state, "synced"); assert.equal(g.text, "Pushed 3 min ago");

  g = M.gitPushStatus({ ...base, porcelain: { ...clean, paths: ["a.md", "b.md"] }, editTimes: [min(2), min(4)] });
  assert.equal(g.state, "pending"); assert.equal(g.text, "Not pushed · 2 files"); assert.match(g.detail, /oldest change 4 min ago/);

  g = M.gitPushStatus({ ...base, porcelain: { ...clean, ahead: 1 }, aheadTimes: [min(25)] });
  assert.equal(g.state, "stale"); assert.equal(g.text, "Not pushed · 1 commit"); assert.match(g.detail, /Push before you leave/);

  g = M.gitPushStatus({ ...base, porcelain: { ...clean, paths: ["a.md"], behind: 2 }, editTimes: [min(1)] });
  assert.equal(g.text, "Not pushed · 1 file · 2 to pull");

  g = M.gitPushStatus({ ...base, porcelain: { ...clean, behind: 1 }, lastPushedMs: min(90) });
  assert.equal(g.state, "behind"); assert.equal(g.text, "1 update to pull");

  assert.equal(M.gitPushStatus({ ...base, porcelain: { ...clean, upstream: null } }).state, "noremote");
  assert.equal(M.gitPushStatus({ repo: false }).state, "none");
  assert.equal(M.gitPushStatus({ ...base, error: "fatal: bad" }).state, "error");
  assert.equal(M.fmtAgo(0.2), "just now"); assert.equal(M.fmtAgo(150), "3 h ago"); assert.equal(M.fmtAgo(3000), "2 d ago");
});

// End to end against real git: a vault clone pushing to a bare "GitHub" repo.
test("reads a real repository through every state", { skip: (() => { try { execFileSync("git", ["--version"]); return false; } catch (e) { return "git not installed"; } })() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpc-git-"));
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const remote = path.join(dir, "remote.git"), mac = path.join(dir, "mac"), pc = path.join(dir, "pc");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "clone", "-q", remote, mac);
  git(mac, "checkout", "-q", "-b", "main");
  const status = cwd => M.gitPushStatus({ repo: true, now: Date.now(), warnMin: 10,
    porcelain: M.parseGitPorcelain(git(cwd, "status", "--porcelain=v1", "--branch", "-uall")),
    editTimes: [Date.now()], aheadTimes: [], lastPushedMs: Date.now() });

  fs.writeFileSync(path.join(mac, "task.md"), "due: 2026-11-02\n");
  assert.equal(status(mac).state, "noremote");                 // nothing pushed yet, no upstream
  git(mac, "add", "-A"); git(mac, "commit", "-qm", "plan"); git(mac, "push", "-qu", "origin", "main");
  assert.equal(status(mac).state, "synced");

  fs.writeFileSync(path.join(mac, "task.md"), "due: 2026-11-20\n");
  assert.equal(status(mac).state, "pending");                  // edited, not committed
  git(mac, "commit", "-qam", "move");
  assert.equal(status(mac).text, "Not pushed · 1 commit");      // committed, not pushed
  git(mac, "push", "-q");
  assert.equal(status(mac).state, "synced");

  git(dir, "clone", "-q", remote, pc);
  fs.writeFileSync(path.join(pc, "task.md"), "due: 2026-11-21\n");
  git(pc, "commit", "-qam", "pc edit"); git(pc, "push", "-q");
  git(mac, "fetch", "-q");
  assert.equal(status(mac).state, "behind");                   // another computer pushed
  fs.rmSync(dir, { recursive: true, force: true });
});
