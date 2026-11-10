; NSIS Custom Hooks for GabeTeX
; Includes TeX distribution detection and optional silent installation page.

!include "nsDialogs.nsh"
!include "logiclib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"

; ------------------------------------------------------------------
; Global state for TeX installer integration
; ------------------------------------------------------------------
Var /GLOBAL TEX_ACTION          ; install-tinytex | install-texlive | install-miktex | custom-path | skip
Var /GLOBAL TEX_CUSTOM_PATH     ; user-provided TeX bin directory
Var /GLOBAL TEX_DETECTED        ; yes | no
Var /GLOBAL TEX_DETECTED_PATH   ; path of auto-detected TeX
Var /GLOBAL TEX_DIALOG_RESULT   ; result from nsDialogs

; Download URLs (official sources)
!define TEX_TINYTEX_URL   "https://yihui.org/tinytex/install-windows.ps1"
!define TEX_TEXLIVE_URL   "https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe"
!define TEX_MIKTEX_URL    "https://miktex.org/download/ctan/systems/win32/miktex/setup/windows-x86_64/miktex-setup.exe"

; Silent install flags
!define TEX_TINYTEX_ARGS  "-NoProfile -ExecutionPolicy Bypass -File"
!define TEX_TEXLIVE_ARGS  "--profile=gabetex-texlive.profile"
!define TEX_MIKTEX_ARGS   "--shared --set-repository=https://miktex.org/download/ctan --package-set=complete --install"

; ------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
  ; Terminate any running application instance to prevent file-in-use errors during install/update
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0

  ; Show TeX distribution selection page before copying files
  Call ShowTexSelectionPage
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\GabeTeX"
  CreateShortcut "$SMPROGRAMS\GabeTeX\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$SMPROGRAMS\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$DESKTOP\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Persist the TeX choice so the app can read it on first run
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

  ; Remove persisted TeX choice file
  Delete "$LOCALAPPDATA\GabeTeX\tex-choice.json"
!macroend

; ------------------------------------------------------------------
; Detect existing TeX installations on the machine
; ------------------------------------------------------------------
Function DetectTexInstallations
  StrCpy $TEX_DETECTED "no"
  StrCpy $TEX_DETECTED_PATH ""

  ; Check common TeX Live locations (newest year first)
  ${If} ${FileExists} "C:\texlive\2026\bin\win64\pdflatex.exe"
    StrCpy $TEX_DETECTED "yes"
    StrCpy $TEX_DETECTED_PATH "C:\texlive\2026\bin\win64"
  ${ElseIf} ${FileExists} "C:\texlive\2025\bin\win64\pdflatex.exe"
    StrCpy $TEX_DETECTED "yes"
    StrCpy $TEX_DETECTED_PATH "C:\texlive\2025\bin\win64"
  ${ElseIf} ${FileExists} "C:\texlive\2024\bin\win64\pdflatex.exe"
    StrCpy $TEX_DETECTED "yes"
    StrCpy $TEX_DETECTED_PATH "C:\texlive\2024\bin\win64"
  ${EndIf}

  ; Check MiKTeX
  ${If} ${TEX_DETECTED} == "no"
    ${If} ${FileExists} "%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64"
    ${ElseIf} ${FileExists} "%ProgramFiles%\MiKTeX\miktex\bin\x64\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "%ProgramFiles%\MiKTeX\miktex\bin\x64"
    ${EndIf}
  ${EndIf}

  ; Check TinyTeX
  ${If} ${TEX_DETECTED} == "no"
    ${If} ${FileExists} "%APPDATA%\TinyTeX\bin\windows\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "%APPDATA%\TinyTeX\bin\windows"
    ${EndIf}
  ${EndIf}

  ; Check PATH for pdflatex.exe
  ${If} ${TEX_DETECTED} == "no"
    Push "pdflatex.exe"
    Call FindInPath
    Pop $TEX_DETECTED_PATH
    ${If} $TEX_DETECTED_PATH != ""
      StrCpy $TEX_DETECTED "yes"
    ${EndIf}
  ${EndIf}

FunctionEnd

