; JAgents setup: one .exe a person downloads and double-clicks.
; Built by scripts/pack-setup.cjs:
;   makensis /DVERSION=0.3.0 /DVIVERSION=0.3.0.0 /DPAYLOAD=<app.tar.gz> /DOUTFILE=<exe> /DICON=<ico> /DSIZEKB=<kb> installer.nsi
;
; PAYLOAD is the installed layout (JAgents.exe, resources\app) as one .tar.gz.
; It is unpacked to %LOCALAPPDATA%\Programs\JAgents with Start Menu and Desktop
; shortcuts and an Add-or-Remove-Programs entry. Per user, no admin. App data
; in %APPDATA%\JAgents is never touched, by install or uninstall.
;
; One archive instead of thousands of files: makensis packed the loose files
; on one CPU core for 15+ minutes, and the setup took minutes to write them.
; Windows' own tar.exe (Windows 10 1803 and later) unpacks it in seconds.

Unicode true
; The payload is already gzip-compressed.
SetCompress off
RequestExecutionLevel user

!include "FileFunc.nsh"

!ifndef PAYLOAD
  !error "Pass /DPAYLOAD=<install layout as .tar.gz>"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VIVERSION
  !define VIVERSION "0.0.0.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "JAgents-Setup.exe"
!endif
!ifndef ICON
  !define ICON "${__FILEDIR__}\..\build\icon.ico"
!endif

!define APP "JAgents"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\JAgents"

Name "${APP}"
Caption "${APP} ${VERSION} setup"
OutFile "${OUTFILE}"
Icon "${ICON}"
UninstallIcon "${ICON}"
BrandingText "${APP} ${VERSION}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
ShowInstDetails nevershow
AutoCloseWindow true
InstallButtonText "Install"

VIProductVersion "${VIVERSION}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Josephivgi"

Page instfiles
UninstPage instfiles

Section "Install"
  ; Test hook: /TESTDIR=<folder> installs there with no shortcuts, no
  ; uninstall entry, and no launch, so a check never touches the real install.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/TESTDIR=" $R1
  StrCpy $R2 "0"
  IfErrors +3
    StrCpy $INSTDIR $R1
    StrCpy $R2 "1"

  ; A running copy holds JAgents.exe open.
  retry:
  ClearErrors
  Delete "$INSTDIR\JAgents.exe"
  IfErrors 0 unlocked
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "Close JAgents, then click Retry." /SD IDCANCEL IDRETRY retry
    SetErrorLevel 1
    Quit
  unlocked:

  ; The updater rewrites resources\app; start it clean so no old files linger.
  ; Deleting 5,000+ old files took about 15 seconds, so the old folder is
  ; renamed aside (instant) and deleted after JAgents has started. If it cannot
  ; be renamed, it is deleted here as before.
  StrCpy $R3 ""
  RMDir /r "$INSTDIR\resources\app.old"
  IfFileExists "$INSTDIR\resources\app\*.*" 0 fresh
    ClearErrors
    Rename "$INSTDIR\resources\app" "$INSTDIR\resources\app.old"
    IfErrors 0 +3
      RMDir /r "$INSTDIR\resources\app"
      Goto fresh
    StrCpy $R3 "$INSTDIR\resources\app.old"
  fresh:
  DetailPrint "Installing ${APP} ${VERSION}..."
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=app.tar.gz" "${PAYLOAD}"
  CreateDirectory "$INSTDIR"
  nsExec::ExecToLog '"$SYSDIR\tar.exe" -xzf "$PLUGINSDIR\app.tar.gz" -C "$INSTDIR"'
  Pop $0
  Delete "$PLUGINSDIR\app.tar.gz"
  SetOutPath "$INSTDIR"
  StrCmp $0 "0" unpacked
    MessageBox MB_ICONSTOP|MB_OK "${APP} could not be unpacked (tar exit $0).$\r$\n$\r$\nClose ${APP} if it is open, then run this setup again." /SD IDOK
    SetErrorLevel 1
    Quit
  unpacked:
  WriteUninstaller "$INSTDIR\Uninstall JAgents.exe"
  StrCmp $R2 "1" done

  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\JAgents.exe" "" "$INSTDIR\JAgents.exe" 0
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\JAgents.exe" "" "$INSTDIR\JAgents.exe" 0
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "JSystems"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\JAgents.exe"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "URLInfoAbout" "https://jsystems.app/jagents"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall JAgents.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall JAgents.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ; Measured by pack-setup.cjs when the setup is built. Counting the 9000+
  ; installed files here with GetSize took minutes on a real install.
  !ifdef SIZEKB
    WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" ${SIZEKB}
  !endif

  Exec '"$INSTDIR\JAgents.exe"'
  done:
  StrCmp $R3 "" +2
    RMDir /r "$R3"
SectionEnd

Section "Uninstall"
  ClearErrors
  Delete "$INSTDIR\JAgents.exe"
  IfErrors 0 +4
    MessageBox MB_ICONEXCLAMATION|MB_OK "Close JAgents, then run the uninstaller again." /SD IDOK
    SetErrorLevel 1
    Quit
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNKEY}"
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"
SectionEnd
