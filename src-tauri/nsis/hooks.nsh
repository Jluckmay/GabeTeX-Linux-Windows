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

; Progress tracking for TeX installation
Var /GLOBAL PROGRESS_PHASE      ; current phase text
Var /GLOBAL PROGRESS_TOTAL      ; total phases in selected distribution install
Var /GLOBAL PROGRESS_COMPLETED  ; completed phases
Var /GLOBAL PROGRESS_ESTIMATE   ; estimated total duration in seconds
Var /GLOBAL PROGRESS_STARTED    ; GetTickCount at install start

; Localized strings based on system language
Var /GLOBAL STR_DL_INSTALLER
Var /GLOBAL STR_PROGRESS
Var /GLOBAL STR_PROGRESS_START
Var /GLOBAL STR_PROGRESS_END
Var /GLOBAL STR_REMAINING
Var /GLOBAL STR_TEX_NEEDED
Var /GLOBAL STR_TEX_DETECTED
Var /GLOBAL STR_USE_THIS
Var /GLOBAL STR_INSTALL_TEX
Var /GLOBAL STR_TEX_HTTPS
Var /GLOBAL STR_YES_TINYTEX
Var /GLOBAL STR_NO_OTHER
Var /GLOBAL STR_CANCEL
Var /GLOBAL STR_WHICH_DISTRO
Var /GLOBAL STR_YES_TEXLIVE
Var /GLOBAL STR_YES_MIKTEX
Var /GLOBAL STR_DL_TINYTEX
Var /GLOBAL STR_INSTALL_TINYTEX
Var /GLOBAL STR_ERR_DL_TINYTEX
Var /GLOBAL ERR_TINYTEX_FAILED
Var /GLOBAL STR_DL_TEXLIVE
Var /GLOBAL STR_INSTALL_TEXLIVE
Var /GLOBAL STR_ERR_DL_TEXLIVE
Var /GLOBAL ERR_TEXLIVE_FAILED
Var /GLOBAL STR_DL_MIKTEX
Var /GLOBAL STR_EXTRACT_MIKTEX
Var /GLOBAL STR_ERR_UNPACK_MIKTEX
Var /GLOBAL STR_ERR_MIKTEX_SIG
Var /GLOBAL STR_DL_MIKTEX_PKGS
Var /GLOBAL STR_ERR_DL_MIKTEX
Var /GLOBAL ERR_MIKTEX_DL_FAILED
Var /GLOBAL STR_INSTALL_MIKTEX
Var /GLOBAL ERR_MIKTEX_FAILED
Var /GLOBAL STR_TEX_OK

