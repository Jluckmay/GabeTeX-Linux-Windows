; NSIS Custom Hooks for GabeTeX
; Includes TeX distribution detection and integrated silent installation.
; Uses nsDialogs for an in-window selection page (no MessageBox popups or external windows).
;
; Flow:
;   PageTexSelection -> in-window radio selection (detect existing TeX, or pick TinyTeX/TeX Live/MiKTeX/Skip)
;   POSTINSTALL      -> InstallTexSilently     (runs hidden via nsExec::ExecToLog after GabeTeX files are copied)
;                    -> WriteTexChoiceFile     (persists %LOCALAPPDATA%\GabeTeX\tex-choice.json for the app)
;
; Security model for downloads (see DownloadVerified):
;   * official HTTPS sources only; curl.exe enforces https for the URL *and* for every redirect (TLS >= 1.2)
;   * downloads/extraction use a verified ASCII writable directory (no broken 8.3 short paths on Unicode profiles)
;   * Authenticode check: signed files must have a *valid* signature (tampered/invalid ones are rejected)
;   * system tools are always invoked through absolute $SYSDIR paths (no PATH / current-directory lookup)
;   * installation success is decided by the presence of pdflatex.exe, never by an exit code alone

!include "logiclib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "nsDialogs.nsh"

; ------------------------------------------------------------------
; Global state for TeX installer integration
; ------------------------------------------------------------------
Var /GLOBAL TEX_ACTION          ; install-tinytex | install-texlive | install-miktex | detected | keep | skip
Var /GLOBAL TEX_DETECTED        ; yes | no
Var /GLOBAL TEX_DETECTED_PATH   ; bin directory of the detected / installed TeX
Var /GLOBAL TEX_WORK_DIR        ; ASCII-safe writable directory for downloads & temp env
Var /GLOBAL DL_URL
Var /GLOBAL DL_DEST
Var /GLOBAL JSON_IN
Var /GLOBAL JSON_OUT

; Integrated TeX selection wizard page controls
Var /GLOBAL TEX_DLG
Var /GLOBAL TEX_RADIO_DETECTED
Var /GLOBAL TEX_RADIO_TINYTEX
Var /GLOBAL TEX_RADIO_TEXLIVE
Var /GLOBAL TEX_RADIO_MIKTEX
Var /GLOBAL TEX_RADIO_SKIP

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
Var /GLOBAL STR_TEX_PAGE_TITLE
Var /GLOBAL STR_TEX_PAGE_SUBTITLE
Var /GLOBAL STR_TEX_PAGE_DESC
Var /GLOBAL STR_OPT_DETECTED
Var /GLOBAL STR_OPT_TINYTEX
Var /GLOBAL STR_OPT_TEXLIVE
Var /GLOBAL STR_OPT_MIKTEX
Var /GLOBAL STR_OPT_SKIP
Var /GLOBAL STR_DL_TINYTEX
Var /GLOBAL STR_INSTALL_TINYTEX
Var /GLOBAL STR_ERR_DL_TINYTEX
Var /GLOBAL ERR_TINYTEX_FAILED_PRE
Var /GLOBAL TEX_OLD_TEMP
Var /GLOBAL TEX_OLD_TMP
Var /GLOBAL TEX_INSTALL_EXITCODE
Var /GLOBAL STR_DL_TEXLIVE
Var /GLOBAL STR_EXTRACT_TEXLIVE
Var /GLOBAL STR_ERR_UNPACK_TEXLIVE
Var /GLOBAL STR_INSTALL_TEXLIVE
Var /GLOBAL STR_ERR_DL_TEXLIVE
Var /GLOBAL ERR_TEXLIVE_FAILED_PRE
Var /GLOBAL STR_DL_MIKTEX
Var /GLOBAL STR_EXTRACT_MIKTEX
Var /GLOBAL STR_ERR_UNPACK_MIKTEX
Var /GLOBAL STR_ERR_MIKTEX_SIG
Var /GLOBAL STR_DL_MIKTEX_PKGS
Var /GLOBAL STR_ERR_DL_MIKTEX
Var /GLOBAL STR_ERR_MIKTEX_HASH
Var /GLOBAL ERR_MIKTEX_DL_FAILED_PRE
Var /GLOBAL STR_INSTALL_MIKTEX
Var /GLOBAL ERR_MIKTEX_FAILED_PRE
Var /GLOBAL STR_TEX_OK

