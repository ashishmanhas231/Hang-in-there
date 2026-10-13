; Extra uninstall step for the Windows installer (electron-builder includes this file).
; "Start automatically" adds a Run entry for the current user. Remove it when the app is
; uninstalled (not when it is only being updated), so Windows does not try to start a program that is gone.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Spidey Hang"
  ${endIf}
!macroend
