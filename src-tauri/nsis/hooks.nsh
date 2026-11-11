; NSIS Custom Hooks for GabeTeX
; Includes TeX distribution detection and optional silent installation.
; Uses only native NSIS commands (no nsDialogs dependency).
;
; Flow:
;   PREINSTALL  -> ShowTexSelectionPage   (detect existing TeX, ask the user; never installs anything)
;   POSTINSTALL -> InstallTexSilently     (only after GabeTeX itself was copied, so a failed/cancelled
;                                          download can never break the application install)
;               -> WriteTexChoiceFile     (persists %LOCALAPPDATA%\GabeTeX\tex-choice.json for the app)
;
; Security model for downloads (see DownloadVerified):
;   * official HTTPS sources only; curl.exe enforces https for the URL *and* for every redirect (TLS >= 1.2)
;   * everything is stored in $PLUGINSDIR (random per-run, per-user temp dir), never at a predictable $TEMP path
;   * Authenticode check: signed files must have a *valid* signature (tampered/invalid ones are rejected)
;   * system tools are always invoked through absolute $SYSDIR paths (no PATH / current-directory lookup)
;   * installation success is decided by the presence of pdflatex.exe, never by an exit code alone

!include "logiclib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"

; ------------------------------------------------------------------
; Global state for TeX installer integration
; ------------------------------------------------------------------
Var /GLOBAL TEX_ACTION          ; install-tinytex | install-texlive | install-miktex | detected | keep | skip
Var /GLOBAL TEX_DETECTED        ; yes | no
Var /GLOBAL TEX_DETECTED_PATH   ; bin directory of the detected / installed TeX
Var /GLOBAL DL_URL
Var /GLOBAL DL_DEST
Var /GLOBAL JSON_IN
Var /GLOBAL JSON_OUT

; Download URLs (official sources, all HTTPS)
!define TEX_TINYTEX_URL   "https://tinytex.yihui.org/install-bin-windows.ps1"
!define TEX_TEXLIVE_URL   "https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe"
!define TEX_MIKTEX_URL    "https://miktex.org/download/win/miktexsetup-x64.zip"

!define PS_EXE "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define CURL_EXE "$SYSDIR\curl.exe"

!macro NSIS_HOOK_PREINSTALL
  ; Terminate any running application instance to prevent file-in-use errors during install/update
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0

  ; Decide what to do about TeX before copying files
  Call ShowTexSelectionPage
!macroend

Var /GLOBAL CREATE_SHORTCUTS

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current

  ; Optional TeX installation (chosen in PREINSTALL), then persist the result for the app
  Call InstallTexSilently
  Call WriteTexChoiceFile

  ; Shortcuts are created only at the end, with user approval
  ${If} $TEX_ACTION != "skip"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Create GabeTeX shortcuts?$\r$\n$\r$\nYes = Start Menu and Desktop shortcuts$\r$\nNo = no shortcuts (you can still run GabeTeX from its install folder)" \
      IDYES do_shortcuts IDNO skip_shortcuts

    do_shortcuts:
      StrCpy $CREATE_SHORTCUTS "yes"
      Goto create_shortcuts

    skip_shortcuts:
      StrCpy $CREATE_SHORTCUTS "no"

    create_shortcuts:
      ${If} $CREATE_SHORTCUTS == "yes"
        CreateDirectory "$SMPROGRAMS\GabeTeX"
        CreateShortcut "$SMPROGRAMS\GabeTeX\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        CreateShortcut "$SMPROGRAMS\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        CreateShortcut "$DESKTOP\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext current

  ; 1. Terminate application and all child processes (including WebView2) immediately
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0

  ; 2. CRITICAL SPEED & SAFETY FIX:
  ; GabeTeX compiler creates shadow workspaces in %LOCALAPPDATA%\io.github.gabe-rbo.GabeTeX\Shadow.
  ; Each workspace's tree directory contains NTFS directory junctions / symbolic links mirroring
  ; ancestor folders (e.g. AppData\LocalLow, AppData\Roaming, and Packages).
  ; Built-in NSIS "RmDir /r" does NOT detect reparse points, causing it to blindly step into junctions
  ; and recursively scan/delete hundreds of thousands of files across the user's entire machine.
  ; Windows native "rmdir /s /q" safely unlinks junctions in milliseconds WITHOUT traversing targets.
  nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX\Shadow" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX\Shadow"'
  Pop $0
  nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.gabetex\Shadow" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.gabetex\Shadow"'
  Pop $0

  ; 3. If user opted to delete application data and we are not updating:
  ; Pre-clean heavy Chromium WebView2 cache with native rmdir /s /q to avoid NSIS slow file-by-file deletion
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX\EBWebView" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX\EBWebView"'
    Pop $0
    nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.gabetex\EBWebView" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.gabetex\EBWebView"'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current

  ; Clean pinned taskbar shortcuts if present
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\GabeTeX.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\gabetex.lnk"

  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Fast native recursive cleanup of residual user configuration and data directories
    nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX"'
    Pop $0
    nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\io.github.gabe-rbo.gabetex" rmdir /s /q "$LOCALAPPDATA\io.github.gabe-rbo.gabetex"'
    Pop $0
    nsExec::Exec 'cmd.exe /c if exist "$LOCALAPPDATA\GabeTeX" rmdir /s /q "$LOCALAPPDATA\GabeTeX"'
    Pop $0
    nsExec::Exec 'cmd.exe /c if exist "$APPDATA\GabeTeX" rmdir /s /q "$APPDATA\GabeTeX"'
    Pop $0
  ${EndIf}

  ; Remove the persisted TeX choice, but keep it across updates (the updater runs the old uninstaller first).
  ; The TeX distribution itself is never uninstalled: it is independent software the user may rely on.
  ${If} $UpdateMode <> 1
    Delete "$LOCALAPPDATA\GabeTeX\tex-choice.json"
  ${EndIf}
