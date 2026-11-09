; NSIS Custom Hooks for GabeTeX

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\GabeTeX"
    RmDir /r "$LOCALAPPDATA\GabeTeX"
    RmDir /r "$LOCALAPPDATA\io.github.gabe-rbo.GabeTeX"
    RmDir /r "$LOCALAPPDATA\io.github.gabe-rbo.gabetex"
  ${EndIf}
!macroend
