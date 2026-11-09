//! Menu's: wat de pagina als glazen menu vraagt wordt een echt macOS-menu (dat is op de Mac al glas),
//! en de menubalk met de gebruikelijke sneltoetsen.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSAppearanceCustomization, NSApplication, NSColor, NSControlStateValueOn, NSEventModifierFlags, NSForegroundColorAttributeName, NSMenu, NSMenuItem};
use objc2_core_foundation::CGRect;
use objc2_foundation::{NSAttributedString, NSDictionary, NSPoint, NSString};
use serde_json::Value;

use crate::config::App;
use crate::{appearance, call_in, icons, with_ui, Host};

#[derive(Default)]
pub struct MenuState {
    rect: CGRect,
    dark: bool,
    items: Vec<Value>,
    picked: Option<isize>,
    /// Het menu hoort bij het spiekbriefje in plaats van bij het hoofdvenster.
    spiek: bool,
    /// Een keuze die het menu open hoort te houden (thema, agenda aan/uit): opnieuw tonen
    /// zodra de pagina de nieuwe rijen stuurt.
    reopen: bool,
}

/// { x, y, w, h, dark, items: [{ id, title, subtitle, icon, color, checked, destructive, disabled, separator, heading, keepOpen }] }
pub fn show(mtm: MainThreadMarker, menu: Value, spiek: bool) {
    let f = |k: &str| menu[k].as_f64().unwrap_or(0.0);
    with_ui(|ui| {
        ui.menu.rect = CGRect::new(objc2_core_foundation::CGPoint::new(f("x"), f("y")), objc2_core_foundation::CGSize::new(f("w"), f("h")));
        ui.menu.dark = menu["dark"].as_bool().unwrap_or(ui.dark);
        ui.menu.items = menu["items"].as_array().cloned().unwrap_or_default();
        ui.menu.reopen = false;
        ui.menu.spiek = spiek;
    });
    pop_up(mtm);
}

/// Nieuwe rijen terwijl het menu (bijna) open staat.
pub fn refresh(mtm: MainThreadMarker, menu: Value) {
    let again = with_ui(|ui| {
        ui.menu.items = menu["items"].as_array().cloned().unwrap_or_default();
        ui.menu.dark = menu["dark"].as_bool().unwrap_or(ui.menu.dark);
        std::mem::take(&mut ui.menu.reopen)
    });
    if again == Some(true) {
        crate::later(0.0, move || pop_up(mtm));
    }
}

pub fn picked(tag: isize) {
    with_ui(|ui| ui.menu.picked = Some(tag));
}

