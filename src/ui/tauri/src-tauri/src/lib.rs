/// The app is a window onto the AIO Agent console (https://agent.clawpage.ai):
/// everything runs on the server, so a console change reaches the app without a
/// new release. The remote page gets no Tauri IPC (no capability names it).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(full_screen_on_ios)?;
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The console pads itself for the notch and the home indicator
/// (env(safe-area-inset-*)), so the page gets the whole screen: without this,
/// WKWebView keeps it out of the bottom safe area and a white strip shows there.
#[cfg(target_os = "ios")]
fn full_screen_on_ios(webview: tauri::webview::PlatformWebview) {
    use objc2::{msg_send, runtime::AnyObject};
    // UIScrollViewContentInsetAdjustmentBehavior.never
    const NEVER: isize = 2;
    unsafe {
        let wk = webview.inner() as *mut AnyObject;
        let scroll: *mut AnyObject = msg_send![wk, scrollView];
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: NEVER];
    }
}