; Initialize localized strings based on system language (must be called before any UI text is shown)
Function InitLangStrings
  StrCpy $STR_ERR_MIKTEX_HASH "MiKTeX installer integrity verification failed."
  ; Use the Windows user's display language, independent of the NSIS language selector.
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  ${If} $0 == 1046
    StrCpy $STR_ERR_MIKTEX_HASH "Falha na verificação de integridade do instalador MiKTeX."
    StrCpy $STR_DL_INSTALLER "Baixando instalador..."
    StrCpy $STR_PROGRESS "Progresso: "
    StrCpy $STR_PROGRESS_START "Iniciando: "
    StrCpy $STR_PROGRESS_END "Concluído: "
    StrCpy $STR_REMAINING "Tempo estimado restante: "
    StrCpy $STR_TEX_PAGE_TITLE "Distribuição LaTeX"
    StrCpy $STR_TEX_PAGE_SUBTITLE "Escolha como o GabeTeX compilará documentos LaTeX."
    StrCpy $STR_TEX_PAGE_DESC "Os arquivos são baixados via HTTPS dos sites oficiais dos projetos e instalados de forma integrada nesta janela."
    StrCpy $STR_OPT_DETECTED "Usar instalação TeX detectada:"
    StrCpy $STR_OPT_TINYTEX "Instalar TinyTeX (recomendado, download pequeno)"
    StrCpy $STR_OPT_TEXLIVE "Instalar TeX Live (scheme-small, download completo)"
    StrCpy $STR_OPT_MIKTEX "Instalar MiKTeX (conjunto básico, pacotes sob demanda)"
    StrCpy $STR_OPT_SKIP "Não instalar distribuição TeX agora (usar Tectonic WASM ou configurar depois)"
    StrCpy $STR_DL_TINYTEX "Baixando TinyTeX..."
    StrCpy $STR_INSTALL_TINYTEX "Instalando TinyTeX..."
    StrCpy $STR_ERR_DL_TINYTEX "Não foi possível baixar o instalador do TinyTeX com segurança."
    StrCpy $ERR_TINYTEX_FAILED_PRE "A instalação do TinyTeX não foi concluída (código de saída "
    StrCpy $STR_DL_TEXLIVE "Baixando TeX Live..."
    StrCpy $STR_EXTRACT_TEXLIVE "Extraindo TeX Live..."
    StrCpy $STR_ERR_UNPACK_TEXLIVE "Não foi possível descompactar o instalador do TeX Live."
    StrCpy $STR_INSTALL_TEXLIVE "Instalando TeX Live..."
    StrCpy $STR_ERR_DL_TEXLIVE "Não foi possível baixar o instalador do TeX Live com segurança."
    StrCpy $ERR_TEXLIVE_FAILED_PRE "A instalação do TeX Live não foi concluída (código de saída "
    StrCpy $STR_DL_MIKTEX "Baixando MiKTeX..."
    StrCpy $STR_EXTRACT_MIKTEX "Extraindo MiKTeX..."
    StrCpy $STR_ERR_UNPACK_MIKTEX "Não foi possível descompactar o utilitário de instalação do MiKTeX."
    StrCpy $STR_ERR_MIKTEX_SIG "O utilitário de instalação do MiKTeX falhou na verificação de assinatura."
    StrCpy $STR_DL_MIKTEX_PKGS "Baixando pacotes MiKTeX..."
    StrCpy $STR_ERR_DL_MIKTEX "Não foi possível baixar o utilitário de instalação do MiKTeX com segurança."
    StrCpy $ERR_MIKTEX_DL_FAILED_PRE "Falha no download dos pacotes MiKTeX (código de saída "
    StrCpy $STR_INSTALL_MIKTEX "Instalando MiKTeX..."
    StrCpy $ERR_MIKTEX_FAILED_PRE "A instalação do MiKTeX não foi concluída (código de saída "
    StrCpy $STR_TEX_OK "O GabeTeX foi instalado corretamente. Você pode instalar o TeX depois e selecioná-lo em Configurações."
  ${Else}
    StrCpy $STR_DL_INSTALLER "Downloading installer..."
    StrCpy $STR_PROGRESS "Progress: "
    StrCpy $STR_PROGRESS_START "Starting: "
    StrCpy $STR_PROGRESS_END "Completed: "
    StrCpy $STR_REMAINING "Estimated time remaining: "
    StrCpy $STR_TEX_PAGE_TITLE "LaTeX Distribution"
    StrCpy $STR_TEX_PAGE_SUBTITLE "Choose how GabeTeX will compile LaTeX documents."
    StrCpy $STR_TEX_PAGE_DESC "Files are downloaded over HTTPS from the official project sites and installed inside this window."
    StrCpy $STR_OPT_DETECTED "Use detected TeX installation:"
    StrCpy $STR_OPT_TINYTEX "Install TinyTeX (recommended, small download)"
    StrCpy $STR_OPT_TEXLIVE "Install TeX Live (scheme-small, larger download)"
    StrCpy $STR_OPT_MIKTEX "Install MiKTeX (basic set, packages on demand)"
    StrCpy $STR_OPT_SKIP "Do not install a TeX distribution now (use Tectonic WASM or configure later)"
    StrCpy $STR_DL_TINYTEX "Downloading TinyTeX..."
    StrCpy $STR_INSTALL_TINYTEX "Installing TinyTeX..."
    StrCpy $STR_ERR_DL_TINYTEX "Could not download the TinyTeX installer securely."
    StrCpy $ERR_TINYTEX_FAILED_PRE "TinyTeX installation did not complete (exit code "
    StrCpy $STR_DL_TEXLIVE "Downloading TeX Live..."
    StrCpy $STR_EXTRACT_TEXLIVE "Extracting TeX Live..."
    StrCpy $STR_ERR_UNPACK_TEXLIVE "Could not unpack the TeX Live installer."
    StrCpy $STR_INSTALL_TEXLIVE "Installing TeX Live..."
    StrCpy $STR_ERR_DL_TEXLIVE "Could not download the TeX Live installer securely."
    StrCpy $ERR_TEXLIVE_FAILED_PRE "TeX Live installation did not complete (exit code "
    StrCpy $STR_DL_MIKTEX "Downloading MiKTeX..."
    StrCpy $STR_EXTRACT_MIKTEX "Extracting MiKTeX..."
    StrCpy $STR_ERR_UNPACK_MIKTEX "Could not unpack the MiKTeX setup utility."
    StrCpy $STR_ERR_MIKTEX_SIG "The MiKTeX setup utility failed signature verification."
    StrCpy $STR_DL_MIKTEX_PKGS "Downloading MiKTeX packages..."
    StrCpy $STR_ERR_DL_MIKTEX "Could not download the MiKTeX setup utility securely."
    StrCpy $ERR_MIKTEX_DL_FAILED_PRE "MiKTeX package download failed (exit code "
    StrCpy $STR_INSTALL_MIKTEX "Installing MiKTeX..."
    StrCpy $ERR_MIKTEX_FAILED_PRE "MiKTeX installation did not complete (exit code "
    StrCpy $STR_TEX_OK "GabeTeX was installed correctly. You can install TeX later and select it in Settings."
  ${EndIf}