fn pop_up(mtm: MainThreadMarker) {
    let Some((main_root, rect, dark, items, in_spiek)) = with_ui(|ui| {
        ui.menu.picked = None;
        (ui.root.clone(), ui.menu.rect, ui.menu.dark, ui.menu.items.clone(), ui.menu.spiek)
    }) else {
        return;
    };
    let Some(root) = (if in_spiek { crate::spiek::root() } else { Some(main_root) }) else { return };
    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);
    menu.setAppearance(appearance(dark).as_deref());
    for (i, row) in items.iter().enumerate() {
        let s = |k: &str| row[k].as_str().unwrap_or("").to_string();
        let b = |k: &str| row[k].as_bool().unwrap_or(false);
        if b("separator") {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            continue;
        }
        if b("heading") {
            menu.addItem(&NSMenuItem::sectionHeaderWithTitle(&NSString::from_str(&s("title")), mtm));
            continue;
        }
        let item = new_item(mtm, &s("title"), sel!(menuPick:), "");
        item.setTag(i as isize);
        if !s("subtitle").is_empty() {
            item.setSubtitle(Some(&NSString::from_str(&s("subtitle"))));
        }
        let image = if !s("color").is_empty() { icons::swatch(&s("color")) } else { icons::menu_icon(&s("icon"), 16.0) };
        item.setImage(image.as_deref());
        if b("checked") {
            item.setState(NSControlStateValueOn);
        }
        item.setEnabled(!b("disabled"));
        if b("destructive") {
            let red = NSColor::systemRedColor();
            let key = unsafe { NSForegroundColorAttributeName };
            let value: &AnyObject = &red;
            let attrs = NSDictionary::from_slices(&[key], &[value]);
            let title = unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(&s("title")), &attrs) };
            item.setAttributedTitle(Some(&title));
        }
        menu.addItem(&item);
    }

    // Onder de knop, of erboven als de knop onderin staat (zoals de navigatie); rechts uitgelijnd als hij rechts staat.
    let size = menu.size();
    let bounds = root.bounds();
    let x = if rect.origin.x + rect.size.width / 2.0 > bounds.size.width / 2.0 {
        rect.origin.x + rect.size.width - size.width
    } else {
        rect.origin.x
    };
    let y = if rect.origin.y + rect.size.height / 2.0 < bounds.size.height / 2.0 {
        rect.origin.y + rect.size.height + 6.0
    } else {
        rect.origin.y - size.height - 6.0
    };
    menu.popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(x.max(8.0), y), Some(&root));

    let Some(index) = with_ui(|ui| ui.menu.picked.take()).flatten() else { return };
    let Some(row) = items.get(index as usize) else { return };
    if row["keepOpen"].as_bool().unwrap_or(false) {
        with_ui(|ui| ui.menu.reopen = true);
    }
    call_in(in_spiek, "GlassPick", row["id"].as_str().unwrap_or(""));
}

fn new_item(mtm: MainThreadMarker, title: &str, action: Sel, key: &str) -> Retained<NSMenuItem> {
    unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(), &NSString::from_str(title), Some(action), &NSString::from_str(key)) }
}

/// Een item in de menubalk. `extra` zijn de toetsen naast ⌘; `arg` gaat mee als representedObject.
fn add(menu: &NSMenu, mtm: MainThreadMarker, title: &str, action: Sel, key: &str, extra: NSEventModifierFlags, arg: Option<&str>) {
    let item = new_item(mtm, title, action, key);
    if !key.is_empty() {
        item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | extra);
    }
    if let Some(arg) = arg {
        unsafe { item.setRepresentedObject(Some(&NSString::from_str(arg))) };
    }
    menu.addItem(&item);
}

fn submenu(bar: &NSMenu, mtm: MainThreadMarker, title: &str) -> Retained<NSMenu> {
    let menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::from_str(title));
    let holder = new_item(mtm, title, sel!(submenuAction:), "");
    unsafe { holder.setAction(None) };
    holder.setSubmenu(Some(&menu));
    bar.addItem(&holder);
    menu
}

