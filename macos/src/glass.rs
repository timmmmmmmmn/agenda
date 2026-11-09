//! De zwevende navigatie als echt macOS-glas (NSGlassEffectView): een balk met tabbladen en
//! een losse +-knop. De pagina meet waar ze horen; de app tekent ze op die plek over de pagina.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;

use block2::RcBlock;

use objc2::rc::Retained;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAnimatablePropertyContainer, NSAnimationContext, NSBox, NSBoxType, NSColor, NSEvent, NSFont, NSFontWeightBold, NSGlassEffectView,
    NSImageScaling, NSImageView, NSTextAlignment, NSTextField, NSTitlePosition, NSView,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSPoint, NSRect, NSString};
use serde_json::Value;

use crate::icons;

/// Zelfde maten als de balk in de Android-app.
const INSET: f64 = 5.0;

pub struct TabView {
    icon: Retained<NSImageView>,
    label: Retained<NSTextField>,
}

pub struct NavIvars {
    /// Leeg voor de +-knop.
    ids: RefCell<Vec<String>>,
    pressed: Cell<isize>,
    on_tap: Cell<Option<fn(&str)>>,
}

define_class!(
    /// Vangt alle klikken binnen de balk zelf op, ook die op icoontjes en labels.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "TimNavView"]
    #[ivars = NavIvars]
    pub struct NavView;

    impl NavView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let local = self.convertPoint_fromView(point, unsafe { self.superview() }.as_deref());
            let b = self.bounds();
            if local.x >= 0.0 && local.y >= 0.0 && local.x <= b.size.width && local.y <= b.size.height {
                self as *const Self as *mut NSView
            } else {
                std::ptr::null_mut()
            }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.ivars().pressed.set(self.cell_at(event));
            self.setAlphaValue(0.72);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let same = self.cell_at(event) == self.ivars().pressed.get();
            self.setAlphaValue(if same { 0.72 } else { 1.0 });
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.setAlphaValue(1.0);
            let cell = self.cell_at(event);
            if cell < 0 || cell != self.ivars().pressed.get() {
                return;
            }
            let id = {
                let ids = self.ivars().ids.borrow();
                if ids.is_empty() { "add".to_string() } else { ids[cell as usize].clone() }
            };
            if let Some(tap) = self.ivars().on_tap.get() {
                tap(&id);
            }
        }
    }
);

impl NavView {
    fn new(mtm: MainThreadMarker, on_tap: fn(&str)) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(NavIvars {
            ids: RefCell::new(Vec::new()),
            pressed: Cell::new(-1),
            on_tap: Cell::new(Some(on_tap)),
        });
        unsafe { msg_send![super(this), initWithFrame: CGRect::ZERO] }
    }

    /// Welk tabblad onder de muis zit, of -1 erbuiten.
    fn cell_at(&self, event: &NSEvent) -> isize {
        let p = self.convertPoint_fromView(event.locationInWindow(), None);
        let b = self.bounds();
        if p.x < 0.0 || p.y < 0.0 || p.x > b.size.width || p.y > b.size.height {
            return -1;
        }
        let n = self.ivars().ids.borrow().len();
        if n == 0 {
            return 0;
        }
        let cell = (b.size.width - INSET * 2.0) / n as f64;
        (((p.x - INSET) / cell).floor() as isize).clamp(0, n as isize - 1)
    }
}

pub struct GlassBar {
    pill: Retained<NSGlassEffectView>,
    tabs_view: Retained<NavView>,
    plate: Retained<NSBox>,
    tabs: Vec<TabView>,
    add: Retained<NSGlassEffectView>,
    add_icon: Retained<NSImageView>,
    shown: bool,
}

fn rect_of(v: &Value) -> NSRect {
    let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
    CGRect::new(CGPoint::new(f("x"), f("y")), CGSize::new(f("w"), f("h")))
}

impl GlassBar {
    pub fn new(mtm: MainThreadMarker, parent: &NSView, on_tap: fn(&str)) -> Self {
        let pill = NSGlassEffectView::new(mtm);
        let tabs_view = NavView::new(mtm, on_tap);
        let plate = NSBox::new(mtm);
        plate.setBoxType(NSBoxType::Custom);
        plate.setBorderWidth(0.0);
        plate.setTitlePosition(NSTitlePosition::NoTitle);
        tabs_view.addSubview(&plate);
        pill.setContentView(Some(&tabs_view));

        let add = NSGlassEffectView::new(mtm);
        let add_view = NavView::new(mtm, on_tap);
        let add_icon = NSImageView::new(mtm);
        add_icon.setImageScaling(NSImageScaling::ScaleNone);
        add_icon.setImage(icons::symbol("plus", 22.0, true).as_deref());
        add_view.addSubview(&add_icon);
        add.setContentView(Some(&add_view));

        for v in [&*pill, &*add] {
            v.setHidden(true);
            v.setAlphaValue(0.0);
            parent.addSubview(v);
        }
        GlassBar { pill, tabs_view, plate, tabs: Vec::new(), add, add_icon, shown: false }
    }