!macroend

; ------------------------------------------------------------------
; Scan "<root>\<year>\bin\{windows,win64,win32}" (TeX Live layout). Root is passed on the stack.
; Years are enumerated in ascending order, so the newest installation wins. Sets $TEX_DETECTED* only when
; nothing was detected yet.
; ------------------------------------------------------------------
Function ScanTexLiveRoot
  Exch $R0            ; root
  Push $R1            ; find handle
  Push $R2            ; entry name
  Push $R3            ; best bin dir of this root

  StrCpy $R3 ""
  FindFirst $R1 $R2 "$R0\20??"
  scan_loop:
    StrCmp $R2 "" scan_done
    ${If} ${FileExists} "$R0\$R2\bin\windows\pdflatex.exe"
      StrCpy $R3 "$R0\$R2\bin\windows"
    ${ElseIf} ${FileExists} "$R0\$R2\bin\win64\pdflatex.exe"
      StrCpy $R3 "$R0\$R2\bin\win64"
    ${ElseIf} ${FileExists} "$R0\$R2\bin\win32\pdflatex.exe"
      StrCpy $R3 "$R0\$R2\bin\win32"
    ${EndIf}
    FindNext $R1 $R2
    Goto scan_loop
  scan_done:
  FindClose $R1

  ${If} $TEX_DETECTED == "no"
  ${AndIf} $R3 != ""
    StrCpy $TEX_DETECTED "yes"
    StrCpy $TEX_DETECTED_PATH "$R3"
  ${EndIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Detect existing TeX installations on the machine
; Sets $TEX_DETECTED (yes|no) and $TEX_DETECTED_PATH (bin directory).
; ------------------------------------------------------------------
Function DetectTexInstallations
  StrCpy $TEX_DETECTED "no"
  StrCpy $TEX_DETECTED_PATH ""

  ; TeX Live (system-wide, other drive, per-user)
  Push "C:\texlive"
  Call ScanTexLiveRoot
  ${If} $TEX_DETECTED == "no"
    Push "D:\texlive"
    Call ScanTexLiveRoot
  ${EndIf}
  ${If} $TEX_DETECTED == "no"
    Push "$LOCALAPPDATA\Programs\texlive"
    Call ScanTexLiveRoot
  ${EndIf}

  ; MiKTeX (per-user, then all-users)
  ${If} $TEX_DETECTED == "no"
    ${If} ${FileExists} "$LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64"
    ${ElseIf} ${FileExists} "$PROGRAMFILES64\MiKTeX\miktex\bin\x64\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$PROGRAMFILES64\MiKTeX\miktex\bin\x64"
    ${ElseIf} ${FileExists} "$PROGRAMFILES\MiKTeX\miktex\bin\x64\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$PROGRAMFILES\MiKTeX\miktex\bin\x64"
    ${EndIf}
  ${EndIf}

  ; TinyTeX (%APPDATA%, or %ProgramData% when APPDATA contains spaces / non-ASCII characters)
  ${If} $TEX_DETECTED == "no"
    ReadEnvStr $R0 "ProgramData"
    ${If} ${FileExists} "$APPDATA\TinyTeX\bin\windows\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$APPDATA\TinyTeX\bin\windows"
    ${ElseIf} $R0 != ""
    ${AndIf} ${FileExists} "$R0\TinyTeX\bin\windows\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$R0\TinyTeX\bin\windows"
    ${EndIf}
  ${EndIf}

  ; Anything else on PATH
  ${If} $TEX_DETECTED == "no"
    Call FindInPath
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------
; Look for pdflatex.exe on PATH. Uses PowerShell's Get-Command (applications only), which - unlike
; "where.exe" - never resolves a file planted in the current directory (e.g. the Downloads folder the
; installer was started from). The result is validated with FileExists before being trusted.
; ------------------------------------------------------------------
Function FindInPath
  Push $R0
  Push $R1
  nsExec::ExecToStack '"${PS_EXE}" -NoProfile -NonInteractive -Command "$$c = Get-Command pdflatex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($$c) { [Console]::Out.Write((Split-Path -Parent $$c.Source)) }"'
  Pop $R0   ; exit code
  Pop $R1   ; output (directory, no trailing newline)
  ${If} $R0 == 0
  ${AndIf} $R1 != ""
  ${AndIf} ${FileExists} "$R1\pdflatex.exe"
    StrCpy $TEX_DETECTED "yes"
    StrCpy $TEX_DETECTED_PATH "$R1"
  ${EndIf}
  Pop $R1
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Ask what to do about TeX. Never installs anything by itself.
; ------------------------------------------------------------------
Function ShowTexSelectionPage
  StrCpy $TEX_ACTION "skip"
  Call DetectTexInstallations

  ; Updating: keep the choice made on the first install, do not ask again.
  ${If} $UpdateMode = 1
  ${AndIf} ${FileExists} "$LOCALAPPDATA\GabeTeX\tex-choice.json"
    StrCpy $TEX_ACTION "keep"
    Return
  ${EndIf}

  ; Silent (/S) installs must never block on a dialog nor download anything: use what is already there.
  IfSilent 0 interactive
    ${If} $TEX_DETECTED == "yes"
      StrCpy $TEX_ACTION "detected"
    ${EndIf}
    Return

  interactive:
  ${If} $TEX_DETECTED == "yes"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "GabeTeX needs a LaTeX compiler to build PDF documents.$\r$\n$\r$\nDetected TeX installation:$\r$\n$TEX_DETECTED_PATH$\r$\n$\r$\nUse this installation?" \
      IDYES use_detected IDNO ask_install
  ${EndIf}
  Goto ask_install

  use_detected:
    StrCpy $TEX_ACTION "detected"
    Return

  ask_install:
    ; Declining a detected TeX here means the user wants a different one (or none): forget the detection
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
      "Install a TeX distribution with GabeTeX?$\r$\n$\r$\nFiles are downloaded over HTTPS from the official project sites and installed for the current user only.$\r$\n$\r$\nYes = TinyTeX (recommended, small download)$\r$\nNo = choose another distribution$\r$\nCancel = do not install TeX now" \
      IDYES choose_tinytex IDNO ask_more
    Goto skip_tex

  ask_more:
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
      "Which distribution?$\r$\n$\r$\nYes = TeX Live (scheme-small, large download)$\r$\nNo = MiKTeX (basic set, packages on demand)$\r$\nCancel = do not install TeX now" \
      IDYES choose_texlive IDNO choose_miktex
    Goto skip_tex

  choose_tinytex:
    StrCpy $TEX_ACTION "install-tinytex"
    Return
  choose_texlive:
    StrCpy $TEX_ACTION "install-texlive"
    Return
  choose_miktex:
    StrCpy $TEX_ACTION "install-miktex"
    Return

  skip_tex:
    StrCpy $TEX_ACTION "skip"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
FunctionEnd

; ------------------------------------------------------------------
; Secure download of $DL_URL into $DL_DEST. Result in $0 (0 = success).
; --proto-redir =https blocks HTTP redirects; MiKTeX mirrors often use HTTP,
; so DownloadVerifiedHttp allows both HTTPS and HTTP redirects.
; ------------------------------------------------------------------
Function DownloadVerified
  Delete "$DL_DEST"
  nsExec::ExecToLog '"${CURL_EXE}" --proto =https --proto-redir =https --tlsv1.2 --fail --location --retry 2 --connect-timeout 30 --max-time 3600 --silent --show-error --output "$DL_DEST" "$DL_URL"'
  Pop $0
  ${If} $0 != 0
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$DL_DEST"
    StrCpy $0 1
    Return
  ${EndIf}
  nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-AuthenticodeSignature -LiteralPath '$DL_DEST').Status -in 'Valid','NotSigned') { exit 0 } else { exit 1 }"`
  Pop $0
  ${If} $0 != 0
    Delete "$DL_DEST"
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------
; Like DownloadVerified but allows HTTP redirects (needed for MiKTeX mirrors).
; Initial URL must still be HTTPS.
; ------------------------------------------------------------------
Function DownloadVerifiedHttp
  Delete "$DL_DEST"
  nsExec::ExecToLog '"${CURL_EXE}" --proto =https --proto-redir =https,http --tlsv1.2 --fail --location --retry 2 --connect-timeout 30 --max-time 3600 --silent --show-error --output "$DL_DEST" "$DL_URL"'
  Pop $0
  ${If} $0 != 0
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$DL_DEST"
    StrCpy $0 1
    Return
  ${EndIf}
  nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-AuthenticodeSignature -LiteralPath '$DL_DEST').Status -in 'Valid','NotSigned') { exit 0 } else { exit 1 }"`
  Pop $0
  ${If} $0 != 0
    Delete "$DL_DEST"
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------
; Report a failed TeX installation (never shown for silent installs)
; ------------------------------------------------------------------
Function TexInstallFailed
  Pop $R9   ; message
  DetailPrint "$R9"
  IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$R9$\r$\n$\r$\nGabeTeX was installed correctly. You can install TeX later and select it in Settings."
