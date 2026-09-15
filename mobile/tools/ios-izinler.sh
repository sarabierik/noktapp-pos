#!/bin/bash
# NOKTApp Garson - iOS izin anahtarlarini Info.plist'e yazar.
#
# Run this ONCE on the Mac, straight after `flutter create --platforms=ios .`.
# It is safe to run again: every key is written with :set if it already exists,
# so nothing is duplicated.
#
# Without these keys iOS 14 and later block the app from touching the
# restaurant's own network. Discovery finds nothing, the manual address is
# refused, and the app looks broken with no error worth reading.

set -euo pipefail

PLIST="${1:-ios/Runner/Info.plist}"
PB=/usr/libexec/PlistBuddy

if [ ! -f "$PLIST" ]; then
  echo "Info.plist bulunamadi: $PLIST" >&2
  echo "Once 'flutter create --platforms=ios .' calistirin." >&2
  exit 1
fi

set_str() {  # key value
  $PB -c "Add :$1 string $2" "$PLIST" 2>/dev/null || $PB -c "Set :$1 $2" "$PLIST"
}

# 1. Yerel ag erisimi - iOS bunu kullaniciya bu metinle sorar.
set_str NSLocalNetworkUsageDescription \
  "Restorandaki kasa bilgisayarini bulmak icin yerel ag erisimi gerekir."

# 2. Bonjour servisi - mDNS ile kasayi bulmak icin. iOS listede olmayan
#    hicbir servisi taramaya izin vermez.
$PB -c "Delete :NSBonjourServices" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSBonjourServices array" "$PLIST"
$PB -c "Add :NSBonjourServices:0 string _noktapp-pos._tcp" "$PLIST"

# 3. Kasa ile konusma duz HTTP uzerinden, LAN icinde. ATS bunu varsayilan
#    olarak engeller; NSAllowsLocalNetworking sadece yerel agi acar,
#    internete cikan istekler HTTPS zorunlu kalir.
$PB -c "Add :NSAppTransportSecurity dict" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST" 2>/dev/null \
  || $PB -c "Set :NSAppTransportSecurity:NSAllowsLocalNetworking true" "$PLIST"

# 4. Kamera - kasadaki karekodu okutarak eslestirme. iOS bu metni izin
#    penceresinde gosterir; anahtar yoksa uygulama kamerayi actigi anda
#    cokerek kapanir.
set_str NSCameraUsageDescription \
  "Kasadaki eslestirme karekodunu okutmak icin kamera gerekir."

# 5. Uygulama adi - ana ekranda gorunen isim.
set_str CFBundleDisplayName "NOKTApp Garson"

echo "Tamam. Yazilan anahtarlar:"
$PB -c "Print :NSLocalNetworkUsageDescription" "$PLIST"
$PB -c "Print :NSBonjourServices" "$PLIST"
$PB -c "Print :NSAppTransportSecurity" "$PLIST"
$PB -c "Print :NSCameraUsageDescription" "$PLIST"
$PB -c "Print :CFBundleDisplayName" "$PLIST"
