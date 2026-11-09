//! Agenda en Notities als Mac-app: een AppKit-venster om de eigen website heen (zoals de
//! Android-apps), met de navigatie als echt glas en de menu's als native macOS-menu's.

mod config;
mod corner;
mod debug;
mod glass;
mod hoek;
mod icons;
mod menus;
mod reminders;
mod spiek;

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    NSApplicationActivationPolicy, NSApplicationDelegate, NSAutoresizingMaskOptions, NSBackingStoreType, NSControlStateValueOff,
    NSControlStateValueOn, NSEvent, NSMenuItem,
    NSModalResponseOK, NSOpenPanel, NSSavePanel, NSSharingServicePicker, NSTitlebarSeparatorStyle, NSView, NSWindow,
    NSToolbar, NSWindowDelegate, NSWindowStyleMask, NSWindowTitleVisibility, NSWindowToolbarStyle, NSWorkspace,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{
    ns_string, NSArray, NSBundle, NSDistributedNotificationCenter, NSNotification, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRectEdge, NSString, NSTimer, NSURL,
    NSURLAuthenticationChallenge, NSURLCredential, NSURLRequest, NSURLSessionAuthChallengeDisposition, NSUserDefaults,
};
use objc2_user_notifications::{
    UNNotification, UNNotificationPresentationOptions, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use objc2_web_kit::{
    WKFrameInfo, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType,
    WKOpenPanelParameters, WKScriptMessage, WKScriptMessageHandler, WKUIDelegate, WKUserContentController, WKUserScript,
    WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use serde_json::Value;

use config::App;

struct Ui {
    app: &'static App,
    window: Retained<NSWindow>,
    root: Retained<NSView>,
    web: Retained<WKWebView>,
    strip: Retained<DragStrip>,
    bar: glass::GlassBar,
    dark: bool,
    ready: bool,
    /// Wacht tot de pagina klaar is (bijv. een notitie openen vanuit een melding).
    pending: Option<String>,
    menu: menus::MenuState,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

fn with_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    UI.with(|ui| ui.try_borrow_mut().ok().and_then(|mut ui| ui.as_mut().map(f)))
}

/// Iets op de volgende ronde van de runloop doen (of na `seconds`), buiten de huidige callback.
pub fn later(seconds: f64, f: impl FnOnce() + 'static) {
    let f = Cell::new(Some(f));
    let block = RcBlock::new(move |_t: NonNull<NSTimer>| {
        if let Some(f) = f.take() {
            f();
        }
    });
    unsafe { NSTimer::scheduledTimerWithTimeInterval_repeats_block(seconds, false, &block) };
}

pub fn run_js(js: &str) {
    let web = with_ui(|ui| ui.web.clone());
    if let Some(web) = web {
        unsafe { web.evaluateJavaScript_completionHandler(&NSString::from_str(js), None) };
    }
}

/// In het hoofdvenster of in het spiekbriefje.
pub fn run_js_in(in_spiek: bool, js: &str) {
    if in_spiek { spiek::run_js(js) } else { run_js(js) }
}

/// Een functie die de pagina voor de app klaarzet aanroepen, bijv. call("GlassNav", "add").
pub fn call(name: &str, arg: &str) {
    call_in(false, name, arg);
}

pub fn call_in(in_spiek: bool, name: &str, arg: &str) {
    let f = format!("{}{name}", App::current().prefix);
    run_js_in(in_spiek, &format!("window.{f} && {f}({})", serde_json::to_string(arg).unwrap()));
}

fn on_tab(id: &str) {
    call("GlassNav", id);
}

fn appearance(dark: bool) -> Option<Retained<NSAppearance>> {
    NSAppearance::appearanceNamed(unsafe { if dark { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua } })
}

fn set_dark(dark: bool) {
    with_ui(|ui| {
        ui.dark = dark;
        ui.window.setAppearance(appearance(dark).as_deref());
        let bg = icons::rgb(if dark { ui.app.bg_dark } else { ui.app.bg });
        ui.window.setBackgroundColor(Some(&bg));
        unsafe { ui.web.setUnderPageBackgroundColor(Some(&bg)) };
    });
}

/// Een bericht van de pagina: { fn, args }.
fn handle(message: &str, from_spiek: bool) {
    let Ok(msg) = serde_json::from_str::<Value>(message) else { return };
    let args = msg["args"].as_array().cloned().unwrap_or_default();
    let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("").to_string();
    let json = |i: usize| serde_json::from_str::<Value>(&arg(i)).unwrap_or(Value::Null);
    let mtm = MainThreadMarker::new().unwrap();
    if from_spiek {
        // Het spiekbriefje heeft geen navigatie; herinneringen regelt het hoofdvenster al.
        match msg["fn"].as_str().unwrap_or("") {
            "setDark" => spiek::set_dark(args.first().and_then(Value::as_bool).unwrap_or(false)),
            "glassMenu" => {
                let menu = json(0);
                later(0.0, move || menus::show(mtm, menu, true));
            }
            "glassMenuItems" => menus::refresh(mtm, json(0)),
            "share" => share(mtm, &arg(0), &arg(1)),
            "ready" => spiek::ready(),
            "hide" => spiek::hide(),
            "dragHoles" => spiek::set_holes(&json(0)),
            _ => {}
        }
        return;
    }
    match msg["fn"].as_str().unwrap_or("") {
        "setDark" => set_dark(args.first().and_then(Value::as_bool).unwrap_or(false)),
        "glassBar" => {
            let bar = json(0);
            with_ui(|ui| {
                let dark = bar["dark"].as_bool().unwrap_or(ui.dark);
                let accent = icons::rgb(if dark { ui.app.accent_dark } else { ui.app.accent });
                let add_ink = icons::rgb(ui.app.add_ink);
                ui.bar.update(mtm, &bar, &accent, &add_ink, ui.app.radius);
            });
        }
        "glassMenu" => {
            let menu = json(0);
            later(0.0, move || menus::show(mtm, menu, false));
        }
        "glassMenuItems" => menus::refresh(mtm, json(0)),
        "share" => share(mtm, &arg(0), &arg(1)),
        "setReminders" => reminders::replace(&json(0)),
        "dragHoles" => {
            let holes = json(0);
            with_ui(|ui| set_holes(&ui.strip, &ui.web, &holes));
        }
        "ready" => {
            let pending = with_ui(|ui| {
                ui.ready = true;
                ui.pending.take()
            });
            if let Some(js) = pending.flatten() {
                run_js(&js);
            }
        }
        _ => {}
    }
}

/// Uitvoeren zodra de pagina klaar is.
pub fn when_ready(js: String) {
    let now = with_ui(|ui| {
        if ui.ready || !ui.app.notes {
            true
        } else {
            ui.pending = Some(js.clone());
            false
        }
    });
    if now == Some(true) {
        run_js(&js);
    }
}

/// Delen via het deelmenu van macOS. De export van alle notities wordt een bestand.
fn share(mtm: MainThreadMarker, title: &str, text: &str) {
    let app = App::current();
    if app.notes && title == "Notities" {
        let panel = NSSavePanel::savePanel(mtm);
        panel.setNameFieldStringValue(&NSString::from_str(&format!("notities-{}.md", date_stamp())));
        if panel.runModal() == NSModalResponseOK {
            if let Some(path) = panel.URL().and_then(|u| u.path()) {
                let _ = std::fs::write(path.to_string(), text);
            }
        }
        return;
    }
    let body = if title.is_empty() || text.starts_with(title) { text.to_string() } else { format!("{title}\n\n{text}") };
    let items = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(NSString::from_str(&body)))]);
    let picker = unsafe { NSSharingServicePicker::initWithItems(mtm.alloc(), &items) };
    // Bij de muis openen, in het venster waar net op Delen is geklikt (hoofdvenster of spiekbriefje).
    let Some(window) = NSApplication::sharedApplication(mtm).keyWindow().or_else(|| with_ui(|ui| ui.window.clone())) else { return };
    let Some(root) = window.contentView() else { return };
    let p = root.convertPoint_fromView(window.mouseLocationOutsideOfEventStream(), None);
    picker.showRelativeToRect_ofView_preferredEdge(CGRect::new(CGPoint::new(p.x - 1.0, p.y - 1.0), CGSize::new(2.0, 2.0)), &root, NSRectEdge::MinY);
}