; ------------------------------------------------------------------
; Find an executable in PATH (helper)
; ------------------------------------------------------------------
Function FindInPath
  Exch $R0
  StrCpy $R1 ""
  StrCpy $R2 "$PATH"
  StrCpy $R3 ";"
  StrCpy $R4 "$R2$R3"
  StrCpy $R5 0
  ${Do}
    StrCpy $R6 "$R4"
    StrLen $R7 "$R6"
    ${If} $R7 > 0
      StrCpy $R8 "$R4"
      StrCpy $R9 ""
      ${Loop}
        StrCpy $R10 "$R8" 1
        ${If} $R10 == $R3
          StrCpy $R8 ""
          StrCpy $R9 "$R9"
          Break
        ${ElseIf} $R7 == 0
          StrCpy $R8 ""
          StrCpy $R9 "$R9"
          Break
        ${Else}
          StrCpy $R9 "$R9$R10"
          StrCpy $R8 "$R8" 1 $R7
          StrLen $R7 "$R8"
        ${EndIf}
      ${EndLoop}
      ${If} $R9 != ""
        StrCmp $R9 "" 0 +2
        StrCpy $R9 "$R9\"
      ${EndIf}
      StrCpy $R1 "$R9$R0"
      ${If} ${FileExists} "$R1"
        StrCpy $R5 1
        Break
      ${EndIf}
    ${Else}
      Break
    ${EndIf}
  ${Loop}
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Show TeX distribution selection dialog
; ------------------------------------------------------------------
Function ShowTexSelectionPage
  Call DetectTexInstallations

  ; Create the dialog
  nsDialogs::Create 1018
  Pop $TEX_DIALOG_RESULT

  ${If} $TEX_DIALOG_RESULT == error
    Abort
  ${EndIf}

  ; Dialog title
  ${NSD_CreateTitle} "GabeTeX - TeX Distribution" 12 12 360 20

  ; Intro text
  ${NSD_CreateLabel} 12 40 360 40 "GabeTeX needs a LaTeX compiler to build PDF documents."
  ${NSD_CreateLabel} 12 56 360 40 "No TeX distribution was found on this machine."

  ; Existing detection info
  ${If} $TEX_DETECTED == "yes"
    ${NSD_CreateLabel} 12 80 360 20 "Detected TeX installation:"
    ${NSD_CreateLabel} 12 96 360 20 $TEX_DETECTED_PATH
  ${Else}
    ${NSD_CreateLabel} 12 80 360 20 "No TeX distribution detected."
  ${EndIf}

  ; Radio button group
  ${NSD_CreateRadioButton} 12 120 300 12 "Install TinyTeX (recommended, ~150 MB)"
  ${NSD_CreateRadioButton} 12 134 300 12 "Install TeX Live (full, several GB)"
  ${NSD_CreateRadioButton} 12 148 300 12 "Install MiKTeX (Windows native)"
  ${NSD_CreateRadioButton} 12 162 300 12 "Use an existing TeX installation (custom path)"
  ${NSD_CreateRadioButton} 12 176 300 12 "Skip (PDF compilation will not be available)"

  ; Default selection: TinyTeX if not detected, else use detected
  ${If} $TEX_DETECTED == "yes"
    ${NSD_SelectRadioButton} "Use an existing TeX installation (custom path)"
    StrCpy $TEX_ACTION "custom-path"
  ${Else}
    ${NSD_SelectRadioButton} "Install TinyTeX (recommended, ~150 MB)"
    StrCpy $TEX_ACTION "install-tinytex"
  ${EndIf}

  ; Custom path input (initially hidden)
  ${NSD_CreateLabel} 12 196 300 12 "TeX bin directory (contains pdflatex, latexmk):"
  ${NSD_CreateText} 12 210 300 12 ""
  Pop $TEX_CUSTOM_PATH
  ${NSD_ShowControl} $TEX_CUSTOM_PATH ${SW_HIDE}

  ; Buttons
  ${NSD_CreateButton} 220 240 80 24 "Install"
  Pop $TEX_DIALOG_RESULT
  ${NSD_CreateButton} 300 240 80 24 "Cancel"
  Pop $TEX_DIALOG_RESULT

  ; Show dialog
  nsDialogs::Show

  ; Handle button click result
  ${If} $TEX_DIALOG_RESULT == IDOK
    ; Determine which radio button is selected
    ${NSD_GetRadioButtonState} "Install TinyTeX (recommended, ~150 MB)"
    ${If} $TEX_DIALOG_RESULT == 1
      StrCpy $TEX_ACTION "install-tinytex"
    ${EndIf}

    ${NSD_GetRadioButtonState} "Install TeX Live (full, several GB)"
    ${If} $TEX_DIALOG_RESULT == 1
      StrCpy $TEX_ACTION "install-texlive"
    ${EndIf}

    ${NSD_GetRadioButtonState} "Install MiKTeX (Windows native)"
    ${If} $TEX_DIALOG_RESULT == 1
      StrCpy $TEX_ACTION "install-miktex"
    ${EndIf}

    ${NSD_GetRadioButtonState} "Use an existing TeX installation (custom path)"
    ${If} $TEX_DIALOG_RESULT == 1
      StrCpy $TEX_ACTION "custom-path"
      ${NSD_GetText} $TEX_CUSTOM_PATH $TEX_CUSTOM_PATH
      ${If} $TEX_CUSTOM_PATH == ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "Please enter a TeX bin directory."
        Call ShowTexSelectionPage
      ${EndIf}
    ${EndIf}

    ${NSD_GetRadioButtonState} "Skip (PDF compilation will not be available)"
    ${If} $TEX_DIALOG_RESULT == 1
      StrCpy $TEX_ACTION "skip"
    ${EndIf}
  ${Else}
    ; User cancelled - default to skip
    StrCpy $TEX_ACTION "skip"
  ${EndIf}

