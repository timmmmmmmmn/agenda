//! Wat de twee apps van elkaar onderscheidt. Dezelfde app-code draait in beide bundels;
//! de bundel-id bepaalt welke app het is.

use objc2_foundation::NSBundle;

pub struct App {
    pub name: &'static str,
    pub host: &'static str,
    /// Naam van de brug in de pagina (zoals in de Android-app).
    pub bridge: &'static str,
    /// Voorvoegsel van de functies die de pagina voor de app klaarzet (agendaGlassNav, notitiesGlassPick, ...).
    pub prefix: &'static str,
    /// Komt achter de user agent (Agenda zou bij "AgendaApp/" in telefoonstand gaan).
    pub agent: &'static str,
    pub repo: &'static str,
    /// Kleuren als 0xRRGGBB.
    pub accent: u32,
    pub accent_dark: u32,
    pub add_ink: u32,
    pub bg: u32,
    pub bg_dark: u32,
    /// Hoe rond de navigatiebalk is (zoals op de website).
    pub radius: f64,
    /// Hoogte van de titelbalk. Agenda heeft de bovenbalk van de website erin (zoals een macOS-werkbalk),
    /// Notities alleen ruimte voor de verkeerslichtjes.
    pub titlebar: f64,
    pub notes: bool,
}

pub const AGENDA: App = App {
    name: "Agenda",
    host: "agenda.timvanbergen.nl",
    // De desktopversie van de website: geen brug (dan zou de pagina in telefoonstand gaan).
    bridge: "TimMac",
    prefix: "agenda",
    agent: "AgendaMac/1.0",
    repo: "https://github.com/timmmmmmmmn/agenda",
    accent: 0x0094E8,
    accent_dark: 0x39C6FF,
    add_ink: 0xFFFFFF,
    bg: 0xF2F4F8,
    bg_dark: 0x0C0E13,
    radius: 32.0,
    titlebar: 52.0,
    notes: false,
};

pub const NOTITIES: App = App {
    name: "Notities",
    host: "notities.timvanbergen.nl",
    bridge: "NotitiesNative",
    prefix: "notities",
    agent: "NotitiesApp/1.0 Mac",
    repo: "https://github.com/timmmmmmmmn/notities",
    accent: 0xA51C22,
    accent_dark: 0xF07C80,
    add_ink: 0xFBF6DC,
    bg: 0xF4F1E6,
    bg_dark: 0x141311,
    radius: 22.0,
    titlebar: 30.0,
    notes: true,
};

impl App {
    /// Uit de bundel-id, of buiten een bundel (tijdens testen) uit TIMAPP=agenda|notities.
    pub fn current() -> &'static App {
        let id = NSBundle::mainBundle().bundleIdentifier().map(|s| s.to_string());
        let which = id.or_else(|| std::env::var("TIMAPP").ok()).unwrap_or_default();
        if which.contains("agenda") { &AGENDA } else { &NOTITIES }
    }

    /// TIMAPP_URL wijst tijdens testen naar `wrangler dev`.
    pub fn home(&self) -> String {
        std::env::var("TIMAPP_URL").unwrap_or_else(|_| format!("https://{}/", self.host))
    }

    /// Alles op dit adres blijft in de app; andere sites gaan naar de browser.
    pub fn is_own(&self, host: &str) -> bool {
        host == self.host || host == "localhost" || host == "127.0.0.1"
    }
}