; Initialize localized strings based on system language (must be called before any UI text is shown)
Function InitLangStrings
  ; Use the Windows user's display language, independent of the NSIS language selector.
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  ${If} $0 == 1046
    StrCpy $STR_DL_INSTALLER "Baixando instalador..."
    StrCpy $STR_PROGRESS "Progresso: "
    StrCpy $STR_PROGRESS_START "Iniciando: "
    StrCpy $STR_PROGRESS_END "Concluído: "
    StrCpy $STR_REMAINING "Tempo estimado restante: "
    StrCpy $STR_TEX_NEEDED "GabeTeX precisa de um compilador LaTeX para compilar documentos.$\r$\n$\r$\nInstalação TeX detectada:$\r$\n$TEX_DETECTED_PATH$\r$\n$\r$\nUsar esta instalação?"
    StrCpy $STR_TEX_DETECTED "Instalação TeX detectada:"
    StrCpy $STR_USE_THIS "Usar esta instalação?"
    StrCpy $STR_INSTALL_TEX "Instalar uma distribuição TeX com o GabeTeX?$\r$\n$\r$\nOs arquivos são baixados via HTTPS dos sites oficiais dos projetos e instalados apenas para o usuário atual.$\r$\n$\r$\nSim = TinyTeX (recomendado, download pequeno)$\r$\nNão = escolher outra distribuição$\r$\nCancelar = não instalar TeX agora"
    StrCpy $STR_TEX_HTTPS "Os arquivos são baixados via HTTPS dos sites oficiais dos projetos e instalados apenas para o usuário atual."
    StrCpy $STR_YES_TINYTEX "Sim = TinyTeX (recomendado, download pequeno)"
    StrCpy $STR_NO_OTHER "Não = escolher outra distribuição"
    StrCpy $STR_CANCEL "Cancelar = não instalar TeX agora"
    StrCpy $STR_WHICH_DISTRO "Qual distribuição?$\r$\n$\r$\nSim = TeX Live (scheme-small, download grande)$\r$\nNão = MiKTeX (conjunto básico, pacotes sob demanda)$\r$\nCancelar = não instalar TeX agora"
    StrCpy $STR_YES_TEXLIVE "Sim = TeX Live (scheme-small, download grande)"
    StrCpy $STR_YES_MIKTEX "Não = MiKTeX (conjunto básico, pacotes sob demanda)"
    StrCpy $STR_DL_TINYTEX "Baixando TinyTeX..."
    StrCpy $STR_INSTALL_TINYTEX "Instalando TinyTeX..."
    StrCpy $STR_ERR_DL_TINYTEX "Não foi possível baixar o instalador do TinyTeX com segurança."
    StrCpy $ERR_TINYTEX_FAILED "A instalação do TinyTeX não foi concluída (código de saída $0)."
    StrCpy $STR_DL_TEXLIVE "Baixando TeX Live..."
    StrCpy $STR_INSTALL_TEXLIVE "Instalando TeX Live..."
    StrCpy $STR_ERR_DL_TEXLIVE "Não foi possível baixar o instalador do TeX Live com segurança."
    StrCpy $ERR_TEXLIVE_FAILED "A instalação do TeX Live não foi concluída (código de saída $0)."
    StrCpy $STR_DL_MIKTEX "Baixando MiKTeX..."
    StrCpy $STR_EXTRACT_MIKTEX "Extraindo MiKTeX..."
    StrCpy $STR_ERR_UNPACK_MIKTEX "Não foi possível descompactar o utilitário de instalação do MiKTeX."
    StrCpy $STR_ERR_MIKTEX_SIG "O utilitário de instalação do MiKTeX falhou na verificação de assinatura."
    StrCpy $STR_DL_MIKTEX_PKGS "Baixando pacotes MiKTeX..."
    StrCpy $STR_ERR_DL_MIKTEX "Não foi possível baixar o utilitário de instalação do MiKTeX com segurança."
    StrCpy $ERR_MIKTEX_DL_FAILED "Falha no download dos pacotes MiKTeX (código de saída $0)."
    StrCpy $STR_INSTALL_MIKTEX "Instalando MiKTeX..."
    StrCpy $ERR_MIKTEX_FAILED "A instalação do MiKTeX não foi concluída (código de saída $0)."
    StrCpy $STR_TEX_OK "O GabeTeX foi instalado corretamente. Você pode instalar o TeX depois e selecioná-lo em Configurações."
  ${Else}
    StrCpy $STR_DL_INSTALLER "Downloading installer..."
    StrCpy $STR_PROGRESS "Progress: "
    StrCpy $STR_PROGRESS_START "Starting: "
    StrCpy $STR_PROGRESS_END "Completed: "
    StrCpy $STR_REMAINING "Estimated time remaining: "
    StrCpy $STR_TEX_NEEDED "GabeTeX needs a LaTeX compiler to build PDF documents.$\r$\n$\r$\nDetected TeX installation:$\r$\n$TEX_DETECTED_PATH$\r$\n$\r$\nUse this installation?"
    StrCpy $STR_TEX_DETECTED "Detected TeX installation:"
    StrCpy $STR_USE_THIS "Use this installation?"
    StrCpy $STR_INSTALL_TEX "Install a TeX distribution with GabeTeX?$\r$\n$\r$\nFiles are downloaded over HTTPS from the official project sites and installed for the current user only.$\r$\n$\r$\nYes = TinyTeX (recommended, small download)$\r$\nNo = choose another distribution$\r$\nCancel = do not install TeX now"
    StrCpy $STR_TEX_HTTPS "Files are downloaded over HTTPS from the official project sites and installed for the current user only."
    StrCpy $STR_YES_TINYTEX "Yes = TinyTeX (recommended, small download)"
    StrCpy $STR_NO_OTHER "No = choose another distribution"
    StrCpy $STR_CANCEL "Cancel = do not install TeX now"
    StrCpy $STR_WHICH_DISTRO "Which distribution?$\r$\n$\r$\nYes = TeX Live (scheme-small, large download)$\r$\nNo = MiKTeX (basic set, packages on demand)$\r$\nCancel = do not install TeX now"
    StrCpy $STR_YES_TEXLIVE "Yes = TeX Live (scheme-small, large download)"
    StrCpy $STR_YES_MIKTEX "No = MiKTeX (basic set, packages on demand)"
    StrCpy $STR_DL_TINYTEX "Downloading TinyTeX..."
    StrCpy $STR_INSTALL_TINYTEX "Installing TinyTeX..."
    StrCpy $STR_ERR_DL_TINYTEX "Could not download the TinyTeX installer securely."
    StrCpy $ERR_TINYTEX_FAILED "TinyTeX installation did not complete (exit code $0)."
    StrCpy $STR_DL_TEXLIVE "Downloading TeX Live..."
    StrCpy $STR_INSTALL_TEXLIVE "Installing TeX Live..."
    StrCpy $STR_ERR_DL_TEXLIVE "Could not download the TeX Live installer securely."
    StrCpy $ERR_TEXLIVE_FAILED "TeX Live installation did not complete (exit code $0)."
    StrCpy $STR_DL_MIKTEX "Downloading MiKTeX..."
    StrCpy $STR_EXTRACT_MIKTEX "Extracting MiKTeX..."
    StrCpy $STR_ERR_UNPACK_MIKTEX "Could not unpack the MiKTeX setup utility."
    StrCpy $STR_ERR_MIKTEX_SIG "The MiKTeX setup utility failed signature verification."
    StrCpy $STR_DL_MIKTEX_PKGS "Downloading MiKTeX packages..."
    StrCpy $STR_ERR_DL_MIKTEX "Could not download the MiKTeX setup utility securely."
    StrCpy $ERR_MIKTEX_DL_FAILED "MiKTeX package download failed (exit code $0)."
    StrCpy $STR_INSTALL_MIKTEX "Installing MiKTeX..."
    StrCpy $ERR_MIKTEX_FAILED "MiKTeX installation did not complete (exit code $0)."
    StrCpy $STR_TEX_OK "GabeTeX was installed correctly. You can install TeX later and select it in Settings."
  ${EndIf}
