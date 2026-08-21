Unicode true
SetCompressor /SOLID zlib
Name "P-Two7"
OutFile "release-installer-fixed\P-Two7-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\P-Two7"
RequestExecutionLevel user
ShowInstDetails show

Section "Install P-Two7"
  SetOutPath "$INSTDIR"
  File /r "release-installer-fixed\win-unpacked\*.*"
  CreateDirectory "$SMPROGRAMS\P-Two7"
  CreateShortcut "$SMPROGRAMS\P-Two7\P-Two7.lnk" "$INSTDIR\P-Two7.exe"
  CreateShortcut "$DESKTOP\P-Two7.lnk" "$INSTDIR\P-Two7.exe"
  WriteUninstaller "$INSTDIR\Uninstall P-Two7.exe"
  Exec '"$INSTDIR\P-Two7.exe"'
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\P-Two7\P-Two7.lnk"
  RMDir "$SMPROGRAMS\P-Two7"
  Delete "$DESKTOP\P-Two7.lnk"
  RMDir /r "$INSTDIR"
SectionEnd