FunctionEnd

; Download URLs (official sources, all HTTPS)
!define TEX_TINYTEX_URL   "https://tinytex.yihui.org/install-bin-windows.ps1"
!define TEX_TEXLIVE_URL   "https://mirror.ctan.org/systems/texlive/tlnet/install-tl.zip"
!define TEX_MIKTEX_URL    "https://miktex.org/download/win/miktexsetup-x64.zip"
; MiKTeX's setup archive is unsigned; pin the official archive to prevent mirror substitution.
!define TEX_MIKTEX_SHA256 "0571E90F6D94353089B4F189FD82A532F9FE559A388C7E7F1102B14B3C1AE27D"

!define PS_EXE "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define CURL_EXE "$SYSDIR\curl.exe"

!macro NSIS_HOOK_PREINSTALL
  Call InitLangStrings
  ; Terminate any running application instance to prevent file-in-use errors during install/update
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0

  ; Passive or silent installs skip custom pages; resolve a non-interactive default without dialogs.
  ${If} $TEX_ACTION == ""
    ${If} $UpdateMode = 1
    ${AndIf} ${FileExists} "$LOCALAPPDATA\GabeTeX\tex-choice.json"
      StrCpy $TEX_ACTION "keep"
    ${Else}
      Call DetectTexInstallations
      ${If} $TEX_DETECTED == "yes"
        StrCpy $TEX_ACTION "detected"
      ${Else}
        StrCpy $TEX_ACTION "skip"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Call InitLangStrings
  SetShellVarContext current

  ; Install the optional distribution after the GabeTeX files are copied and before Finish.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ; Silent/passive installs do not show the TeX selection prompt.
  ${Else}
    Call InstallTexSilently
  ${EndIf}
  Call WriteTexChoiceFile

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
  ${If} $TEX_DETECTED == "no"
    ReadEnvStr $R0 "ProgramData"
    ${If} $R0 != ""
      Push "$R0\texlive"
      Call ScanTexLiveRoot
    ${EndIf}
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
; Integrated TeX selection wizard page (replaces all MessageBox popups)
; ------------------------------------------------------------------
Function PageTexSelection
  Call InitLangStrings

  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call DetectTexInstallations
    ${If} $TEX_DETECTED == "yes"
      StrCpy $TEX_ACTION "detected"
    ${Else}
      StrCpy $TEX_ACTION "skip"
    ${EndIf}
    Abort
  ${EndIf}

  ${If} $UpdateMode = 1
  ${AndIf} ${FileExists} "$LOCALAPPDATA\GabeTeX\tex-choice.json"
    StrCpy $TEX_ACTION "keep"
    Abort
  ${EndIf}

  Call DetectTexInstallations

  !insertmacro MUI_HEADER_TEXT "$STR_TEX_PAGE_TITLE" "$STR_TEX_PAGE_SUBTITLE"
  nsDialogs::Create 1018
  Pop $TEX_DLG
  ${If} $TEX_DLG == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 24u "$STR_TEX_PAGE_DESC"
  Pop $0

  StrCpy $TEX_RADIO_DETECTED ""
  StrCpy $TEX_RADIO_TINYTEX ""
  StrCpy $TEX_RADIO_TEXLIVE ""
  StrCpy $TEX_RADIO_MIKTEX ""
  StrCpy $TEX_RADIO_SKIP ""

  ${If} $TEX_DETECTED == "yes"
    ${NSD_CreateFirstRadioButton} 0 28u 100% 20u "$STR_OPT_DETECTED ($TEX_DETECTED_PATH)"
    Pop $TEX_RADIO_DETECTED
    ${NSD_CreateAdditionalRadioButton} 0 52u 100% 14u "$STR_OPT_TINYTEX"
    Pop $TEX_RADIO_TINYTEX
    ${NSD_CreateAdditionalRadioButton} 0 70u 100% 14u "$STR_OPT_TEXLIVE"
    Pop $TEX_RADIO_TEXLIVE
    ${NSD_CreateAdditionalRadioButton} 0 88u 100% 14u "$STR_OPT_MIKTEX"
    Pop $TEX_RADIO_MIKTEX
    ${NSD_CreateAdditionalRadioButton} 0 106u 100% 14u "$STR_OPT_SKIP"
    Pop $TEX_RADIO_SKIP

    ${If} $TEX_ACTION == "install-tinytex"
      ${NSD_Check} $TEX_RADIO_TINYTEX
    ${ElseIf} $TEX_ACTION == "install-texlive"
      ${NSD_Check} $TEX_RADIO_TEXLIVE
    ${ElseIf} $TEX_ACTION == "install-miktex"
      ${NSD_Check} $TEX_RADIO_MIKTEX
    ${ElseIf} $TEX_ACTION == "skip"
      ${NSD_Check} $TEX_RADIO_SKIP
    ${Else}
      ${NSD_Check} $TEX_RADIO_DETECTED
    ${EndIf}
  ${Else}
    ${NSD_CreateFirstRadioButton} 0 30u 100% 16u "$STR_OPT_TINYTEX"
    Pop $TEX_RADIO_TINYTEX
    ${NSD_CreateAdditionalRadioButton} 0 52u 100% 16u "$STR_OPT_TEXLIVE"
    Pop $TEX_RADIO_TEXLIVE
    ${NSD_CreateAdditionalRadioButton} 0 74u 100% 16u "$STR_OPT_MIKTEX"
    Pop $TEX_RADIO_MIKTEX
    ${NSD_CreateAdditionalRadioButton} 0 96u 100% 16u "$STR_OPT_SKIP"
    Pop $TEX_RADIO_SKIP

    ${If} $TEX_ACTION == "install-texlive"
      ${NSD_Check} $TEX_RADIO_TEXLIVE
    ${ElseIf} $TEX_ACTION == "install-miktex"
      ${NSD_Check} $TEX_RADIO_MIKTEX
    ${ElseIf} $TEX_ACTION == "skip"
      ${NSD_Check} $TEX_RADIO_SKIP
    ${Else}
      ${NSD_Check} $TEX_RADIO_TINYTEX
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function PageTexSelectionLeave
  StrCpy $TEX_ACTION "skip"

  ${If} $TEX_RADIO_DETECTED != ""
    ${NSD_GetState} $TEX_RADIO_DETECTED $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $TEX_ACTION "detected"
      Return
    ${EndIf}
  ${EndIf}

  ${NSD_GetState} $TEX_RADIO_TINYTEX $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TEX_ACTION "install-tinytex"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
    Return
  ${EndIf}

  ${NSD_GetState} $TEX_RADIO_TEXLIVE $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TEX_ACTION "install-texlive"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
    Return
  ${EndIf}

  ${NSD_GetState} $TEX_RADIO_MIKTEX $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TEX_ACTION "install-miktex"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
    Return
  ${EndIf}

  StrCpy $TEX_ACTION "skip"
  StrCpy $TEX_DETECTED "no"
  StrCpy $TEX_DETECTED_PATH ""
