; ---------------------------------------------------------------------------
;  NoktApp POS - extra installer steps
;
;  Three things Windows needs told, none of which the customer should have to
;  do by hand:
;    1. let the waiter phones reach the till (firewall rule on 7451),
;    2. create the data folder before the first start,
;    3. leave the restaurant's data alone when the program is uninstalled.
;
;  NOTE ON PATHS: NSIS has no $PROGRAMDATA constant. Under
;  "SetShellVarContext all" - which a per-machine install uses - $APPDATA
;  resolves to C:\ProgramData, which is what the service reads from
;  process.env.PROGRAMDATA. Using the wrong name emits warning 6000 and
;  electron-builder turns that into a failed build.
; ---------------------------------------------------------------------------

!macro customInstall
  SetShellVarContext all

  CreateDirectory "$APPDATA\NoktAppPOS"
  CreateDirectory "$APPDATA\NoktAppPOS\logs"
  CreateDirectory "$APPDATA\NoktAppPOS\backups"
  CreateDirectory "$APPDATA\NoktAppPOS\mysql-data"
  CreateDirectory "$APPDATA\NoktAppPOS\media"
  CreateDirectory "$APPDATA\NoktAppPOS\tmp"

  ; the waiter phones talk to this PC on 7451
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NoktApp POS"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="NoktApp POS" dir=in action=allow protocol=TCP localport=7451 profile=private,domain'

  ; Bonjour/mDNS so the phones find the till without anyone typing an IP
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NoktApp POS Discovery"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="NoktApp POS Discovery" dir=in action=allow protocol=UDP localport=5353 profile=private,domain'

  ; start with Windows - a till should be ready when the shutter goes up
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "NoktAppPOS" "$INSTDIR\NoktApp POS.exe"
!macroend

!macro customUnInstall
  SetShellVarContext all

  nsExec::Exec 'netsh advfirewall firewall delete rule name="NoktApp POS"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NoktApp POS Discovery"'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "NoktAppPOS"

  ; NOTE: $APPDATA\NoktAppPOS is deliberately left in place. It holds the
  ; restaurant's own database and every local backup.
  MessageBox MB_OK "NoktApp POS kaldirildi.$\n$\nVerileriniz ve yedekleriniz su klasorde durmaya devam ediyor:$\n$APPDATA\NoktAppPOS"
!macroend