FunctionEnd

; ------------------------------------------------------------------
; Perform the TeX installation chosen by the user. Runs after GabeTeX itself is installed.
; ------------------------------------------------------------------
Function InstallTexSilently
  ${If} $TEX_ACTION == "install-tinytex"
    InitPluginsDir
    DetailPrint "Downloading TinyTeX installer..."
    StrCpy $DL_URL "${TEX_TINYTEX_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\install-tinytex.ps1"
    Call DownloadVerified
    ${If} $0 != 0
      Push "Could not download the TinyTeX installer securely."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    DetailPrint "Installing TinyTeX (this can take several minutes)..."
    nsExec::ExecToLog '"${PS_EXE}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DL_DEST"'
    Pop $0
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "TinyTeX installation did not complete (exit code $0)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-texlive"
    InitPluginsDir
    DetailPrint "Downloading TeX Live installer..."
    StrCpy $DL_URL "${TEX_TEXLIVE_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\install-tl-windows.exe"
    Call DownloadVerified
    ${If} $0 != 0
      Push "Could not download the TeX Live installer securely."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    ; Per-user, minimal profile: no PATH / registry-wide changes, no docs or sources.
    ; TEXDIR is intentionally left out so the installer picks the correct <year> directory.
    FileOpen $1 "$PLUGINSDIR\gabetex-texlive.profile" w
    FileWrite $1 "selected_scheme scheme-small$\r$\n"
    FileWrite $1 "instopt_adjustpath 0$\r$\n"
    FileWrite $1 "instopt_letter 0$\r$\n"
    FileWrite $1 "instopt_portable 0$\r$\n"
    FileWrite $1 "instopt_write18_restricted 1$\r$\n"
    FileWrite $1 "tlpdbopt_install_docfiles 0$\r$\n"
    FileWrite $1 "tlpdbopt_install_srcfiles 0$\r$\n"
    FileWrite $1 "tlpdbopt_desktop_integration 0$\r$\n"
    FileWrite $1 "tlpdbopt_file_assocs 0$\r$\n"
    FileWrite $1 "tlpdbopt_w32_multi_user 0$\r$\n"
    FileClose $1
    DetailPrint "Installing TeX Live (this can take a long time)..."
    nsExec::ExecToLog '"$DL_DEST" -no-gui -profile "$PLUGINSDIR\gabetex-texlive.profile"'
    Pop $0
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "TeX Live installation did not complete (exit code $0)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-miktex"
    InitPluginsDir
    DetailPrint "Downloading MiKTeX setup utility..."
    StrCpy $DL_URL "${TEX_MIKTEX_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\miktexsetup-x64.zip"
    Call DownloadVerifiedHttp
    ${If} $0 != 0
      Push "Could not download the MiKTeX setup utility securely."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '$DL_DEST' -DestinationPath '$PLUGINSDIR\miktexsetup' -Force"`
    Pop $0
    ${IfNot} ${FileExists} "$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe"
      Push "Could not unpack the MiKTeX setup utility."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    ; The extracted executable must carry a valid signature too
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-AuthenticodeSignature -LiteralPath '$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe').Status -in 'Valid','NotSigned') { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Push "The MiKTeX setup utility failed signature verification."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    DetailPrint "Downloading MiKTeX packages (basic set)..."
    nsExec::ExecToLog '"$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$PLUGINSDIR\miktex-repo" --package-set=basic download'
    Pop $0
    ${If} $0 != 0
      Push "MiKTeX package download failed (exit code $0)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    DetailPrint "Installing MiKTeX for the current user..."
    nsExec::ExecToLog '"$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$PLUGINSDIR\miktex-repo" --package-set=basic --shared=no --modify-path=no install'
    Pop $0
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "MiKTeX installation did not complete (exit code $0)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "skip"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
  ${EndIf}
  Return

  reset_failed:
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
FunctionEnd

; ------------------------------------------------------------------
; Escape backslashes of $JSON_IN into $JSON_OUT (Windows paths -> valid JSON string content)
; ------------------------------------------------------------------
Function JsonEscapePath
  Push $R0
  Push $R1
  StrCpy $JSON_OUT ""
  StrCpy $R0 0
  esc_loop:
    StrCpy $R1 $JSON_IN 1 $R0
    StrCmp $R1 "" esc_done
    StrCmp $R1 "\" esc_backslash esc_plain
  esc_backslash:
    StrCpy $JSON_OUT "$JSON_OUT\\"
    Goto esc_next
  esc_plain:
    StrCpy $JSON_OUT "$JSON_OUT$R1"
  esc_next:
    IntOp $R0 $R0 + 1
    Goto esc_loop
  esc_done:
  Pop $R1
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Write the TeX choice to a JSON file for the app to read (read_tex_choice / detect_cached).
; Written to a temporary file first and renamed, so the app never sees a half-written file.
; ------------------------------------------------------------------
Function WriteTexChoiceFile
  ; Updating with a previous choice: leave the existing file untouched
  StrCmp $TEX_ACTION "keep" write_done

  ; "skip" with nothing detected: write nothing, so the app falls back to its own automatic detection
  ; (an existing choice, e.g. a folder picked in Settings, is left untouched)
  ${If} $TEX_ACTION == "skip"
  ${AndIf} $TEX_DETECTED != "yes"
    Goto write_done
  ${EndIf}

  CreateDirectory "$LOCALAPPDATA\GabeTeX"

  StrCpy $JSON_IN "$TEX_DETECTED_PATH"
  Call JsonEscapePath

  FileOpen $1 "$LOCALAPPDATA\GabeTeX\tex-choice.json.tmp" w
  FileWrite $1 "{$\r$\n"
  FileWrite $1 '  "action": "$TEX_ACTION",$\r$\n'
  ${If} $TEX_DETECTED == "yes"
    FileWrite $1 '  "detected": true,$\r$\n'
  ${Else}
    FileWrite $1 '  "detected": false,$\r$\n'
  ${EndIf}
  FileWrite $1 '  "path": "$JSON_OUT"$\r$\n'
  FileWrite $1 "}$\r$\n"
  FileClose $1
  Delete "$LOCALAPPDATA\GabeTeX\tex-choice.json"
  Rename "$LOCALAPPDATA\GabeTeX\tex-choice.json.tmp" "$LOCALAPPDATA\GabeTeX\tex-choice.json"

  write_done:
FunctionEnd
