use tauri::Manager;

/// WebKitGTK handles trackpad/touch pinch with a private GtkGestureZoom before
/// any page script runs, so JS `preventDefault` cannot stop UI page-zoom on
/// Linux. Strip WebKit's handlers, clamp `zoom-level`, and forward the pinch
/// scale to the frontend as `dizako-pinch` so only the canvas zooms.
#[cfg(target_os = "linux")]
fn disable_linux_page_zoom(web_view: webkit2gtk::WebView) {
    use std::cell::Cell;
    use std::rc::Rc;

    use glib::object::Cast;
    use glib::translate::{from_glib_none, ToGlibPtr};
    use glib::ObjectExt;
    use gtk::prelude::GestureExt;
    use gtk::GestureZoom;
    use webkit2gtk::WebViewExt;

    web_view.set_zoom_level(1.0);
    web_view.connect_notify(Some("zoom-level"), |view, _| {
        if (view.zoom_level() - 1.0).abs() > 0.001 {
            view.set_zoom_level(1.0);
        }
    });

    unsafe {
        let object = web_view.upcast_ref::<glib::Object>();
        let gesture_ptr = gobject_sys::g_object_get_data(
            object.to_glib_none().0,
            c"wk-view-zoom-gesture".as_ptr() as *const _,
        ) as *mut gtk::ffi::GtkGestureZoom;

        if gesture_ptr.is_null() {
            return;
        }

        // Drop WebKit's scale-changed handlers; keep the gesture object so we
        // can drive canvas zoom ourselves without page-zoom side effects.
        gobject_sys::g_signal_handlers_destroy(gesture_ptr as *mut _);

        let gesture: GestureZoom = from_glib_none(gesture_ptr);
        let last = Rc::new(Cell::new(1.0_f64));
        let last_begin = last.clone();
        gesture.connect_begin(move |_, _| {
            last_begin.set(1.0);
        });

        let view = web_view.clone();
        gesture.connect_scale_changed(move |_, scale| {
            let prev = last.get();
            if prev <= 0.0 || !prev.is_finite() || !scale.is_finite() || scale <= 0.0 {
                last.set(scale);
                return;
            }
            let factor = scale / prev;
            last.set(scale);
            if (factor - 1.0).abs() < 0.000_5 {
                return;
            }
            let script = format!(
                "window.dispatchEvent(new CustomEvent('dizako-pinch',{{detail:{{factor:{factor}}}}}));"
            );
            view.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
        });
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    #[cfg(target_os = "linux")]
                    disable_linux_page_zoom(webview.inner());
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dizako");
}