/// De plekken die de pagina doorgeeft (CSS-pixels) naar punten in de strook.
pub fn set_holes(strip: &DragStrip, web: &WKWebView, holes: &Value) {
    let zoom = unsafe { web.pageZoom() };
    let rects = holes
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| {
                    let f = |k: &str| r[k].as_f64().unwrap_or(0.0) * zoom;
                    CGRect::new(CGPoint::new(f("x"), f("y")), CGSize::new(f("w"), f("h")))
                })
                .collect()
        })
        .unwrap_or_default();
    *strip.ivars().holes.borrow_mut() = rects;
}

fn date_stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86400) as i64;
    // Van dagen sinds 1970 naar jaar-maand-dag (Howard Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn open_outside(url: &NSURL) {
    NSWorkspace::sharedWorkspace().openURL(url);
}

pub struct StripIvars {
    /// Knoppen en velden van de pagina in deze strook: daar gaat een klik gewoon naar de pagina.
    holes: RefCell<Vec<CGRect>>,
}

define_class!(
    /// De titelbalk-strook: daarmee sleep je het venster (de pagina ligt eronder).
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "TimDragStrip"]
    #[ivars = StripIvars]
    pub struct DragStrip;

    impl DragStrip {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let p = self.convertPoint_fromView(point, unsafe { self.superview() }.as_deref());
            let b = self.bounds();
            let inside = p.x >= 0.0 && p.y >= 0.0 && p.x <= b.size.width && p.y <= b.size.height;
            let on_page = self.ivars().holes.borrow().iter().any(|r| {
                p.x >= r.origin.x && p.x <= r.origin.x + r.size.width && p.y >= r.origin.y && p.y <= r.origin.y + r.size.height
            });
            if inside && !on_page { self as *const Self as *mut NSView } else { std::ptr::null_mut() }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let Some(window) = self.window() else { return };
            if event.clickCount() == 2 {
                window.performZoom(None);
            } else {
                window.performWindowDragWithEvent(event);
            }
        }
    }
);

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "TimRootView"]
    pub struct RootView;

    impl RootView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

