/// The app is a window onto the AIO Agent console (https://agent.clawpage.ai):
/// everything runs on the server, so a console change reaches the app without a
/// new release. The remote page gets no Tauri IPC (no capability names it).
#[cfg(target_os = "macos")]
mod phone_link;

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
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    mac::install(app.handle().clone(), &window)?;
                }
            }
            #[cfg(not(any(target_os = "ios", target_os = "macos")))]
            let _ = app;
            Ok(())
        })
        .on_page_load(|_webview, _payload| {
            #[cfg(target_os = "macos")]
            mac::page_load(_payload);
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => urls.iter().for_each(|url| mac::google_return(_app, url)),
                // The phone bridge goes with the app.
                tauri::RunEvent::Exit => mac::shutdown(),
                _ => {}
            }
        });
}

/// The console pads itself for the notch and the home indicator
/// (env(safe-area-inset-*)), so the page gets the whole screen: without this,
/// WKWebView keeps it out of the bottom safe area and a white strip shows there.
#[cfg(target_os = "ios")]
fn full_screen_on_ios(webview: tauri::webview::PlatformWebview) {
    use objc2::{msg_send, runtime::{AnyClass, AnyObject}};
    // UIScrollViewContentInsetAdjustmentBehavior.never
    const NEVER: isize = 2;
    unsafe {
        let wk = webview.inner() as *mut AnyObject;
        let scroll: *mut AnyObject = msg_send![wk, scrollView];
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: NEVER];
        // Resolve Swift through Objective-C at runtime: Cargo builds its cdylib
        // before Xcode links the app's Swift sources.
        let browser = AnyClass::get(c"AIODeviceBrowser").expect("native browser bridge");
        let _: () = msg_send![browser, installDeviceBrowser: wk];
    }
}

/// macOS counterpart of the iOS/Android bridge: the console's main frame may ask for
/// an HTTP(S) URL to open in the default browser. Google refuses to sign in inside a
/// web view, so the console's native Google flow runs in the browser and comes back
/// as aioagent://auth?ticket=…, which only redeems with this web view's cookie.
#[cfg(target_os = "macos")]
mod mac {
    use objc2::{define_class, msg_send, rc::Retained, runtime::{NSObject, ProtocolObject}, MainThreadOnly};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSObjectProtocol, NSString, NSURL};
    use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView};
    use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
    use tauri::{webview::{PageLoadEvent, PageLoadPayload}, AppHandle, Manager, WebviewWindow};

    const CONSOLE: &str = "agent.clawpage.ai";
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// A return that arrived before the console installed its listener (cold start).
    static PENDING: Mutex<Option<String>> = Mutex::new(None);
    static READY: AtomicBool = AtomicBool::new(false);
    static PHONES: OnceLock<crate::phone_link::PhoneLink> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AIODeviceBrowserHandler"]
        struct Handler;

        unsafe impl NSObjectProtocol for Handler {}

        unsafe impl WKScriptMessageHandler for Handler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
                unsafe { receive(message) }
            }
        }
    );

    pub fn install(app: AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
        let _ = APP.set(app);
        // The window takes the app's name in the system language (Clawpage / 一站, from InfoPlist.strings).
        if let Some(name) = NSBundle::mainBundle().objectForInfoDictionaryKey(&NSString::from_str("CFBundleDisplayName"))
            .and_then(|name| name.downcast::<NSString>().ok()) {
            window.set_title(&name.to_string())?;
        }
        let phones = PHONES.get_or_init(|| crate::phone_link::PhoneLink::new(APP.get().unwrap().clone()));
        phones.resume();
        window.with_webview(|webview| unsafe {
            let wk: &WKWebView = &*(webview.inner() as *const WKWebView);
            let handler: Retained<Handler> = msg_send![Handler::alloc(objc2::MainThreadMarker::new().expect("main thread")), init];
            let content = wk.configuration().userContentController();
            content.addScriptMessageHandler_name(ProtocolObject::from_ref(&*handler), &NSString::from_str("aioDeviceBrowser"));
            // Linking this Mac's phones to the signed-in account (phone_link.rs).
            content.addScriptMessageHandler_name(ProtocolObject::from_ref(&*handler), &NSString::from_str("aioDeviceLink"));
        })
    }

    pub fn shutdown() {
        if let Some(phones) = PHONES.get() { phones.stop(); }
    }

    pub fn page_load(payload: &PageLoadPayload<'_>) {
        if let PageLoadEvent::Started = payload.event() { READY.store(false, Ordering::SeqCst); }
    }

    unsafe fn receive(message: &WKScriptMessage) {
        let frame = message.frameInfo();
        let origin = frame.securityOrigin();
        if !frame.isMainFrame() || origin.protocol().to_string() != "https" || origin.host().to_string() != CONSOLE
            || !matches!(origin.port(), 0 | 443) { return; }
        let Ok(body) = message.body().downcast::<NSString>() else { return };
        let body = body.to_string();
        if message.name().to_string() == "aioDeviceLink" {
            // Off the main thread: stopping a running bridge waits for it to exit.
            if let Some(phones) = PHONES.get().cloned() { std::thread::spawn(move || phones.message(&body)); }
            return;
        }
        if body == "aioagent-auth-ready" {
            READY.store(true, Ordering::SeqCst);
            if let Some(detail) = PENDING.lock().unwrap().take() { dispatch(&detail); }
            return;
        }
        let Ok(url) = url::Url::parse(&body) else { return };
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() { return; }
        if let Some(url) = NSURL::URLWithString(&NSString::from_str(url.as_str())) {
            NSWorkspace::sharedWorkspace().openURL(&url);
        }
    }

    pub fn google_return(app: &AppHandle, url: &url::Url) {
        if url.scheme() != "aioagent" || url.host_str() != Some("auth") || !matches!(url.path(), "" | "/") { return; }
        let ticket = url.query_pairs().find(|(k, _)| k == "ticket").map(|(_, v)| v.into_owned())
            .filter(|v| v.len() == 43 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        let detail = match ticket { Some(t) => format!("{{\"ticket\":\"{t}\"}}"), None => r#"{"error":"failed"}"#.into() };
        if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
        if READY.load(Ordering::SeqCst) { dispatch(&detail); } else { *PENDING.lock().unwrap() = Some(detail); }
    }

    fn dispatch(detail: &str) {
        let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else { return };
        if window.url().ok().and_then(|u| u.host_str().map(str::to_owned)).as_deref() != Some(CONSOLE) { return; }
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('aio-google-return',{{detail:{detail}}}));"));
    }
}
