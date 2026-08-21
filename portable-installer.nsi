Unicode true
SetCompressor /SOLID zlib
Name "P-Two7"
OutFile "release-portable\P-Two7-Portable.exe"
InstallDir "$LOCALAPPDATA\P-Two7"
RequestExecutionLevel user
ShowInstDetails nevershow

Section "P-Two7"
  SetOutPath "$INSTDIR"
  File /r "release-portable\win-unpacked\*.*"
  Exec '"$INSTDIR\P-Two7.exe"'
SectionEnd