define_class!(
    /// Doet alles wat de app voor de pagina, het venster en de menubalk regelt.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TimHost"]
    pub struct Host;

    impl Host {
        /// Menubalk: het stukje JavaScript dat aan het menu-item hangt.
        #[unsafe(method(runScript:))]
        fn run_script(&self, sender: &NSMenuItem) {
            if let Some(js) = sender.representedObject().and_then(|o| o.downcast::<NSString>().ok()) {
                show_window();
                run_js(&js.to_string());
            }
        }

        #[unsafe(method(openPath:))]
        fn open_path(&self, sender: &NSMenuItem) {
            if let Some(path) = sender.representedObject().and_then(|o| o.downcast::<NSString>().ok()) {
                show_window();
                let app = App::current();
                let base = app.home();
                load(&format!("{}{}", base.trim_end_matches('/'), path));
            }
        }

        #[unsafe(method(openSource:))]
        fn open_source(&self, _sender: Option<&AnyObject>) {
            if let Some(url) = NSURL::URLWithString(&NSString::from_str(App::current().repo)) {
                open_outside(&url);
            }
        }

        #[unsafe(method(reloadPage:))]
        fn reload_page(&self, _sender: Option<&AnyObject>) {
            with_ui(|ui| unsafe { ui.web.reload() });
        }

        #[unsafe(method(zoomIn:))]
        fn zoom_in(&self, _sender: Option<&AnyObject>) {
            zoom_by(1.1);
        }

        #[unsafe(method(zoomOut:))]
        fn zoom_out(&self, _sender: Option<&AnyObject>) {
            zoom_by(1.0 / 1.1);
        }

        #[unsafe(method(zoomReset:))]
        fn zoom_reset(&self, _sender: Option<&AnyObject>) {
            zoom_by(0.0);
        }

        #[unsafe(method(menuPick:))]
        fn menu_pick(&self, sender: &NSMenuItem) {
            menus::picked(sender.tag());
        }

        #[unsafe(method(showSpiek:))]
        fn show_spiek(&self, _sender: Option<&AnyObject>) {
            spiek::show_on_mouse_screen();
        }

        #[unsafe(method(toggleCorner:))]
        fn toggle_corner(&self, _sender: Option<&AnyObject>) {
            spiek::set_corner(!spiek::corner_enabled());
        }

        /// Seintje van het hulpje NotitiesHoek: de muis staat in de hoek.
        #[unsafe(method(spiekFromCorner:))]
        fn spiek_from_corner(&self, _n: &NSNotification) {
            spiek::show_on_mouse_screen();
        }

        /// Vinkjes in de menubalk bijwerken als het menu opengaat.
        #[unsafe(method(validateMenuItem:))]
        fn validate_menu_item(&self, item: &NSMenuItem) -> bool {
            let on = match item.action() {
                Some(a) if a == sel!(toggleCorner:) => Some(spiek::corner_enabled()),
                _ => None,
            };
            if let Some(on) = on {
                item.setState(if on { NSControlStateValueOn } else { NSControlStateValueOff });
            }
            true
        }
    }

    unsafe impl NSObjectProtocol for Host {}

    unsafe impl NSApplicationDelegate for Host {
        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn should_reopen(&self, app: &NSApplication, _visible: bool) -> bool {
            // Gestart bij het inloggen (zonder venster en Dock-icoon): nu wordt het een gewone app.
            app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
            show_window();
            true
        }

        #[unsafe(method(applicationDidBecomeActive:))]
        fn did_become_active(&self, _n: &NSNotification) {
            // Net als op de telefoon: terug in beeld is meteen bijwerken.
            run_js("document.dispatchEvent(new Event('visibilitychange'))");
        }
    }

    unsafe impl NSWindowDelegate for Host {
        /// Sluiten verbergt het venster alleen; de app (en wat je aan het doen was) blijft.
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, window: &NSWindow) -> bool {
            if spiek::is_panel(window) {
                spiek::hide();
            } else {
                window.orderOut(None);
            }
            false
        }

        /// Ergens anders klikken zet het spiekbriefje weg.
        #[unsafe(method(windowDidResignKey:))]
        fn window_did_resign_key(&self, notification: &NSNotification) {
            let window = notification.object().and_then(|o| o.downcast::<NSWindow>().ok());
            if window.is_some_and(|w| spiek::is_panel(&w)) {
                spiek::hide();
            }
        }
    }

    unsafe impl WKScriptMessageHandler for Host {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            let body = unsafe { message.body() };
            let from_spiek = unsafe { message.name() }.to_string() == "spiek";
            if let Ok(text) = body.downcast::<NSString>() {
                handle(&text.to_string(), from_spiek);
            }
        }
    }

    unsafe impl WKNavigationDelegate for Host {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(&self, _web: &WKWebView, action: &WKNavigationAction, decision: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            let url = unsafe { action.request() }.URL();
            let own = url.as_ref().is_none_or(|url| {
                let scheme = url.scheme().map(|s| s.to_string()).unwrap_or_default();
                let host = url.host().map(|s| s.to_string()).unwrap_or_default();
                !matches!(scheme.as_str(), "http" | "https") || App::current().is_own(&host)
            });
            let user_click = unsafe { action.navigationType() } == WKNavigationType::LinkActivated;
            let main_frame = unsafe { action.targetFrame() }.is_some_and(|f| unsafe { f.isMainFrame() });
            if !own && (user_click || main_frame) {
                if let Some(url) = url {
                    open_outside(&url);
                }
                decision.call((WKNavigationActionPolicy::Cancel,));
            } else {
                decision.call((WKNavigationActionPolicy::Allow,));
            }
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web: &WKWebView, _nav: Option<&WKNavigation>) {
            with_ui(|ui| {
                if std::ptr::eq(&*ui.web, web) {
                    ui.ready = false;
                    ui.bar.hide();
                }
            });
            spiek::did_start(web);
        }

        /// Alleen tijdens testen tegen `wrangler dev` (TIMAPP_URL): diens eigen certificaat op localhost vertrouwen.
        #[unsafe(method(webView:didReceiveAuthenticationChallenge:completionHandler:))]
        fn auth_challenge(
            &self,
            _web: &WKWebView,
            challenge: &NSURLAuthenticationChallenge,
            done: &DynBlock<dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential)>,
        ) {
            let space = challenge.protectionSpace();
            let local = matches!(space.host().to_string().as_str(), "localhost" | "127.0.0.1");
            if local && std::env::var("TIMAPP_URL").is_ok() {
                let trust: *mut AnyObject = unsafe { msg_send![&*space, serverTrust] };
                if !trust.is_null() {
                    let credential: *mut NSURLCredential = unsafe { msg_send![objc2::class!(NSURLCredential), credentialForTrust: trust] };
                    done.call((NSURLSessionAuthChallengeDisposition::UseCredential, credential));
                    return;
                }
            }
            done.call((NSURLSessionAuthChallengeDisposition::PerformDefaultHandling, std::ptr::null_mut()));
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn did_terminate(&self, web: &WKWebView) {
            unsafe { web.reload() };
        }
    }

    unsafe impl WKUIDelegate for Host {
        /// target="_blank" en window.open: naar de browser.
        #[unsafe(method(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _web: &WKWebView,
            _config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> *mut WKWebView {
            if let Some(url) = unsafe { action.request() }.URL() {
                open_outside(&url);
            }
            std::ptr::null_mut()
        }

        /// Een bestand kiezen (bijv. een .ics importeren).
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            _web: &WKWebView,
            params: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            let mtm = MainThreadMarker::new().unwrap();
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseFiles(true);
            panel.setCanChooseDirectories(false);
            panel.setAllowsMultipleSelection(unsafe { params.allowsMultipleSelection() });
            if panel.runModal() == NSModalResponseOK {
                let urls = panel.URLs();
                done.call((Retained::as_ptr(&urls) as *mut _,));
            } else {
                done.call((std::ptr::null_mut(),));
            }
        }
    }

    unsafe impl UNUserNotificationCenterDelegate for Host {
        /// Ook een melding laten zien als de app voorop staat.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::Sound | UNNotificationPresentationOptions::List,));
        }

        /// Op een melding geklikt: die notitie openen.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
            let id = response.notification().request().identifier().to_string();
            show_window();
            when_ready(format!("window.notitiesOpen && notitiesOpen({})", serde_json::to_string(&id).unwrap()));
            done.call(());
        }
    }
);

