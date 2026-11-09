//! Het spiekbriefje van Notities: ga met de muis in de hoek rechtsonder van een scherm staan en er
//! schuift een klein zwevend venster in met altijd dezelfde notitie (de hoek zelf: corner.rs en hoek.rs). Typen kan meteen, zonder dat de
//! app naar voren komt; ergens anders klikken of Esc zet het weer weg.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{
    NSAnimatablePropertyContainer, NSAnimationContext, NSAppearanceCustomization, NSBackingStoreType, NSEvent,
    NSFloatingWindowLevel, NSPanel, NSScreen, NSTitlebarSeparatorStyle, NSView, NSWindow, NSWindowButton,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{ns_string, NSRect, NSString, NSURL, NSURLRequest, NSUserDefaults};
use objc2_web_kit::WKWebView;

use crate::config::App;
use crate::{appearance, icons, make_page, Host};

const MARGIN: f64 = 14.0;

struct Spiek {
    panel: Retained<NSPanel>,
    root: Retained<NSView>,
    strip: Retained<crate::DragStrip>,
    web: Retained<WKWebView>,
    bg: (u32, u32),
    ready: bool,
    shown: bool,
}

thread_local! {
    static SPIEK: RefCell<Option<Spiek>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut Spiek) -> R) -> Option<R> {
    SPIEK.with(|s| s.try_borrow_mut().ok().and_then(|mut s| s.as_mut().map(f)))
}

pub fn setup(mtm: MainThreadMarker, app: &App, host: &Host) {
    let defaults = NSUserDefaults::standardUserDefaults();
    let w = defaults.doubleForKey(ns_string!("spiekBreedte"));
    let h = defaults.doubleForKey(ns_string!("spiekHoogte"));
    let size = CGSize::new(if w > 0.0 { w } else { 380.0 }, if h > 0.0 { h } else { 460.0 });
    let frame = CGRect::new(CGPoint::ZERO, size);
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView
        | NSWindowStyleMask::NonactivatingPanel;
    let panel: Retained<NSPanel> = unsafe {
        msg_send![mtm.alloc::<NSPanel>(), initWithContentRect: frame, styleMask: style, backing: NSBackingStoreType::Buffered, defer: false]
    };
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(false);
    panel.setHidesOnDeactivate(false);
    panel.setLevel(NSFloatingWindowLevel);
    panel.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
    panel.setTitle(ns_string!("Spiekbriefje"));
    panel.setTitlebarAppearsTransparent(true);
    panel.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    panel.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    panel.setMinSize(CGSize::new(280.0, 260.0));
    for button in [NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
        if let Some(b) = panel.standardWindowButton(button) {
            b.setHidden(true);
        }
    }
    panel.setDelegate(Some(ProtocolObject::from_ref(host)));

    let (root, web, strip) = make_page(mtm, app, host, "spiek", frame);
    panel.setContentView(Some(&root));
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(&app.home())) {
        unsafe { web.loadRequest(&NSURLRequest::requestWithURL(&url)) };
    }
    SPIEK.with(|s| {
        *s.borrow_mut() = Some(Spiek {
            panel,
            root,
            strip,
            web,
            bg: (app.bg, app.bg_dark),
            ready: false,
            shown: false,
        })
    });
    set_dark(NSUserDefaults::standardUserDefaults().stringForKey(ns_string!("AppleInterfaceStyle")).is_some_and(|s| s.to_string() == "Dark"));

    // Het hulpje NotitiesHoek houdt de hoek in de gaten (ook als Notities dicht is) en geeft een seintje.
    // Zonder hulpje (bijv. tijdens testen) doet Notities het zelf.
    if !helper_installed() {
        crate::corner::watch(mtm, show);
    }
}

fn helper_installed() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join("Library/LaunchAgents/nl.timvanbergen.notities.hoek.plist").exists()
}

/// Vanuit het menu: rechtsonder op het scherm waar de muis is.
pub fn show_on_mouse_screen() {
    let mtm = MainThreadMarker::new().unwrap();
    let p = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    let screen = screens.iter().find(|s| {
        let f = s.frame();
        p.x >= f.origin.x && p.x <= f.origin.x + f.size.width && p.y >= f.origin.y && p.y <= f.origin.y + f.size.height
    });
    if let Some(area) = screen.map(|s| s.visibleFrame()).or_else(|| NSScreen::mainScreen(mtm).map(|s| s.visibleFrame())) {
        show(area);
    }
}

