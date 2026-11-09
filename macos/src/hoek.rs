//! NotitiesHoek: het hulpje in Notities.app dat altijd draait (ook als Notities dicht is) en alleen
//! de hoek rechtsonder in de gaten houdt. Daar gaat de muis heen? Dan het spiekbriefje van
//! Notities laten zien, en Notities eerst stil starten als die nog niet draait.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSDistributedNotificationCenter, NSRect, NSString};

pub const NOTITIES: &str = "nl.timvanbergen.notities";
/// Het seintje van het hulpje naar een draaiende Notities.
pub const SHOW: &str = "nl.timvanbergen.notities.spiek";

pub fn run(mtm: MainThreadMarker) {
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    crate::corner::watch(mtm, on_hit);
    // Testen zonder de muis te verplaatsen: doen alsof hij nu in de hoek staat.
    if std::env::args().any(|a| a == "--nu") {
        crate::later(0.2, || on_hit(NSRect::ZERO));
    }
    app.run();
}

fn on_hit(_area: NSRect) {
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(NOTITIES));
    if !running.is_empty() {
        unsafe {
            NSDistributedNotificationCenter::defaultCenter().postNotificationName_object_userInfo_deliverImmediately(
                &NSString::from_str(SHOW),
                None,
                None,
                true,
            )
        };
        return;
    }
    // Notities is dicht: stil starten (geen venster, geen Dock-icoon), met het spiekbriefje meteen open.
    let workspace = NSWorkspace::sharedWorkspace();
    let Some(url) = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(NOTITIES)) else { return };
    let config = NSWorkspaceOpenConfiguration::configuration();
    config.setActivates(false);
    config.setArguments(&NSArray::from_retained_slice(&[NSString::from_str("--achtergrond"), NSString::from_str("--spiek")]));
    workspace.openApplicationAtURL_configuration_completionHandler(&url, &config, None);
}