    /// Wat de pagina doorgeeft: { pill, add, tabs: [{id, title, icon}], active, dark, visible }.
    pub fn update(&mut self, mtm: MainThreadMarker, bar: &Value, accent: &NSColor, add_ink: &NSColor, radius: f64) {
        let pill_rect = rect_of(&bar["pill"]);
        let add_rect = rect_of(&bar["add"]);
        let dark = bar["dark"].as_bool().unwrap_or(false);
        let visible = bar["visible"].as_bool().unwrap_or(true) && pill_rect.size.width > 0.0;
        let tabs: Vec<(String, String, String)> = bar["tabs"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|t| {
                        let s = |k: &str| t[k].as_str().unwrap_or("").to_string();
                        (s("id"), s("title"), s("icon"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let active = bar["active"].as_str().unwrap_or("");

        let first = !self.shown;
        let move_to = |view: &NSView, rect: NSRect| {
            if first { view.setFrame(rect) } else { view.animator().setFrame(rect) }
        };
        move_to(&self.pill, pill_rect);
        move_to(&self.add, add_rect);
        self.pill.setCornerRadius(radius.min(pill_rect.size.height / 2.0));
        self.add.setCornerRadius(radius.min(add_rect.size.height / 2.0));
        self.add.setTintColor(Some(accent));
        self.tabs_view.setFrame(CGRect::new(CGPoint::ZERO, pill_rect.size));
        if let Some(content) = self.add.contentView() {
            content.setFrame(CGRect::new(CGPoint::ZERO, add_rect.size));
        }
        self.add_icon.setFrame(CGRect::new(CGPoint::ZERO, add_rect.size));
        self.add_icon.setContentTintColor(Some(add_ink));

        // Tabbladen opnieuw opbouwen als het er meer of minder zijn geworden.
        while self.tabs.len() < tabs.len() {
            let icon = NSImageView::new(mtm);
            icon.setImageScaling(NSImageScaling::ScaleNone);
            let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
            label.setAlignment(NSTextAlignment::Center);
            label.setFont(Some(&NSFont::systemFontOfSize_weight(10.0, unsafe { NSFontWeightBold })));
            self.tabs_view.addSubview(&icon);
            self.tabs_view.addSubview(&label);
            self.tabs.push(TabView { icon, label });
        }
        while self.tabs.len() > tabs.len() {
            let t = self.tabs.pop().unwrap();
            t.icon.removeFromSuperview();
            t.label.removeFromSuperview();
        }
        *self.tabs_view.ivars().ids.borrow_mut() = tabs.iter().map(|t| t.0.clone()).collect();

        let n = tabs.len().max(1) as f64;
        let w = pill_rect.size.width;
        let h = pill_rect.size.height;
        let cell = (w - INSET * 2.0) / n;
        let muted = if dark { NSColor::colorWithWhite_alpha(0.95, 0.92) } else { NSColor::colorWithWhite_alpha(0.04, 0.88) };
        let mut active_index = 0;
        for (i, ((id, title, icon), view)) in tabs.iter().zip(&self.tabs).enumerate() {
            let on = id == active;
            if on {
                active_index = i;
            }
            let color = if on { accent } else { &*muted };
            let left = INSET + cell * i as f64;
            view.icon.setImage(icons::tab(id, icon, 19.0).as_deref());
            view.icon.setContentTintColor(Some(color));
            view.icon.setFrame(CGRect::new(CGPoint::new(left, h / 2.0 - 21.0), CGSize::new(cell, 26.0)));
            view.label.setStringValue(&NSString::from_str(&title.to_uppercase()));
            view.label.setTextColor(Some(color));
            view.label.setFrame(CGRect::new(CGPoint::new(left, h / 2.0 + 7.0), CGSize::new(cell, 14.0)));
        }

        // Het plaatje onder het actieve tabblad schuift mee.
        let plate_rect = CGRect::new(CGPoint::new(INSET + cell * active_index as f64, INSET), CGSize::new(cell, h - INSET * 2.0));
        let plate_color = if dark { NSColor::colorWithWhite_alpha(1.0, 0.16) } else { NSColor::colorWithWhite_alpha(0.0, 0.08) };
        self.plate.setFillColor(&plate_color);
        self.plate.setCornerRadius((radius - INSET).min(plate_rect.size.height / 2.0));
        if first {
            self.plate.setFrame(plate_rect);
        } else {
            let plate = self.plate.clone();
            NSAnimationContext::runAnimationGroup(&RcBlock::new(move |ctx: NonNull<NSAnimationContext>| {
                unsafe { ctx.as_ref() }.setDuration(0.28);
                plate.animator().setFrame(plate_rect);
            }));
        }

        self.set_visible(visible);
    }

    pub fn set_visible(&mut self, visible: bool) {
        if visible == self.shown && self.pill.isHidden() == !visible {
            return;
        }
        self.shown = visible;
        for v in [&*self.pill, &*self.add] {
            if visible {
                v.setHidden(false);
                v.animator().setAlphaValue(1.0);
            } else {
                v.animator().setAlphaValue(0.0);
            }
        }
        if !visible {
            // Na het uitfaden ook echt weg, zodat klikken weer naar de pagina gaan.
            let (pill, add) = (self.pill.clone(), self.add.clone());
            crate::later(0.3, move || {
                if pill.alphaValue() < 0.01 {
                    pill.setHidden(true);
                    add.setHidden(true);
                }
            });
        }
    }

    pub fn hide(&mut self) {
        self.shown = false;
        for v in [&*self.pill, &*self.add] {
            v.setAlphaValue(0.0);
            v.setHidden(true);
        }
    }
}
