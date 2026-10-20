// Builds test/build/render.html: model + views + fixture rendered with Obsidian-like theme variables.
"use strict";
const fs = require("fs"), path = require("path");
const src = n => fs.readFileSync(path.join(__dirname, "..", "src", n + ".js"), "utf8");
const fx = fs.readFileSync(path.join(__dirname, "fixture", "vault.json"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:-apple-system,"Segoe UI",Inter,sans-serif;background:var(--background-primary);}
body.theme-light{--background-primary:#fff;--background-primary-alt:#fafafa;--background-secondary:#f6f6f6;--background-modifier-border:#e3e3e3;--background-modifier-hover:rgba(0,0,0,.05);--text-normal:#222;--text-muted:#5c5c5c;--text-faint:#999;--text-accent:#7b6cd9;--color-red:#e93147;--color-orange:#ec7500;--color-green:#08b94e;--shadow-s:0 1px 4px rgba(0,0,0,.12)}
body.theme-dark{--background-primary:#1e1e1e;--background-primary-alt:#242424;--background-secondary:#262626;--background-modifier-border:#363636;--background-modifier-hover:rgba(255,255,255,.06);--text-normal:#dadada;--text-muted:#b3b3b3;--text-faint:#666;--text-accent:#a68af9;--color-red:#fb464c;--color-orange:#e9973f;--color-green:#44cf6e;--shadow-s:0 1px 4px rgba(0,0,0,.5)}
button{font:inherit;background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:4px;padding:3px 8px;cursor:pointer}
input{font:inherit;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:4px;padding:2px 6px}
.mod-cta{background:var(--text-accent);color:#fff;border:0}
#root{width:760px}
${css}</style></head><body class="theme-light"><div id="root"></div><script>
const __mods={},__cache={};function __req(n){if(n in __cache)return __cache[n].exports;const m={exports:{}};__cache[n]=m;__mods[n](m,m.exports,__req);return m.exports;}
__mods["./model"]=function(module,exports,require){${src("model")}};
__mods["./views"]=function(module,exports,require){${src("views")}};
const M=__req("./model"),V=__req("./views");const FX=${fx};
const cfg=M.readDotpmConfig(FX.dotpm);
const tasks=FX.tasks.map(t=>M.parseTask(t.path,t.fm,t.body,cfg)).filter(Boolean);
const settings={capacityFile:"Capacity.md",defaultWeeklyHours:40,rangeStart:"2026-10-19",rangeEnd:"2026-12-11",overloadPct:85,multipliers:{},multiplierHistory:[],capacity:{}};
M.ensureMultipliers(settings,V.typeKeys(cfg),"2026-10-20");
window.setup=(o)=>{
  document.body.className=o.dark?"theme-dark":"theme-light";
  const S=JSON.parse(JSON.stringify(settings)); Object.assign(S,o.settings||{});
  for(const [d,k,v] of (o.changes||[])){S.multipliers[k]=v;S.multiplierHistory=M.recordMultiplier(S.multiplierHistory,d,k,v);}
  const today=o.today||"2026-10-20";
  const TS=tasks.map(t=>({...t}));
  for(const [title,f] of (o.mutate||[])){const t=TS.find(x=>x.title===title); if(t)Object.assign(t,f);}
  S.projectsFolder="Project/";const tasks2=TS;const st={tab:o.tab,mode:o.mode||"adj",expanded:o.expanded||null,collapsed:new Set(o.collapsed||[]),query:o.query||"",bridged:true,projectColors:{"Gardening Studio":"#79b58d","Kettle":"#c47070","About Page":"#8a94a0","Hero Showreel":"#767491","Peloton":"#b8a06b"},cfg,settings:S,tasks:tasks2,result:M.compute(tasks2,cfg,S,today),showMore:!!o.showMore};
  const root=document.getElementById("root");
  const on={mountDotpm(h){throw new Error("dotpm's project view isn't registered (is dotpm enabled?)")},openDotpmTab(){},undoStart(){},undoDone(){},startNow(){},moveCard(){},setBoardMode(){},toggleMore(){},setTab(){},setMode(){},toggleWeek(){},openTask(){},openFile(){},markDone(){},setField(){},setShowDone(){},toggleGroup(){},setQuery(){},setMultiplier(){},createCapacity(){}};
  V.render(root,st,on);
  return {errors:window.__errs||[]};
};
window.addEventListener("error",e=>{(window.__errs=window.__errs||[]).push(String(e.message))});
</script></body></html>`;
fs.mkdirSync(path.join(__dirname, "build"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "build", "render.html"), html);
console.log("ok");
