#!/usr/bin/env python3
"""Check video import against WebKitGTK — the engine the desktop build runs on.

Chromium is not a proxy for this. Dizako 3.0 shipped a video import that worked
perfectly in Chromium and could not open a single clip under WebKitGTK: with a
blob: URL and `preload="auto"`, GStreamer buffers the whole clip into a
pipeline that cannot then service a seek, so the first `currentTime = x` either
fails with MEDIA_ERR_DECODE or never fires `seeked` at all. `preload="metadata"`
fixes it. Nothing in the unit suite or the Chromium smoke test can catch that
class of bug, which is what this script is for.

Runs the real import against a running dev server and reports whether each
stage completes. Needs PyGObject with WebKit2 4.1 (Arch: python-gobject,
webkit2gtk-4.1) and a display.

    pnpm dev &
    ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=10 \
           -pix_fmt yuv420p public/probe.mp4
    python tools/webkit-media-check.py probe.mp4
"""
import json
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

URL = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:1420/"
CLIP = sys.argv[1] if len(sys.argv) > 1 else "probe.mp4"

# Drives the app's own file input, so this exercises the shipping code path
# rather than a reimplementation of it.
SCRIPT = """
window.__r = { log: [], done: false, ok: false };
const say = (m) => window.__r.log.push(m);
(async () => {
  const res = await fetch('/%s');
  if (!res.ok) { say('FAIL: clip not served by the dev server'); window.__r.done = true; return; }
  const file = new File([await res.blob()], '%s', { type: 'video/mp4' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('input[type=file]');
  input.files = dt.files;
  const t0 = performance.now();
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // `.timeline__handle` and not `.timeline`: the import skeleton reuses the
  // transport's own class names so the layout does not jump, so `.timeline`
  // matches the placeholder too and reports success 14ms in. The range handles
  // exist only on the real transport, which renders once the clip is open and
  // its first frame has been decoded.
  const deadline = t0 + 30000;
  while (performance.now() < deadline) {
    if (document.querySelector('.timeline__handle')) {
      // The transport appearing is not success. A clip can import perfectly -
      // right size, duration and frame rate - and still paint an empty canvas,
      // which is exactly what a stray crossOrigin attribute did. Check the
      // pixels.
      const c = document.querySelector('canvas.preview__view');
      let opaque = 0, colours = 0;
      if (c && c.width) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 977) {
          if (d[i + 3] > 0) opaque++;
          seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        }
        colours = seen.size;
      }
      if (opaque > 0 && colours >= 2) {
        say(`OK: imported and painted in ${Math.round(performance.now() - t0)}ms (${opaque} opaque samples, ${colours} colours)`);
        window.__r.ok = true;
        break;
      }
      if (performance.now() - t0 > 12000) {
        say(`FAIL: transport rendered but the canvas is blank (opaque=${opaque} colours=${colours})`);
        break;
      }
    }
    const dialog = document.querySelector('.m3-dialog__title');
    if (dialog) { say('FAIL: import raised "' + dialog.textContent + '"'); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.__r.ok && !window.__r.log.some((l) => l.startsWith('FAIL'))) {
    say('FAIL: import never completed within 30s');
  }
  window.__r.done = true;
})().catch((e) => { say('FAIL: ' + e); window.__r.done = true; });
""" % (CLIP, CLIP)


class Check:
    def __init__(self):
        self.window = Gtk.Window(title="dizako · webkit media check")
        self.window.set_default_size(1280, 800)
        self.view = WebKit2.WebView()
        self.view.get_settings().set_enable_media(True)
        self.window.add(self.view)
        self.window.show_all()
        self.view.connect("load-changed", self.on_load)
        self.view.connect("web-process-terminated", self.on_crash)
        self.view.load_uri(URL)
        self.seen = 0
        self.ticks = 0
        self.ok = False

    def on_crash(self, _view, reason):
        print(f"FAIL: the web process died ({reason}) — this is the 'window goes white' symptom")
        Gtk.main_quit()

    def on_load(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(2000, self.start)

    def start(self):
        self.view.run_javascript(SCRIPT, None, None, None)
        GLib.timeout_add(500, self.poll)
        return False

    def poll(self):
        self.ticks += 1
        self.view.run_javascript("JSON.stringify(window.__r)", None, self.report, None)
        if self.ticks > 90:
            print("FAIL: check timed out")
            Gtk.main_quit()
            return False
        return True

    def report(self, view, result, _data):
        try:
            state = json.loads(view.run_javascript_finish(result).get_js_value().to_string())
        except Exception:  # noqa: BLE001 - the page may be mid-navigation
            return
        for line in state.get("log", [])[self.seen:]:
            print(" ", line, flush=True)
        self.seen = len(state.get("log", []))
        if state.get("done"):
            self.ok = state.get("ok", False)
            Gtk.main_quit()


print(f"checking video import under WebKitGTK ({CLIP})")
check = Check()
Gtk.main()
sys.exit(0 if check.ok else 1)