pub fn show(area: NSRect) {
    let Some((panel, ready, was_shown)) = with(|s| {
        let was = s.shown;
        s.shown = true;
        (s.panel.clone(), s.ready, was)
    }) else {
        return;
    };
    let size = panel.frame().size;
    let end = CGRect::new(
        CGPoint::new(area.origin.x + area.size.width - size.width - MARGIN, area.origin.y + MARGIN),
        size,
    );
    if !was_shown || !panel.isVisible() {
        // Vanuit de hoek omhoog schuiven en infaden.
        panel.setAlphaValue(0.0);
        panel.setFrame_display(CGRect::new(CGPoint::new(end.origin.x + 18.0, end.origin.y - 24.0), size), false);
    }
    panel.makeKeyAndOrderFront(None);
    let moving = panel.clone();
    let settle = Cell::new(Some(panel));
    NSAnimationContext::runAnimationGroup_completionHandler(
        &RcBlock::new(move |ctx: NonNull<NSAnimationContext>| {
            unsafe { ctx.as_ref() }.setDuration(0.22);
            moving.animator().setFrame_display(end, true);
            moving.animator().setAlphaValue(1.0);
        }),
        // Een animatie kan onderbroken worden; daarna staat hij hoe dan ook goed.
        Some(&RcBlock::new(move || {
            if let Some(panel) = settle.take() {
                if with(|s| s.shown).unwrap_or(false) {
                    panel.setAlphaValue(1.0);
                    panel.setFrame_display(end, true);
                }
            }
        })),
    );
    if ready {
        run_js("window.timSpiekOpen && timSpiekOpen()");
    }
}

pub fn hide() {
    let Some(panel) = with(|s| {
        if !s.shown {
            return None;
        }
        s.shown = false;
        Some(s.panel.clone())
    })
    .flatten() else {
        return;
    };
    let defaults = NSUserDefaults::standardUserDefaults();
    let size = panel.frame().size;
    defaults.setDouble_forKey(size.width, ns_string!("spiekBreedte"));
    defaults.setDouble_forKey(size.height, ns_string!("spiekHoogte"));
    let fading = panel.clone();
    let done = Cell::new(Some(panel));
    NSAnimationContext::runAnimationGroup_completionHandler(
        &RcBlock::new(move |ctx: NonNull<NSAnimationContext>| {
            unsafe { ctx.as_ref() }.setDuration(0.16);
            fading.animator().setAlphaValue(0.0);
        }),
        Some(&RcBlock::new(move || {
            // Intussen weer opgeroepen? Dan laten staan.
            if let Some(panel) = done.take() {
                if with(|s| !s.shown).unwrap_or(true) {
                    panel.orderOut(None);
                }
            }
        })),
    );
}

/// De pagina is geladen (en ingelogd): de vaste notitie alvast openen.
pub fn ready() {
    with(|s| s.ready = true);
    run_js("window.timSpiekOpen && timSpiekOpen()");
}

pub fn did_start(web: &WKWebView) {
    with(|s| {
        if std::ptr::eq(&*s.web, web) {
            s.ready = false;
        }
    });
}

pub fn run_js(js: &str) {
    if let Some(web) = with(|s| s.web.clone()) {
        unsafe { web.evaluateJavaScript_completionHandler(&NSString::from_str(js), None) };
    }
}

pub fn set_holes(holes: &serde_json::Value) {
    with(|s| crate::set_holes(&s.strip, &s.web, holes));
}

pub fn root() -> Option<Retained<NSView>> {
    with(|s| s.root.clone())
}

pub fn window_number() -> Option<u32> {
    with(|s| s.panel.windowNumber() as u32)
}

pub fn is_panel(window: &NSWindow) -> bool {
    with(|s| std::ptr::eq(&**s.panel as *const NSWindow, window)).unwrap_or(false)
}

pub fn set_dark(dark: bool) {
    with(|s| {
        s.panel.setAppearance(appearance(dark).as_deref());
        let bg = icons::rgb(if dark { s.bg.1 } else { s.bg.0 });
        s.panel.setBackgroundColor(Some(&bg));
        unsafe { s.web.setUnderPageBackgroundColor(Some(&bg)) };
    });
}

// ---------- Instellingen in de menubalk ----------

pub fn corner_enabled() -> bool {
    crate::corner::enabled()
}

pub fn set_corner(on: bool) {
    crate::corner::set_enabled(on);
}
