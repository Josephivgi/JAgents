; JAgents setup: one .exe a person downloads and double-clicks.
; Built by scripts/pack-setup.cjs:
;   makensis /DVERSION=0.3.0 /DVIVERSION=0.3.0.0 /DSTAGE=<layout> /DOUTFILE=<exe> /DICON=<ico> installer.nsi
;
; STAGE is the installed layout (JAgents.exe, resources\app). It goes to
; %LOCALAPPDATA%\Programs\JAgents with Start Menu and Desktop shortcuts and an
; Add-or-Remove-Programs entry. Per user, no admin. App data in
; %APPDATA%\JAgents is never touched, by install or uninstall.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "FileFunc.nsh"

!ifndef STAGE
  !error "Pass /DSTAGE=<staged install layout>"
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
  RMDir /r "$INSTDIR\resources\app"
  DetailPrint "Installing ${APP} ${VERSION}..."
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
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
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" $0

  Exec '"$INSTDIR\JAgents.exe"'
  done:
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
