"""Headless smoke test for the Dizako dev server.

Exercises the paths this session changed: still import, video import, playback,
scrubbing, frame export and the video-export dialog's capability probe.
"""
import sys, time, pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:1420/"
SHOTS = HERE / "shots"
SHOTS.mkdir(exist_ok=True)

problems = []
console_errors = []


def check(label, ok, extra=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (f"   {extra}" if extra else ""))
    if not ok:
        problems.append(label + (f" :: {extra}" if extra else ""))


def canvas_nonblank(page):
    """True when the preview canvas has drawn something other than one flat colour."""
    return page.evaluate("""() => {
      const c = document.querySelector('canvas.preview__view');
      if (!c || !c.width) return {ok:false, why:'no canvas'};
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4 * 977) {
        if (d[i+3] > 0) opaque++;
        seen.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4));
        if (seen.size > 6) break;
      }
      return {ok: opaque > 0 && seen.size >= 2, colours: seen.size, opaque, w: c.width, h: c.height};
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 1500, "height": 940})
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))

    page.goto(URL, wait_until="load")
    page.wait_for_selector("h1.topbar__title", timeout=20000)
    check("app boots", page.inner_text("h1.topbar__title") == "Dizako")
    check("empty state shown", page.locator(".empty__title").is_visible())

    # ---- still image ----
    page.set_input_files('input[type="file"]', str(HERE / "test.png"))
    page.wait_for_selector("canvas.preview__view", timeout=20000)
    time.sleep(2.0)
    r = canvas_nonblank(page)
    check("image dithers to canvas", r["ok"], str(r))
    check("HUD visible", page.locator(".preview__hud").is_visible())
    page.screenshot(path=str(SHOTS / "01-image.png"))

    # ---- canvas navigation ----
    before = page.input_value(".preview__zoom")
    page.locator(".preview__stage").click(position={"x": 400, "y": 300})
    page.keyboard.press("1")
    time.sleep(0.4)
    check("keyboard 1 sets 100%", page.input_value(".preview__zoom") == "100%", f"{before} -> {page.input_value('.preview__zoom')}")
    page.locator('.preview__hud button[title="Zoom in"]').click()
    time.sleep(0.4)
    check("zoom-in button works", page.input_value(".preview__zoom") == "140%", page.input_value(".preview__zoom"))
    page.keyboard.press("0")
    time.sleep(0.4)
    check("keyboard 0 refits to fit", page.input_value(".preview__zoom") == "100%", page.input_value(".preview__zoom"))
    page.mouse.move(500, 400)
    page.mouse.wheel(0, -600)
    time.sleep(0.4)
    check("wheel is live", page.locator(".preview__zoom").count() == 1)
    page.keyboard.press("0")
    time.sleep(0.3)

    # ---- video ----
    page.set_input_files('input[type="file"]', str(HERE / "test.mp4"))
    page.wait_for_selector(".timeline", timeout=30000)
    time.sleep(2.5)
    r = canvas_nonblank(page)
    check("video frame dithers to canvas", r["ok"], str(r))
    fps_chip = page.locator(".timeline__chip").first.inner_text()
    check("fps detected", "fps" in fps_chip, fps_chip)
    check("timecode rendered", ":" in page.locator(".timeline__time").first.inner_text())
    page.screenshot(path=str(SHOTS / "02-video.png"))

    # scrub to the middle of the clip
    box = page.locator(".timeline__track").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
    time.sleep(1.5)
    tc = page.locator(".timeline__time").first.inner_text()
    check("scrub moves the playhead", tc != "00:00.00", tc)
    r = canvas_nonblank(page)
    check("scrubbed frame renders", r["ok"], str(r))

    # playback
    page.locator('.timeline__transport button').first.click()
    time.sleep(1.6)
    playing = page.evaluate("() => !!document.querySelector('.timeline__transport button')")
    tc2 = page.locator(".timeline__time").first.inner_text()
    check("playback advances time", tc2 != tc, f"{tc} -> {tc2}")
    page.locator('.timeline__transport button').first.click()
    time.sleep(1.0)
    page.screenshot(path=str(SHOTS / "03-playing.png"))

    # ---- video export dialog + encoder probe ----
    page.locator('button[title="Export video"]').first.click()
    page.wait_for_selector(".sheet--export", timeout=8000)
    facts = page.locator(".export-facts").inner_text()
    check("export dialog shows estimates", "FRAMES" in facts.upper(), facts.replace("\n", " | "))
    formats = page.locator(".m3-segmented").first.inner_text().replace("\n", " / ")
    check("encoder probe reports formats", "PNG frames" in formats, formats)
    page.screenshot(path=str(SHOTS / "04-export-dialog.png"))

    # ---- error dialog: a file that is neither ----
    page.locator(".sheet__foot button").first.click()
    time.sleep(0.4)
    bad = HERE / "not-media.bin"
    bad.write_bytes(b"\x00\x01this is not media\xff" * 40)
    page.set_input_files('input[type="file"]', str(bad))
    page.wait_for_selector(".m3-dialog", timeout=15000)
    title = page.locator(".m3-dialog__title").inner_text()
    check("bad file raises a dialog", len(title) > 0, title)
    page.locator(".m3-dialog__disclosure").first.click()
    time.sleep(0.3)
    detail = page.locator(".m3-dialog__pre").inner_text()
    check("dialog carries diagnostics", "dizako 3.0.0" in detail, detail.splitlines()[0] if detail else "(empty)")
    page.screenshot(path=str(SHOTS / "05-error-dialog.png"))

    browser.close()

real_errors = [e for e in console_errors if "dizako" not in e.lower() or "image/" not in e]
print("\nconsole errors seen:", len(console_errors))
for e in console_errors[:12]:
    print("   ·", e[:220])

print("\n" + ("ALL CHECKS PASSED" if not problems else f"{len(problems)} FAILED:"))
for p_ in problems:
    print("  -", p_)
sys.exit(1 if problems else 0)