impl Host {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn show_window() {
    let mtm = MainThreadMarker::new().unwrap();
    with_ui(|ui| ui.window.makeKeyAndOrderFront(None));
    NSApplication::sharedApplication(mtm).activate();
}

fn load(url: &str) {
    let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else { return };
    with_ui(|ui| unsafe { ui.web.loadRequest(&NSURLRequest::requestWithURL(&url)) });
}

fn zoom_by(factor: f64) {
    with_ui(|ui| {
        let zoom = if factor == 0.0 { 1.0 } else { (unsafe { ui.web.pageZoom() } * factor).clamp(0.6, 2.0) };
        unsafe { ui.web.setPageZoom(zoom) };
        NSUserDefaults::standardUserDefaults().setDouble_forKey(zoom, ns_string!("zoom"));
    });
}

/// Een pagina met de brug en de Mac-stijl erin, met een sleepstrook bovenaan. `handler` is "tim" of "spiek".
pub fn make_page(
    mtm: MainThreadMarker,
    app: &App,
    host: &Host,
    handler: &str,
    frame: CGRect,
) -> (Retained<NSView>, Retained<WKWebView>, Retained<DragStrip>) {
    let root: Retained<RootView> = unsafe { msg_send![RootView::alloc(mtm), initWithFrame: frame] };
    let root: Retained<NSView> = Retained::into_super(root);

    // De brug en de Mac-stijl zitten al in de pagina voordat haar eigen scripts draaien.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let content = unsafe { config.userContentController() };
    let bridge = include_str!("bridge.js").replace("__BRIDGE__", app.bridge).replace("__TOP__", &app.titlebar.to_string())
        .replace("__STRIP__", &app.titlebar.to_string())
        .replace("__HANDLER__", handler);
    let style_js = format!(
        "(function(){{var s=document.createElement('style');s.textContent={};document.documentElement.appendChild(s);}})();",
        serde_json::to_string(include_str!("mac.css")).unwrap()
    );
    let extra = if handler == "spiek" { include_str!("spiek.js").to_string() } else { String::new() };
    for source in [bridge, style_js, extra] {
        let script = unsafe {
            WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&source),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            )
        };
        unsafe { content.addUserScript(&script) };
    }
    unsafe { content.addScriptMessageHandler_name(ProtocolObject::from_ref(host), &NSString::from_str(handler)) };
    unsafe { config.setApplicationNameForUserAgent(Some(&NSString::from_str(app.agent))) };

    let web = unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    web.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
    unsafe {
        // Geen witte flits bij het laden: het venster heeft de kleur van de pagina.
        let _: () = msg_send![&web, setValue: &*NSNumber::new_bool(false), forKey: ns_string!("drawsBackground")];
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(host)));
        web.setUIDelegate(Some(ProtocolObject::from_ref(host)));
        web.setAllowsBackForwardNavigationGestures(false);
        web.setAllowsMagnification(false);
        web.setInspectable(true);
        let zoom = NSUserDefaults::standardUserDefaults().doubleForKey(ns_string!("zoom"));
        if zoom > 0.0 {
            web.setPageZoom(zoom);
        }
    }
    root.addSubview(&web);

    let strip = mtm.alloc::<DragStrip>().set_ivars(StripIvars { holes: RefCell::new(Vec::new()) });
    let strip: Retained<DragStrip> =
        unsafe { msg_send![super(strip), initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::new(frame.size.width, app.titlebar))] };
    strip.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
    root.addSubview(&strip);
    (root, web, strip)
}