FunctionEnd

; Download URLs (official sources, all HTTPS)
!define TEX_TINYTEX_URL   "https://tinytex.yihui.org/install-bin-windows.ps1"
!define TEX_TEXLIVE_URL   "https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe"
!define TEX_MIKTEX_URL    "https://miktex.org/download/win/miktexsetup-x64.zip"

!define PS_EXE "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define CURL_EXE "$SYSDIR\curl.exe"

!macro NSIS_HOOK_PREINSTALL
  Call InitLangStrings
  ; Terminate any running application instance to prevent file-in-use errors during install/update
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0

  ; Decide what to do about TeX before copying files
  Call ShowTexSelectionPage
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Call InitLangStrings
  SetShellVarContext current

  ; Non-interactive installs never reach the final options page.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call WriteTexChoiceFile
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
      "$STR_TEX_NEEDED" \
      IDYES use_detected IDNO ask_install
  ${EndIf}
  Goto ask_install

  use_detected:
    StrCpy $TEX_ACTION "detected"
    Return

  ask_install:
    ; Declining a detected TeX here means the user wants a different one (or none): forget the detection
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
      "$STR_INSTALL_TEX" \
      IDYES choose_tinytex IDNO ask_more
    Goto skip_tex

  ask_more:
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
      "$STR_WHICH_DISTRO" \
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
  Push "$STR_DL_INSTALLER"
  Call ProgressStart
  nsExec::ExecToLog '"${CURL_EXE}" --proto =https --proto-redir =https --tlsv1.2 --fail --location --retry 2 --connect-timeout 30 --max-time 3600 --silent --show-error --output "$DL_DEST" "$DL_URL"'
  Pop $0
  Call ProgressEnd
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
  Push "$STR_DL_INSTALLER"
  Call ProgressStart
  nsExec::ExecToLog '"${CURL_EXE}" --proto =https --proto-redir =https,http --tlsv1.2 --fail --location --retry 2 --connect-timeout 30 --max-time 3600 --silent --show-error --output "$DL_DEST" "$DL_URL"'
  Pop $0
  Call ProgressEnd
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
; Progress helpers for TeX installation.
; Shows elapsed time and estimated time remaining in the NSIS details area.
; ------------------------------------------------------------------
Function ProgressStart
  Exch $PROGRESS_PHASE
  Pop $R0
  SetDetailsView show
  DetailPrint "$STR_PROGRESS_START$PROGRESS_PHASE"
  Call ProgressReport
FunctionEnd

Function ProgressUpdate
  ; Kept for callers that provide an explicit completed/total phase count.
  Push $R0
  Push $R1
  Push $R2
  IntOp $PROGRESS_COMPLETED $R0 + 1
  StrCpy $PROGRESS_TOTAL $R1
  Call ProgressReport
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function ProgressReport
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  ${If} $PROGRESS_TOTAL > 0
    IntOp $R0 $PROGRESS_COMPLETED * 100
    IntOp $R0 $R0 / $PROGRESS_TOTAL
  ${Else}
    StrCpy $R0 0
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r1'
  IntOp $R1 $R1 - $PROGRESS_STARTED
  IntOp $R1 $R1 / 1000
  IntOp $R2 $PROGRESS_ESTIMATE - $R1
  ${If} $R2 < 0
    StrCpy $R2 0
  ${EndIf}
  IntOp $R2 $R2 + 59
  IntOp $R2 $R2 / 60
  DetailPrint "$STR_PROGRESS$R0%% | $PROGRESS_PHASE | $STR_REMAINING$R2 min"
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function ProgressEnd
  Push $R0
  DetailPrint "$STR_PROGRESS_END$PROGRESS_PHASE"
  IntOp $PROGRESS_COMPLETED $PROGRESS_COMPLETED + 1
  Call ProgressReport
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Report a failed TeX installation (never shown for silent installs)
; ------------------------------------------------------------------
Function TexInstallFailed
  Pop $R9   ; message
  DetailPrint "$R9"
  IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$R9$\r$\n$\r$\n$STR_TEX_OK"
