//! Icoontjes voor de balk en de menu's. Op de Mac SF Symbols; wat de pagina als
//! SVG-pad meestuurt (Notities) wordt als terugval gewoon getekend.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2::runtime::Bool;
use objc2_app_kit::{NSBezierPath, NSColor, NSFontWeightRegular, NSFontWeightSemibold, NSImage, NSImageSymbolConfiguration, NSImageSymbolScale};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSRect, NSString};

/// Namen uit de pagina (tabblad-id of icoonnaam) naar een SF Symbol.
fn symbol_name(name: &str) -> Option<&'static str> {
    Some(match name {
        // Notities
        "notities" | "note" => "note.text",
        "lijsten" => "checklist",
        "herinneringen" | "bell" => "bell",
        "meer" | "more" => "ellipsis.circle",
        // Agenda
        "list" => "list.bullet.below.rectangle",
        "day" => "calendar.day.timeline.left",
        "week" => "rectangle.split.3x1",
        "month" => "calendar",
        "search" => "magnifyingglass",
        "plus" => "plus",
        _ => return None,
    })
}

pub fn symbol(name: &str, size: f64, bold: bool) -> Option<Retained<NSImage>> {
    let real = symbol_name(name).unwrap_or(name);
    let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(real), None)?;
    let weight = unsafe { if bold { NSFontWeightSemibold } else { NSFontWeightRegular } };
    let config = NSImageSymbolConfiguration::configurationWithPointSize_weight_scale(size, weight, NSImageSymbolScale::Medium);
    image.imageWithSymbolConfiguration(&config)
}

/// Een SVG-pad op een raster van 24, met lijnen zoals op de website. Sjabloon, dus de kleur volgt de tekst.
pub fn svg_path(d: &str, size: f64) -> Option<Retained<NSImage>> {
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="{}"/></svg>"#,
        d.replace('"', "")
    );
    let data = NSData::with_bytes(svg.as_bytes());
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    image.setSize(CGSize::new(size, size));
    image.setTemplate(true);
    Some(image)
}

/// Icoon voor een tabblad: op de naam die de pagina meegeeft (Agenda), anders op het id (Notities).
pub fn tab(id: &str, icon: &str, size: f64) -> Option<Retained<NSImage>> {
    let name = if symbol_name(icon).is_some() { icon } else { id };
    symbol_name(name).and_then(|_| symbol(name, size, false)).or_else(|| menu_icon(icon, size))
}

/// Icoon in een menu: een naam (Agenda) of een SVG-pad (Notities).
pub fn menu_icon(icon: &str, size: f64) -> Option<Retained<NSImage>> {
    if icon.is_empty() {
        return None;
    }
    let looks_like_path = icon.starts_with(['M', 'm']) && icon.contains(|c: char| c.is_ascii_digit());
    if looks_like_path { svg_path(icon, size) } else { symbol(icon, size * 0.85, false) }
}

/// Gekleurd rondje, bijvoorbeeld voor een agenda in het Meer-menu.
pub fn swatch(hex: &str) -> Option<Retained<NSImage>> {
    let color = parse_hex(hex)?;
    let block = RcBlock::new(move |r: NSRect| -> Bool {
        color.set();
        let dot = CGRect::new(CGPoint::new(r.origin.x + 2.0, r.origin.y + 2.0), CGSize::new(r.size.width - 4.0, r.size.height - 4.0));
        NSBezierPath::bezierPathWithOvalInRect(dot).fill();
        Bool::YES
    });
    Some(NSImage::imageWithSize_flipped_drawingHandler(CGSize::new(14.0, 14.0), false, &block))
}

pub fn parse_hex(hex: &str) -> Option<Retained<NSColor>> {
    let h = hex.trim().trim_start_matches('#');
    let v = u32::from_str_radix(h.get(0..6)?, 16).ok()?;
    Some(rgb(v))
}

pub fn rgb(v: u32) -> Retained<NSColor> {
    let c = |shift: u32| ((v >> shift) & 0xFF) as f64 / 255.0;
    NSColor::colorWithSRGBRed_green_blue_alpha(c(16), c(8), c(0), 1.0)
}