fn build_window(mtm: MainThreadMarker, app: &'static App, host: &Host) -> Ui {
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(1100.0, 760.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(mtm.alloc(), frame, style, NSBackingStoreType::Buffered, false)
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(app.name));
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    window.setMinSize(CGSize::new(380.0, 520.0));
    window.center();
    window.setFrameAutosaveName(ns_string!("Hoofdvenster"));
    window.setDelegate(Some(ProtocolObject::from_ref(host)));
    window.setTabbingMode(objc2_app_kit::NSWindowTabbingMode::Disallowed);

    let (root, web, strip) = make_page(mtm, app, host, "tim", frame);
    if app.titlebar > 40.0 {
        // Een lege werkbalk maakt de titelbalk hoog, met de verkeerslichtjes in het midden: daar past de bovenbalk van de site in.
        let toolbar = NSToolbar::initWithIdentifier(mtm.alloc(), ns_string!("Hoofd"));
        window.setToolbar(Some(&toolbar));
        window.setToolbarStyle(NSWindowToolbarStyle::Unified);
    }
    let bar = glass::GlassBar::new(mtm, &root, on_tab);
    window.setContentView(Some(&root));

    Ui { app, window, root, web, strip, bar, dark: false, ready: false, pending: None, menu: menus::MenuState::default() }
}