FunctionEnd

; ------------------------------------------------------------------
; Find or create an ASCII-only writable work directory so tools like
; PowerShell (`cd $env:TEMP`) and Perl do not fail on 8.3 / Unicode paths.
; ------------------------------------------------------------------
Function ProbeWritableDir
  Exch $R0
  Push $R1
  Push $R2
  StrCpy $R1 "fail"
  CreateDirectory "$R0"
  ClearErrors
  FileOpen $R2 "$R0\.gabetex-write-test" w
  ${IfNot} ${Errors}
    FileWrite $R2 "ok"
    FileClose $R2
    Delete "$R0\.gabetex-write-test"
    StrCpy $R1 "ok"
  ${EndIf}
  StrCpy $R0 $R1
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Function PrepareAsciiTexWorkDir
  Push $R0
  Push $R1
  Push $R2
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $TEX_WORK_DIR ""

  ReadEnvStr $R0 "ProgramData"
  ${If} $R0 != ""
    StrCpy $R1 "$R0\GabeTeX-tex-$0"
    Push "$R1"
    Call ProbeWritableDir
    Pop $R2
    ${If} $R2 == "ok"
      StrCpy $TEX_WORK_DIR "$R1"
      Goto workdir_ready
    ${EndIf}
  ${EndIf}

  ReadEnvStr $R0 "PUBLIC"
  ${If} $R0 != ""
    StrCpy $R1 "$R0\GabeTeX-tex-$0"
    Push "$R1"
    Call ProbeWritableDir
    Pop $R2
    ${If} $R2 == "ok"
      StrCpy $TEX_WORK_DIR "$R1"
      Goto workdir_ready
    ${EndIf}
  ${EndIf}

  InitPluginsDir
  StrCpy $TEX_WORK_DIR "$PLUGINSDIR\tex-work"
  CreateDirectory "$TEX_WORK_DIR"

  workdir_ready:
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function SaveAndSetTexTemp
  ReadEnvStr $TEX_OLD_TEMP TEMP
  ReadEnvStr $TEX_OLD_TMP TMP
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$TEX_WORK_DIR")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$TEX_WORK_DIR")'
FunctionEnd