pub fn main_menu(mtm: MainThreadMarker, app: &App, _host: &Host) {
    let none = NSEventModifierFlags::empty();
    let shift = NSEventModifierFlags::Shift;
    let opt = NSEventModifierFlags::Option;
    let run = sel!(runScript:);
    let js = |f: &str, arg: &str| format!("window.{p}{f} && {p}{f}('{arg}')", p = app.prefix);
    let bar = NSMenu::new(mtm);

    let m = submenu(&bar, mtm, app.name);
    add(&m, mtm, &format!("Over {}", app.name), sel!(orderFrontStandardAboutPanel:), "", none, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    if !app.notes {
        add(&m, mtm, "Instellingen…", sel!(openPath:), ",", none, Some("/instellingen"));
    } else {
        add(&m, mtm, "Spiekbriefje in hoek rechtsonder", sel!(toggleCorner:), "", none, None);
    }
    add(&m, mtm, "Broncode op GitHub", sel!(openSource:), "", none, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, &format!("Verberg {}", app.name), sel!(hide:), "h", none, None);
    add(&m, mtm, "Verberg andere", sel!(hideOtherApplications:), "h", opt, None);
    add(&m, mtm, "Toon alles", sel!(unhideAllApplications:), "", none, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, &format!("Stop {}", app.name), sel!(terminate:), "q", none, None);

    let m = submenu(&bar, mtm, "Archief");
    if app.notes {
        add(&m, mtm, "Nieuwe notitie", run, "n", none, Some("window.notitiesNew && notitiesNew('tekst')"));
        add(&m, mtm, "Nieuwe lijst", run, "n", shift, Some("window.notitiesNew && notitiesNew('lijst')"));
        add(&m, mtm, "Dagnotitie", run, "d", shift, Some("window.notitiesNew && notitiesNew('dag')"));
    } else {
        add(&m, mtm, "Nieuwe afspraak", run, "n", none, Some("window.agendaNew && agendaNew()"));
    }
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, "Sluit venster", sel!(performClose:), "w", none, None);

    let m = submenu(&bar, mtm, "Wijzig");
    add(&m, mtm, "Herstel", sel!(undo:), "z", none, None);
    add(&m, mtm, "Opnieuw", sel!(redo:), "z", shift, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, "Knip", sel!(cut:), "x", none, None);
    add(&m, mtm, "Kopieer", sel!(copy:), "c", none, None);
    add(&m, mtm, "Plak", sel!(paste:), "v", none, None);
    add(&m, mtm, "Plak zonder opmaak", sel!(pasteAsPlainText:), "v", opt | shift, None);
    add(&m, mtm, "Selecteer alles", sel!(selectAll:), "a", none, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    let search = if app.notes {
        "document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',metaKey:true,bubbles:true}))".to_string()
    } else {
        "(function(){var q=document.getElementById('q');if(q){q.focus();q.select();}})()".to_string()
    };
    add(&m, mtm, "Zoek", run, "f", none, Some(&search));

    let m = submenu(&bar, mtm, "Weergave");
    if app.notes {
        add(&m, mtm, "Notities", run, "1", none, Some(&js("GlassNav", "notities")));
        add(&m, mtm, "Lijsten", run, "2", none, Some(&js("GlassNav", "lijsten")));
        add(&m, mtm, "Gepland", run, "3", none, Some(&js("GlassNav", "herinneringen")));
    } else {
        let pick = |view: &str| format!("document.querySelector('#viewSeg [data-view=\"{view}\"]')?.click()");
        let click = |id: &str| format!("document.getElementById('{id}')?.click()");
        add(&m, mtm, "Dag", run, "1", none, Some(&pick("day")));
        add(&m, mtm, "Week", run, "2", none, Some(&pick("week")));
        add(&m, mtm, "Maand", run, "3", none, Some(&pick("month")));
        m.addItem(&NSMenuItem::separatorItem(mtm));
        add(&m, mtm, "Vandaag", run, "t", none, Some(&click("today")));
        add(&m, mtm, "Vorige", run, "\u{F702}", opt, Some(&click("prev")));
        add(&m, mtm, "Volgende", run, "\u{F703}", opt, Some(&click("next")));
    }
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, "Herlaad", sel!(reloadPage:), "r", none, None);
    add(&m, mtm, "Werkelijke grootte", sel!(zoomReset:), "0", none, None);
    add(&m, mtm, "Zoom in", sel!(zoomIn:), "+", none, None);
    add(&m, mtm, "Zoom uit", sel!(zoomOut:), "-", none, None);
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, "Volledig scherm", sel!(toggleFullScreen:), "f", NSEventModifierFlags::Control, None);

    let m = submenu(&bar, mtm, "Venster");
    add(&m, mtm, "Minimaliseer", sel!(performMiniaturize:), "m", none, None);
    add(&m, mtm, "Zoom", sel!(performZoom:), "", none, None);
    if app.notes {
        add(&m, mtm, "Spiekbriefje", sel!(showSpiek:), "j", none, None);
    }
    m.addItem(&NSMenuItem::separatorItem(mtm));
    add(&m, mtm, "Alles naar voren", sel!(arrangeInFront:), "", none, None);

    let ns_app = NSApplication::sharedApplication(mtm);
    ns_app.setMainMenu(Some(&bar));
    ns_app.setWindowsMenu(Some(&m));
}
