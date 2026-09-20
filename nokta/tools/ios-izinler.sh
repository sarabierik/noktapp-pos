#!/usr/bin/env bash
#
# NOKTA - the iOS Info.plist keys, written rather than pasted.
#
# Run it on the Mac, from the project folder, after:
#     flutter create --platforms=ios .
#
#     bash tools/ios-izinler.sh
#
# Safe to run more than once: every key is Set first and only Added if it was
# not there, so a second run updates rather than duplicating.
set -eu
PLIST="ios/Runner/Info.plist"
[ -f "$PLIST" ] || { echo "$PLIST yok. Once: flutter create --platforms=ios ."; exit 1; }
PB=/usr/libexec/PlistBuddy

set_string() {   # key value
  $PB -c "Set :$1 $2" "$PLIST" 2>/dev/null || $PB -c "Add :$1 string $2" "$PLIST"
}

set_string CFBundleDisplayName "NOKTA"
set_string UIUserInterfaceStyle "Dark"

# Portrait only. Delete and rebuild the array so a rerun cannot leave landscape
# entries behind from the stock template.
$PB -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
$PB -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"

echo "Info.plist yazildi:"
$PB -c "Print :CFBundleDisplayName" "$PLIST"
$PB -c "Print :UIUserInterfaceStyle" "$PLIST"
$PB -c "Print :UISupportedInterfaceOrientations" "$PLIST"
