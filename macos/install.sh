#!/bin/sh
# Bouwt beide apps en zet ze in /Programma's (/Applications).
set -e
# Welke apps deze map bouwt.
: "${APPS:=Agenda}"
cd "$(dirname "$0")"
./bundle.sh
for NAME in $APPS; do
  pkill -x "$NAME" 2>/dev/null || true
  rm -rf "/Applications/$NAME.app"
  cp -R "target/$NAME.app" /Applications/
  echo "Geïnstalleerd: /Applications/$NAME.app"
done
case " $APPS " in *" Notities "*)
# Het spiekbriefje werkt ook als Notities dicht is: het hulpje NotitiesHoek draait altijd
# (start bij het inloggen, en opnieuw als het stopt) en start Notities stil als de muis in de hoek komt.
# Aan- en uitzetten gaat in Notities › Spiekbriefje in hoek rechtsonder.
AGENTS="$HOME/Library/LaunchAgents"
OLD="$AGENTS/nl.timvanbergen.notities.plist"
launchctl bootout "gui/$(id -u)/nl.timvanbergen.notities" 2>/dev/null || true
rm -f "$OLD"
AGENT="$AGENTS/nl.timvanbergen.notities.hoek.plist"
mkdir -p "$AGENTS"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>nl.timvanbergen.notities.hoek</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Notities.app/Contents/Library/LoginItems/NotitiesHoek.app/Contents/MacOS/NotitiesHoek</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/nl.timvanbergen.notities.hoek" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
;; esac

# Dock en Finder het nieuwe icoon laten zien.
for NAME in $APPS; do touch "/Applications/$NAME.app"; done
killall Dock 2>/dev/null || true
