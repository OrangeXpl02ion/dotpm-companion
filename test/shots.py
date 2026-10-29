import glob
import asyncio, sys
from playwright.async_api import async_playwright
OUT=sys.argv[1]

def L(d,a,b,note=""):
  ha=int(a[:2])+int(a[3:])/60; hb=int(b[:2])+int(b[3:])/60
  return dict(date=d,start=a,end=b,hours=round(hb-ha,4),note=note)
def T(title,*logs): return [title,dict(logs=list(logs),logged=sum(l["hours"] for l in logs))]
TIME_MUT=[T("Toaster CAD assembly",L("2026-10-16","13:00","16:00"),L("2026-10-19","14:00","16:30"),L("2026-10-21","09:30","11:30","lid hinge")),
 T("Lantern form exploration and mockups",L("2026-10-20","13:00","16:00"),L("2026-10-21","12:30","14:00")),
 T("Typeface pairing",L("2026-10-20","20:00","21:30"),L("2026-10-21","14:15","15:15")),
 T("Toaster 3D print",L("2026-10-21","15:15","16:30")),
 T("Inhaler material audit",L("2026-10-19","10:00","12:00"),L("2026-10-17","10:30","12:00")),
 T("About bio",L("2026-10-19","19:00","20:00"))]
cases=[
 ("time_day",dict(tab="time",today="2026-10-21",nowHours=16.6,mutate=TIME_MUT,settings=dict(capacityDays={"2026-10-21":9.5}))),
 ("time_day_dark",dict(tab="time",dark=True,today="2026-10-21",nowHours=16.6,mutate=TIME_MUT)),
 ("time_week",dict(tab="time",today="2026-10-21",time=dict(mode="week",group="project"),mutate=TIME_MUT,settings=dict(capacityDays={"2026-10-19":9,"2026-10-20":6,"2026-10-21":9.5,"2026-10-22":8.5,"2026-10-23":10,"2026-10-24":9,"2026-10-25":9}))),

 ("capacity_light",dict(tab="capacity",expanded="2026-W45")),
 ("capacity_dark",dict(tab="capacity",dark=True)),
 ("queue_light",dict(tab="queue",showMore=True)),
 ("board_week",dict(tab="board",settings=dict(boardMode="week"))),
 ("types_light",dict(tab="types")),
 ("types_dark",dict(tab="types",dark=True)),
 ("categories_light",dict(tab="types",settings=dict(typesView="category"))),
 ("categories_dark",dict(tab="types",dark=True,settings=dict(typesView="category"))),
 ("categories_top",dict(tab="types",settings=dict(typesView="category",showSubprojects=False))),
 ("mult_light",dict(tab="multipliers",today="2026-11-20",changes=[["2026-10-27","CAD",1.8],["2026-11-03","CAD",1.6],["2026-11-03","Writing",1.4],["2026-11-10","Render",1.5],["2026-11-17","Writing",1.2]])),
 ("mult_dark",dict(tab="multipliers",dark=True)),
]
async def main():
  async with async_playwright() as p:
    exe=sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome"))
    b=await p.chromium.launch(executable_path=exe[-1] if exe else None)
    pg=await b.new_page(viewport={"width":780,"height":900})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console",lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto("file:///home/claude/dotpm-companion/test/build/render.html")
    for name,o in cases:
      r=await pg.evaluate("o=>setup(o)",o)
      await pg.wait_for_timeout(100)
      await pg.screenshot(path=f"{OUT}/{name}.png",full_page=True)
    # hover test on trend chart
    await pg.evaluate("o=>setup(o)",dict(cases)["mult_light"])
    box=await pg.locator(".dpc-hit").bounding_box()
    await pg.mouse.move(box["x"]+box["width"]*0.55,box["y"]+box["height"]/2)
    await pg.wait_for_timeout(100)
    await pg.screenshot(path=f"{OUT}/mult_hover.png",full_page=True)
    print("errors:",errs)
    await b.close()
asyncio.run(main())
