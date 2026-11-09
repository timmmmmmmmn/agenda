//! Alleen voor testen: TIMAPP_STEPS=<bestand> voert stappen uit en maakt afbeeldingen van het venster.
//! Regels: `wait <sec>`, `js <code>`, `shot <naam>`, `size <b> <h>`, `spiek`, `spiekshot <naam>`, `spiekjs <code>`, `quit`. Afbeeldingen gaan naar TIMAPP_SHOTS.

use std::ffi::c_void;

use objc2::AnyThread;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSBitmapImageFileType, NSBitmapImageRep};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSDictionary;

use crate::{later, run_js, with_ui};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCreateImage(bounds: CGRect, list: u32, window: u32, image: u32) -> *mut c_void;
    fn CGImageRelease(image: *mut c_void);
}

pub fn start() {
    let Ok(path) = std::env::var("TIMAPP_STEPS") else { return };
    let steps: Vec<String> = std::fs::read_to_string(path).unwrap_or_default().lines().map(str::to_string).collect();
    later(0.5, move || step(steps, 0));
}

fn step(steps: Vec<String>, i: usize) {
    let Some(line) = steps.get(i).cloned() else { return };
    let (cmd, rest) = line.split_once(' ').unwrap_or((&line, ""));
    let mut wait = 0.05;
    match cmd {
        "wait" => wait = rest.parse().unwrap_or(1.0),
        "js" => run_js(rest),
        "shot" => shot(rest, with_ui(|ui| ui.window.windowNumber() as u32)),
        "spiek" => crate::spiek::show_on_mouse_screen(),
        "spiekjs" => crate::spiek::run_js(rest),
        "spiekshot" => shot(rest, crate::spiek::window_number()),
        "size" => {
            let n: Vec<f64> = rest.split(' ').filter_map(|v| v.parse().ok()).collect();
            with_ui(|ui| ui.window.setContentSize(CGSize::new(n[0], n[1])));
        }
        "quit" => NSApplication::sharedApplication(MainThreadMarker::new().unwrap()).terminate(None),
        _ => {}
    }
    later(wait, move || step(steps, i + 1));
}

fn shot(name: &str, id: Option<u32>) {
    let dir = std::env::var("TIMAPP_SHOTS").unwrap_or_else(|_| ".".into());
    let Some(id) = id else { return };
    let null = CGRect::new(CGPoint::new(f64::INFINITY, f64::INFINITY), CGSize::new(0.0, 0.0));
    // Alleen dit venster, zonder schaduw, op volle resolutie.
    let image = unsafe { CGWindowListCreateImage(null, 1 << 3, id, 1 | 8) };
    if image.is_null() {
        eprintln!("shot {name}: geen afbeelding");
        return;
    }
    let rep: objc2::rc::Retained<NSBitmapImageRep> =
        unsafe { objc2::msg_send![NSBitmapImageRep::alloc(), initWithCGImage: image] };
    unsafe { CGImageRelease(image) };
    let props = NSDictionary::new();
    if let Some(data) = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) } {
        let _ = std::fs::write(format!("{dir}/{name}.png"), data.to_vec());
    }
}
