# Agenda voor de Mac

Mac-app in Rust (AppKit via `objc2`). Hij toont de gewone desktopversie van agenda.timvanbergen.nl,
met de bovenbalk van de site als titelbalk van het venster: naast de verkeerslichtjes, en slepen kan op
de lege stukken. Wat van de Mac zelf komt:

- een menubalk met sneltoetsen (⌘N nieuwe afspraak, ⌘F zoeken, ⌘1/2/3 dag/week/maand, ⌘T vandaag,
  ⌥⌘←/→ vorige/volgende, ⌘, instellingen, ⌘R herladen, ⌘+/⌘− zoomen)
- vensters (nieuwe afspraak) blijven onder de titelbalk, de vensterkleur volgt licht/donker
- inloggen gaat via de gewone sessie-cookie, die de app onthoudt

## Bouwen en installeren

```sh
./install.sh      # bouwt de app en zet hem in /Applications
./bundle.sh       # alleen bouwen, naar target/
```

## Icoon

`icons/Agenda/AppIcon.icon` is het icoon in lagen (Icon Composer-formaat), zodat het meedoet met de
heldere en getinte stijl van het Dock. Het cijfer op de kaart is een eigen laag in Barlow Condensed
(de letter van de datums in de app, `icons/fonts`, OFL):
`cd icons && swift make_layers.swift agenda <Agenda_icon.png> Agenda/AppIcon.icon/Assets 17`.
Een `Assets.car` maken kan alleen met Xcode; dat doet GitHub Actions (`.github/workflows/macos-iconen.yml`).
Het resultaat hoort in `icons/Agenda/build/`.

## Testen

`TIMAPP_URL=https://localhost:8792/` wijst naar `wrangler dev --local-protocol https`. Met `TIMAPP_STEPS`
en `TIMAPP_SHOTS` voert de app stappen uit en maakt afbeeldingen van het venster (zie `src/debug.rs`).

De code is dezelfde als die van de Notities-Mac-app (in de notities-repo); de bundel-id bepaalt welke app het is.