Function RestoreTexTemp
  ${If} $TEX_OLD_TEMP == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$TEX_OLD_TEMP")'
  ${EndIf}
  ${If} $TEX_OLD_TMP == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$TEX_OLD_TMP")'
  ${EndIf}
FunctionEnd

Function CleanupAsciiTexWorkDir
  ${If} $TEX_WORK_DIR != ""
  ${AndIf} $TEX_WORK_DIR != "$PLUGINSDIR\tex-work"
    SetOutPath "$INSTDIR"
    nsExec::Exec 'cmd.exe /c if exist "$TEX_WORK_DIR" rmdir /s /q "$TEX_WORK_DIR"'
    Pop $0
  ${EndIf}
  StrCpy $TEX_WORK_DIR ""
FunctionEnd

; ------------------------------------------------------------------
; Secure download of $DL_URL into $DL_DEST. Result in $0 (0 = success).
; --proto and --proto-redir require HTTPS for the initial request and all redirects.
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
; Report a failed TeX installation inside the installer log (no popup windows)
; ------------------------------------------------------------------
Function TexInstallFailed
  Pop $R9   ; message
  DetailPrint "$R9"
  DetailPrint "$STR_TEX_OK"
FunctionEnd

; ------------------------------------------------------------------
; Perform the TeX installation chosen by the user. Runs after GabeTeX itself is installed.
; Shows progress percentage and estimated time remaining inside the installer window.
; ------------------------------------------------------------------
Function InstallTexSilently
  StrCpy $PROGRESS_COMPLETED 0
  StrCpy $PROGRESS_TOTAL 2
  StrCpy $PROGRESS_ESTIMATE 360
  ${If} $TEX_ACTION == "install-texlive"
    StrCpy $PROGRESS_TOTAL 3
    StrCpy $PROGRESS_ESTIMATE 1200
  ${ElseIf} $TEX_ACTION == "install-miktex"
    StrCpy $PROGRESS_TOTAL 4
    StrCpy $PROGRESS_ESTIMATE 900
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $PROGRESS_STARTED $0

  ${If} $TEX_ACTION == "install-tinytex"
    Call PrepareAsciiTexWorkDir
    Push "$STR_DL_TINYTEX"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_TINYTEX_URL}"
    StrCpy $DL_DEST "$TEX_WORK_DIR\install-tinytex.ps1"
    Call DownloadVerified
    ${If} $0 != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_DL_TINYTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Call ProgressEnd

    Push "$STR_INSTALL_TINYTEX"
    Call ProgressStart
    Call SaveAndSetTexTemp
    SetOutPath "$TEX_WORK_DIR"
    ; -File waits synchronously and preserves the script's exit status.
    nsExec::ExecToLog '"${PS_EXE}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DL_DEST"'
    Pop $TEX_INSTALL_EXITCODE
    Call RestoreTexTemp
    Call CleanupAsciiTexWorkDir
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_TINYTEX_FAILED_PRE$TEX_INSTALL_EXITCODE)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-texlive"
    Call PrepareAsciiTexWorkDir
    Push "$STR_DL_TEXLIVE"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_TEXLIVE_URL}"
    StrCpy $DL_DEST "$TEX_WORK_DIR\install-tl.zip"
    Call DownloadVerified
    ${If} $0 != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_DL_TEXLIVE"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Call ProgressEnd

    Push "$STR_EXTRACT_TEXLIVE"
    Call ProgressStart
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '$DL_DEST' -DestinationPath '$TEX_WORK_DIR\install-tl' -Force"`
    Pop $TEX_INSTALL_EXITCODE
    Call ProgressEnd
    ${If} $TEX_INSTALL_EXITCODE != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_UNPACK_TEXLIVE"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

    Push "$STR_INSTALL_TEXLIVE"
    Call ProgressStart
    Call SaveAndSetTexTemp
    SetOutPath "$TEX_WORK_DIR"
    ; Generate a self-contained script in $TEX_WORK_DIR so quoting and exit code stay clean.
    FileOpen $1 "$TEX_WORK_DIR\run-texlive.ps1" w
    FileWrite $1 "$$ErrorActionPreference = 'Stop'$\r$\n"
    FileWrite $1 "$$bat = Get-ChildItem -LiteralPath '$TEX_WORK_DIR\install-tl' -Filter 'install-tl-windows.bat' -Recurse | Select-Object -First 1$\r$\n"
    FileWrite $1 "if (-not $$bat) { exit 2 }$\r$\n"
    FileWrite $1 "$$tlDir = $$bat.DirectoryName$\r$\n"
    FileWrite $1 "$$rel = Get-Content (Join-Path $$tlDir 'release-texlive.txt') -TotalCount 1 -ErrorAction SilentlyContinue$\r$\n"
    FileWrite $1 "if ($$rel -match '(20\d{2})') { $$yr = $$Matches[1] } else { $$yr = (Get-Date).ToString('yyyy') }$\r$\n"
    FileWrite $1 "if ($$env:LOCALAPPDATA -match '^[!-~]+$$') { $$base = ($$env:LOCALAPPDATA -replace '\\','/') + '/Programs/texlive' } else { $$base = ($$env:ProgramData -replace '\\','/') + '/texlive' }$\r$\n"
    FileWrite $1 "$$prof = '$TEX_WORK_DIR\gabetex-texlive.profile'$\r$\n"
    FileWrite $1 "@($\r$\n"
    FileWrite $1 "  'selected_scheme scheme-small',$\r$\n"
    FileWrite $1 "  ('TEXDIR ' + $$base + '/' + $$yr),$\r$\n"
    FileWrite $1 "  ('TEXMFLOCAL ' + $$base + '/texmf-local'),$\r$\n"
    FileWrite $1 "  ('TEXMFSYSVAR ' + $$base + '/' + $$yr + '/texmf-var'),$\r$\n"
    FileWrite $1 "  ('TEXMFSYSCONFIG ' + $$base + '/' + $$yr + '/texmf-config'),$\r$\n"
    FileWrite $1 "  ('TEXMFHOME ' + $$base + '/texmf'),$\r$\n"
    FileWrite $1 "  ('TEXMFCONFIG ' + $$base + '/' + $$yr + '/texmf-config-user'),$\r$\n"
    FileWrite $1 "  ('TEXMFVAR ' + $$base + '/' + $$yr + '/texmf-var-user'),$\r$\n"
    FileWrite $1 "  'instopt_adjustpath 0',$\r$\n"
    FileWrite $1 "  'instopt_letter 0',$\r$\n"
    FileWrite $1 "  'instopt_portable 0',$\r$\n"
    FileWrite $1 "  'instopt_write18_restricted 1',$\r$\n"
    FileWrite $1 "  'tlpdbopt_install_docfiles 0',$\r$\n"
    FileWrite $1 "  'tlpdbopt_install_srcfiles 0',$\r$\n"
    FileWrite $1 "  'tlpdbopt_desktop_integration 0',$\r$\n"
    FileWrite $1 "  'tlpdbopt_file_assocs 0',$\r$\n"
    FileWrite $1 "  'tlpdbopt_w32_multi_user 0'$\r$\n"
    FileWrite $1 ") | Set-Content -LiteralPath $$prof -Encoding ASCII$\r$\n"
    FileWrite $1 "$$env:TERM = 'dumb'$\r$\n"
    FileWrite $1 "$$env:TEXLIVE_INSTALL_NO_WELCOME = '1'$\r$\n"
    FileWrite $1 "Set-Location -LiteralPath $$tlDir$\r$\n"
    FileWrite $1 "& $$bat.FullName '--no-gui' '--profile' $$prof$\r$\n"
    FileWrite $1 "exit $$LASTEXITCODE$\r$\n"
    FileClose $1
    nsExec::ExecToLog '"${PS_EXE}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEX_WORK_DIR\run-texlive.ps1"'
    Pop $TEX_INSTALL_EXITCODE
    Call RestoreTexTemp
    Call CleanupAsciiTexWorkDir
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_TEXLIVE_FAILED_PRE$TEX_INSTALL_EXITCODE)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-miktex"
    Call PrepareAsciiTexWorkDir
    Push "$STR_DL_MIKTEX"
    Call ProgressStart
    StrCpy $DL_URL "${TEX_MIKTEX_URL}"
    StrCpy $DL_DEST "$TEX_WORK_DIR\miktexsetup-x64.zip"
    Call DownloadVerified
    ${If} $0 != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_DL_MIKTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-FileHash -LiteralPath '$DL_DEST' -Algorithm SHA256).Hash -ne '${TEX_MIKTEX_SHA256}') { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_MIKTEX_HASH"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Call ProgressEnd

    Push "$STR_EXTRACT_MIKTEX"
    Call ProgressStart
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '$DL_DEST' -DestinationPath '$TEX_WORK_DIR\miktexsetup' -Force"`
    Pop $0
    Call ProgressEnd
    ${IfNot} ${FileExists} "$TEX_WORK_DIR\miktexsetup\miktexsetup_standalone.exe"
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_UNPACK_MIKTEX"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    ; The extracted executable must carry a valid signature too
    nsExec::ExecToLog `"${PS_EXE}" -NoProfile -NonInteractive -Command "if ((Get-AuthenticodeSignature -LiteralPath '$TEX_WORK_DIR\miktexsetup\miktexsetup_standalone.exe').Status -in 'Valid','NotSigned') { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      Call CleanupAsciiTexWorkDir
      Push "$STR_ERR_MIKTEX_SIG"
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}

    Call SaveAndSetTexTemp
    SetOutPath "$TEX_WORK_DIR"
    Push "$STR_DL_MIKTEX_PKGS"
    Call ProgressStart
    nsExec::ExecToLog '"$TEX_WORK_DIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$TEX_WORK_DIR\miktex-repo" --package-set=basic download'
    Pop $TEX_INSTALL_EXITCODE
    Call ProgressEnd
    ${If} $TEX_INSTALL_EXITCODE != 0
      Call RestoreTexTemp
      Call CleanupAsciiTexWorkDir
      Push "$ERR_MIKTEX_DL_FAILED_PRE$TEX_INSTALL_EXITCODE)."
      Call TexInstallFailed
      Goto reset_failed
    ${EndIf}
    Push "$STR_INSTALL_MIKTEX"
    Call ProgressStart
    nsExec::ExecToLog '"$TEX_WORK_DIR\miktexsetup\miktexsetup_standalone.exe" --quiet --local-package-repository="$TEX_WORK_DIR\miktex-repo" --package-set=basic --shared=no --modify-path=no install'
    Pop $TEX_INSTALL_EXITCODE
    Call RestoreTexTemp
    Call CleanupAsciiTexWorkDir
    Call ProgressEnd
    Call DetectTexInstallations
    ${If} $TEX_DETECTED != "yes"
      Push "$ERR_MIKTEX_FAILED_PRE$TEX_INSTALL_EXITCODE)."
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
