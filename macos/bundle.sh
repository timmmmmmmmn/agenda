#!/bin/sh
# Bouwt Agenda.app en Notities.app in target/. Eén programma, de bundel-id bepaalt welke app het is.
set -e
# Welke apps deze map bouwt.
: "${APPS:=Agenda}"
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)

for NAME in $APPS; do
  ID=nl.timvanbergen.$(echo "$NAME" | tr 'A-Z' 'a-z')
  APP="target/$NAME.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp target/release/timapp "$APP/Contents/MacOS/$NAME"

  # Icoon: Assets.car (laagjes, voor de heldere en getinte stijl van macOS) als die er is,
  # en altijd een gewone .icns voor oudere macOS-versies en Finder-voorbeelden.
  ICONS="icons/$NAME"
  if [ -f "$ICONS/build/Assets.car" ]; then
    cp "$ICONS/build/Assets.car" "$APP/Contents/Resources/Assets.car"
  fi
  if [ -f "$ICONS/build/AppIcon.icns" ]; then
    cp "$ICONS/build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  elif [ -f "$ICONS/AppIcon.icns" ]; then
    cp "$ICONS/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  fi

  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>nl</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Tim van Bergen</string>
</dict>
</plist>
PLIST
  # Notities: het hulpje dat de hoek rechtsonder in de gaten houdt, ook als Notities dicht is.
  if [ "$NAME" = Notities ]; then
    HELP="$APP/Contents/Library/LoginItems/NotitiesHoek.app"
    mkdir -p "$HELP/Contents/MacOS"
    cp target/release/timapp "$HELP/Contents/MacOS/NotitiesHoek"
    cat > "$HELP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>NotitiesHoek</string>
  <key>CFBundleIdentifier</key><string>$ID.hoek</string>
  <key>CFBundleExecutable</key><string>NotitiesHoek</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
    codesign --force --sign - "$HELP" >/dev/null 2>&1 || true
  fi
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  echo "Klaar: $APP"
done
