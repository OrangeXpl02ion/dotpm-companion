import asyncio, sys
from playwright.async_api import async_playwright
OUT=sys.argv[1]
cases=[
 ("capacity_light",dict(tab="capacity",expanded="2026-W45")),
 ("capacity_dark",dict(tab="capacity",dark=True)),
 ("queue_light",dict(tab="queue")),
 ("types_light",dict(tab="types")),
 ("types_dark",dict(tab="types",dark=True)),
 ("categories_light",dict(tab="categories")),
 ("categories_dark",dict(tab="categories",dark=True)),
 ("mult_light",dict(tab="multipliers",today="2026-11-20",changes=[["2026-10-27","CAD",1.8],["2026-11-03","CAD",1.6],["2026-11-03","Writing",1.4],["2026-11-10","Render",1.5],["2026-11-17","Writing",1.2]])),
 ("mult_dark",dict(tab="multipliers",dark=True)),
]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
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