FunctionEnd

; ------------------------------------------------------------------
; Perform the TeX installation chosen by the user. Runs after GabeTeX itself is installed.
; Shows progress percentage and estimated time remaining.
; ------------------------------------------------------------------
Function InstallTexSilently
  StrCpy $PROGRESS_COMPLETED 0
  StrCpy $PROGRESS_TOTAL 2
  StrCpy $PROGRESS_ESTIMATE 360
  ${If} $TEX_ACTION == "install-texlive"
    StrCpy $PROGRESS_ESTIMATE 1200
  ${ElseIf} $TEX_ACTION == "install-miktex"
    StrCpy $PROGRESS_TOTAL 4
    StrCpy $PROGRESS_ESTIMATE 900
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $PROGRESS_STARTED $0

  ${If} $TEX_ACTION == "install-tinytex"
    InitPluginsDir
    Push "$STR_DL_TINYTEX"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_TINYTEX_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\install-tinytex.ps1"
    Call DownloadVerified
    ${If} $0 != 0
      Push "$STR_ERR_DL_TINYTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Push "$STR_INSTALL_TINYTEX"
    Call ProgressStart
    ; -block keeps the script running until installation finishes; -File with & ensures exit code propagation
    nsExec::ExecToLog '"${PS_EXE}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& \''$DL_DEST\'' -block"'
    Pop $0
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_TINYTEX_FAILED"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-texlive"
    InitPluginsDir
    Push "$STR_DL_TEXLIVE"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_TEXLIVE_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\install-tl-windows.exe"
    Call DownloadVerified
    ${If} $0 != 0
      Push "$STR_ERR_DL_TEXLIVE"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    ; Per-user, minimal profile: no PATH / registry-wide changes, no docs or sources.
    ; TEXDIR is intentionally left out so the installer picks the correct <year> directory.
    ; instopt_adjustpath 0 means PATH is NOT modified; detection scans known install dirs instead.
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
    Push "$STR_INSTALL_TEXLIVE"
    Call ProgressStart
    ; Run installer from PLUGINSDIR so relative paths in profile resolve correctly
    Push "$PLUGINSDIR"
    Pop $R0
    SetOutPath "$PLUGINSDIR"
    nsExec::ExecToLog '"$DL_DEST" -no-gui -profile "$PLUGINSDIR\gabetex-texlive.profile"'
    Pop $0
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_TEXLIVE_FAILED"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-miktex"
    InitPluginsDir
    Push "$STR_DL_MIKTEX"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_MIKTEX_URL}"
    StrCpy $DL_DEST "$PLUGINSDIR\miktexsetup-x64.zip"
    Call DownloadVerifiedHttp
    ${If} $0 != 0
      Push "$STR_ERR_DL_MIKTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Push "$STR_EXTRACT_MIKTEX"
    Call ProgressStart
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '$DL_DEST' -DestinationPath '$PLUGINSDIR\miktexsetup' -Force"`
    Pop $0
    Call ProgressEnd
    ${IfNot} ${FileExists} "$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe"
      Push "$STR_ERR_UNPACK_MIKTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    ; The extracted executable must carry a valid signature too
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-AuthenticodeSignature -LiteralPath '$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe').Status -in 'Valid','NotSigned') { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Push "$STR_ERR_MIKTEX_SIG"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Push "$STR_DL_MIKTEX_PKGS"
    Call ProgressStart
    nsExec::ExecToLog '"$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$PLUGINSDIR\miktex-repo" --package-set=basic download'
    Pop $0
    Call ProgressEnd
    ${If} $0 != 0
      Push "$ERR_MIKTEX_DL_FAILED"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Push "$STR_INSTALL_MIKTEX"
    Call ProgressStart
    nsExec::ExecToLog '"$PLUGINSDIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$PLUGINSDIR\miktex-repo" --package-set=basic --shared=no --modify-path=no install'
    Pop $0
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_MIKTEX_FAILED"
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
