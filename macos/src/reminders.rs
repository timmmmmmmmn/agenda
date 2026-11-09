//! Herinneringen van Notities als echte macOS-meldingen, ook als de app dicht is.
//! De pagina stuurt steeds de hele lijst; die vervangt alles wat er al gepland stond.

use block2::RcBlock;
use objc2::runtime::{Bool, ProtocolObject};
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound, UNTimeIntervalNotificationTrigger,
    UNUserNotificationCenter,
};
use serde_json::Value;

use crate::Host;

/// Meldingen kunnen alleen vanuit een echte app-bundel (niet bij een losse testbuild).
fn available() -> bool {
    objc2_foundation::NSBundle::mainBundle().bundleIdentifier().is_some()
}

pub fn setup(host: &Host) {
    if !available() {
        return;
    }
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(host)));
}

/// [{ id, at (ms), title, text }]
pub fn replace(list: &Value) {
    let Some(list) = list.as_array().filter(|_| available()) else { return };
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.removeAllPendingNotificationRequests();
    if list.is_empty() {
        return;
    }
    // De eerste keer vraagt macOS om toestemming; daarna gebeurt hier niets zichtbaars.
    let asked = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &asked);

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    for n in list {
        let at = n["at"].as_f64().unwrap_or(0.0);
        let id = n["id"].as_str().unwrap_or("");
        if id.is_empty() || at <= now {
            continue;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(n["title"].as_str().unwrap_or("Herinnering")));
        content.setBody(&NSString::from_str(n["text"].as_str().unwrap_or("")));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let trigger = UNTimeIntervalNotificationTrigger::triggerWithTimeInterval_repeats(((at - now) / 1000.0).max(1.0), false);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, Some(&trigger));
        center.addNotificationRequest_withCompletionHandler(&request, None);
    }
}
