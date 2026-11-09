//! De hoek rechtsonder van een scherm in de gaten houden. Alleen de muisplek opvragen
//! (tien keer per seconde), daar is geen toestemming voor nodig.

use std::cell::Cell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSScreen};
use objc2_foundation::{ns_string, NSRect, NSRunLoop, NSRunLoopCommonModes, NSString, NSTimer, NSUserDefaults};

/// Hoe ver van de rand de muis mag zijn om "in de hoek" te tellen, en hoe lang hij daar moet blijven.
const CORNER: f64 = 4.0;
const DWELL: f64 = 0.15;
/// Pas weer opnieuw als de muis eerst zo ver uit de hoek is geweest.
const AWAY: f64 = 80.0;
const TICK: f64 = 0.1;

/// De instellingen van Notities, ook als het hulpje ze leest (dat heeft een eigen bundel-id).
fn prefs() -> objc2::rc::Retained<NSUserDefaults> {
    NSUserDefaults::initWithSuiteName(NSUserDefaults::alloc(), Some(&NSString::from_str("nl.timvanbergen.notities")))
        .unwrap_or_else(NSUserDefaults::standardUserDefaults)
}

pub fn enabled() -> bool {
    !prefs().boolForKey(ns_string!("spiekHoekUit"))
}

pub fn set_enabled(on: bool) {
    prefs().setBool_forKey(!on, ns_string!("spiekHoekUit"));
}

/// Roept `on_hit` aan met het bruikbare deel van het scherm zodra de muis even in de hoek staat.
pub fn watch(mtm: MainThreadMarker, on_hit: fn(NSRect)) {
    let armed = Cell::new(true);
    let dwell = Cell::new(0.0);
    let block = RcBlock::new(move |_t: NonNull<NSTimer>| {
        if !enabled() || NSEvent::pressedMouseButtons() != 0 {
            return;
        }
        let p = NSEvent::mouseLocation();
        let mut hit: Option<NSRect> = None;
        let mut near = false;
        for screen in NSScreen::screens(mtm).iter() {
            let f = screen.frame();
            let inside =
                p.x >= f.origin.x && p.x <= f.origin.x + f.size.width && p.y >= f.origin.y && p.y <= f.origin.y + f.size.height;
            if !inside {
                continue;
            }
            let from_right = f.origin.x + f.size.width - p.x;
            let from_bottom = p.y - f.origin.y;
            if from_right <= CORNER && from_bottom <= CORNER {
                hit = Some(screen.visibleFrame());
            }
            near |= from_right < AWAY && from_bottom < AWAY;
        }
        match hit {
            Some(area) => {
                dwell.set(dwell.get() + TICK);
                if armed.get() && dwell.get() >= DWELL {
                    armed.set(false);
                    on_hit(area);
                }
            }
            None if !near => {
                armed.set(true);
                dwell.set(0.0);
            }
            None => {}
        }
    });
    let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(TICK, true, &block) };
    unsafe { NSRunLoop::currentRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
}