fn main() {
    let mtm = MainThreadMarker::new().expect("moet op de hoofdthread draaien");
    if NSBundle::mainBundle().bundleIdentifier().is_some_and(|id| id.to_string().ends_with(".hoek")) {
        hoek::run(mtm);
        return;
    }
    let app = App::current();
    let ns_app = NSApplication::sharedApplication(mtm);
    ns_app.setActivationPolicy(NSApplicationActivationPolicy::Regular);

    let host = Host::new(mtm);
    ns_app.setDelegate(Some(ProtocolObject::from_ref(&*host)));
    menus::main_menu(mtm, app, &host);

    // Bij het inloggen gestart (voor het spiekbriefje): stil op de achtergrond, zonder venster.
    let background = std::env::args().any(|a| a == "--achtergrond");
    if background {
        ns_app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    }
    let ui = build_window(mtm, app, &host);
    UI.with(|cell| *cell.borrow_mut() = Some(ui));
    let system_dark = NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleInterfaceStyle"))
        .is_some_and(|s| s.to_string() == "Dark");
    set_dark(system_dark);
    if app.notes {
        reminders::setup(&host);
        spiek::setup(mtm, app, &host);
        unsafe {
            NSDistributedNotificationCenter::defaultCenter().addObserver_selector_name_object(
                &host,
                sel!(spiekFromCorner:),
                Some(&NSString::from_str(hoek::SHOW)),
                None,
            )
        };
        // Door het hulpje gestart omdat de muis in de hoek stond.
        if std::env::args().any(|a| a == "--spiek") {
            later(0.05, spiek::show_on_mouse_screen);
        }
    }
    load(&app.home());
    if !background {
        show_window();
    }
    debug::start();

    std::mem::forget(host);
    ns_app.run();
}