FunctionEnd

; ------------------------------------------------------------------
; Perform silent TeX installation based on user choice
; ------------------------------------------------------------------
Function InstallTexSilently
  ${If} $TEX_ACTION == "install-tinytex"
    DetailPrint "Downloading and installing TinyTeX..."
    ; Download the installer script
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri ''$(TEX_TINYTEX_URL)'' -OutFile ''$TEMP\install-tinytex.ps1''"'
    Pop $0
    ${If} $0 == 0
      ; Run the TinyTeX installer silently
      nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\install-tinytex.ps1"'
      Pop $0
      ${If} $0 == 0
        StrCpy $TEX_DETECTED "yes"
        StrCpy $TEX_DETECTED_PATH "%APPDATA%\TinyTeX\bin\windows"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "TinyTeX installation failed. You can install it later from https://yihui.org/tinytex/."
      ${EndIf}
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to download TinyTeX installer. Check your internet connection."
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-texlive"
    DetailPrint "Downloading and installing TeX Live..."
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri ''$(TEX_TEXLIVE_URL)'' -OutFile ''$TEMP\install-tl-windows.exe''"'
    Pop $0
    ${If} $0 == 0
      ; Create a minimal profile for silent install
      FileOpen $1 "$TEMP\gabetex-texlive.profile" w
      FileWrite $1 "selected_scheme scheme-small${NL}"
      FileWrite $1 "TEXDIR C:\texlive\2026${NL}"
      FileWrite $1 "TEXMFLOCAL C:\texlive\texmf-local${NL}"
      FileWrite $1 "TEXMFSYSCONFIG C:\texlive\texmf-config${NL}"
      FileWrite $1 "TEXMFSYSVAR C:\texlive\texmf-var${NL}"
      FileWrite $1 "TEXMFHOME ~/texmf${NL}"
      FileWrite $1 "instopt_adjustpath 1${NL}"
      FileWrite $1 "instopt_letter 0${NL}"
      FileWrite $1 "instopt_write18_restricted 1${NL}"
      FileWrite $1 "instopt_portable 0${NL}"
      FileClose $1

      nsExec::Exec '"$TEMP\install-tl-windows.exe" --profile="$TEMP\gabetex-texlive.profile"'
      Pop $0
      ${If} $0 == 0
        StrCpy $TEX_DETECTED "yes"
        StrCpy $TEX_DETECTED_PATH "C:\texlive\2026\bin\win64"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "TeX Live installation failed. You can install it later from https://tug.org/texlive/."
      ${EndIf}
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to download TeX Live installer. Check your internet connection."
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "install-miktex"
    DetailPrint "Downloading and installing MiKTeX..."
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri ''$(TEX_MIKTEX_URL)'' -OutFile ''$TEMP\miktex-setup.exe''"'
    Pop $0
    ${If} $0 == 0
      nsExec::Exec '"$TEMP\miktex-setup.exe" $(TEX_MIKTEX_ARGS)'
      Pop $0
      ${If} $0 == 0
        StrCpy $TEX_DETECTED "yes"
        StrCpy $TEX_DETECTED_PATH "%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "MiKTeX installation failed. You can install it later from https://miktex.org/."
      ${EndIf}
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to download MiKTeX installer. Check your internet connection."
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "custom-path"
    ; Validate the custom path contains pdflatex or latexmk
    ${If} ${FileExists} "$TEX_CUSTOM_PATH\pdflatex.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$TEX_CUSTOM_PATH"
    ${ElseIf} ${FileExists} "$TEX_CUSTOM_PATH\latexmk.exe"
      StrCpy $TEX_DETECTED "yes"
      StrCpy $TEX_DETECTED_PATH "$TEX_CUSTOM_PATH"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The specified path does not contain pdflatex.exe or latexmk.exe. TeX compilation will not work."
      StrCpy $TEX_DETECTED "no"
    ${EndIf}

  ${ElseIf} $TEX_ACTION == "skip"
    StrCpy $TEX_DETECTED "no"
    StrCpy $TEX_DETECTED_PATH ""
  ${EndIf}

FunctionEnd

; ------------------------------------------------------------------
; Write the TeX choice to a JSON file for the app to read
; ------------------------------------------------------------------
Function WriteTexChoiceFile
  ; Create the GabeTeX config directory
  CreateDirectory "$LOCALAPPDATA\GabeTeX"

  ; Write JSON with the TeX choice
  FileOpen $1 "$LOCALAPPDATA\GabeTeX\tex-choice.json" w
  FileWrite $1 "{"${NL}
  FileWrite $1 "  ""action"": ""$TEX_ACTION""${NL}"
  FileWrite $1 "  ""detected"": ""$TEX_DETECTED""${NL}"
  FileWrite $1 "  ""path"": ""$TEX_DETECTED_PATH""${NL}"
  FileWrite $1 "}"${NL}
  FileClose $1

FunctionEnd
