; NSIS Custom Hooks for GabeTeX
; Includes TeX distribution detection and optional silent installation page.
; Uses only native NSIS commands (no nsDialogs dependency).

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
    Call FindInPath
    ${If} $TEX_DETECTED_PATH != ""
      StrCpy $TEX_DETECTED "yes"
    ${EndIf}
  ${EndIf}

FunctionEnd

; ------------------------------------------------------------------
; Find an executable in PATH (helper)
; Sets $TEX_DETECTED_PATH to the directory containing the executable.
; ------------------------------------------------------------------
Function FindInPath
  Push $R0
  Push $R1
  StrCpy $TEX_DETECTED_PATH ""
  nsExec::Exec 'cmd.exe /c where pdflatex.exe > "$TEMP\gabetex-where.txt" 2>nul'
  Pop $R1
  ${If} $R1 == 0
    FileOpen $R0 "$TEMP\gabetex-where.txt" r
    ${If} $R0 != ""
      FileRead $R0 $R1
      FileClose $R0
      ${If} $R1 != ""
        ; $R1 holds full path like C:\foo\bar\pdflatex.exe
        ; Strip to directory by removing everything after last backslash
        StrLen $R2 "$R1"
        ${If} $R2 > 0
          StrCpy $R3 "$R1" -1
          ${If} $R3 == "\\"
            StrLen $R2 "$R1"
            StrCpy $TEX_DETECTED_PATH "$R1" 1 $R2
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
FunctionEnd

; ------------------------------------------------------------------
; Show TeX distribution selection using native MessageBox dialogs
; ------------------------------------------------------------------
Function ShowTexSelectionPage
  Call DetectTexInstallations

  StrCmp $TEX_DETECTED "yes" 0 ask_install

  ; Detected: ask if user wants to use it
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "GabeTeX needs a LaTeX compiler to build PDF documents.$\r$\n$\r$\nDetected TeX installation:$\r$\n$TEX_DETECTED_PATH$\r$\n$\r$\nUse this installation?" IDYES use_detected IDNO ask_install
  Goto done

use_detected:
  StrCpy $TEX_ACTION "custom-path"
  Goto done

ask_install:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "No TeX distribution was found on this machine.$\r$\n$\r$\nInstall TinyTeX (~150 MB) with GabeTeX?$\r$\n$\r$\nYes = install TinyTeX$\r$\nNo = choose another option" IDYES install_tinytex IDNO ask_texlive
  Goto done

install_tinytex:
  StrCpy $TEX_ACTION "install-tinytex"
  Goto done

ask_texlive:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Install TeX Live (full, several GB) with GabeTeX?$\r$\n$\r$\nYes = install TeX Live$\r$\nNo = choose another option" IDYES install_texlive IDNO ask_miktex
  Goto done

install_texlive:
  StrCpy $TEX_ACTION "install-texlive"
  Goto done

ask_miktex:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Install MiKTeX (Windows native) with GabeTeX?$\r$\n$\r$\nYes = install MiKTeX$\r$\nNo = choose another option" IDYES install_miktex IDNO do_skip
  Goto done

install_miktex:
  StrCpy $TEX_ACTION "install-miktex"
  Goto done

do_skip:
  StrCpy $TEX_ACTION "skip"

done:
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
      FileWrite $1 "selected_scheme scheme-small\r$\n"
      FileWrite $1 "TEXDIR C:\texlive\2026\r$\n"
      FileWrite $1 "TEXMFLOCAL C:\texlive\texmf-local\r$\n"
      FileWrite $1 "TEXMFSYSCONFIG C:\texlive\texmf-config\r$\n"
      FileWrite $1 "TEXMFSYSVAR C:\texlive\texmf-var\r$\n"
      FileWrite $1 "TEXMFHOME ~/texmf\r$\n"
      FileWrite $1 "instopt_adjustpath 1\r$\n"
      FileWrite $1 "instopt_letter 0\r$\n"
      FileWrite $1 "instopt_write18_restricted 1\r$\n"
      FileWrite $1 "instopt_portable 0\r$\n"
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
  FileWrite $1 '{"\r$\n'
  FileWrite $1 '  "action": "$TEX_ACTION"\r$\n'
  FileWrite $1 '  "detected": "$TEX_DETECTED"\r$\n'
  FileWrite $1 '  "path": "$TEX_DETECTED_PATH"\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

FunctionEnd
