// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Make decoded video frames readable by the canvas on Linux.
///
/// WebKitGTK's DMA-BUF renderer keeps decoded video frames in a GPU buffer the
/// canvas cannot read back. `drawImage` from a `<video>` element then yields a
/// fully transparent surface - silently, with no error and no exception - so a
/// clip imports perfectly, reports the right size, duration and frame rate, and
/// previews as an empty stage. Every readback path is affected: 2D `drawImage`,
/// `createImageBitmap`, WebGL `texImage2D` + `readPixels`, and even
/// `VideoFrame.copyTo`. Measured on a 1920x1080 H.264 clip: alpha 0..0 across
/// the whole frame with the renderer on, 255..255 with it off.
///
/// This does **not** disable GPU acceleration. Measured either way, WebGL
/// reports the same hardware renderer at identical speed; only 2D canvas
/// buffer sharing changes, costing roughly a quarter of a millisecond per
/// full-screen 1080p blit. Dizako draws one viewport-bounded blit per frame,
/// so the trade is a fraction of a frame budget against video working at all.
///
/// Set `DIZAKO_KEEP_DMABUF=1` to opt out, and an explicit
/// `WEBKIT_DISABLE_DMABUF_RENDERER` in the environment always wins.
#[cfg(target_os = "linux")]
fn prefer_readable_video_frames() {
    if std::env::var_os("DIZAKO_KEEP_DMABUF").is_some() {
        return;
    }
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: called before any window, webview or thread exists, so no
        // other thread can be reading the environment concurrently.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_readable_video_frames();

    dizako_lib::run()
}
