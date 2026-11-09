; NSIS Custom Hooks for GabeTeX

!macro NSIS_HOOK_PREINSTALL
  ; Terminate any running application instance to prevent file-in-use errors during install/update
  nsExec::Exec 'cmd.exe /c taskkill /F /IM gabetex.exe /T 2>nul'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\GabeTeX"
  CreateShortcut "$SMPROGRAMS\GabeTeX\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$SMPROGRAMS\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$DESKTOP\GabeTeX.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
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
!macroend
