; OriginRouter — Inno Setup 6 installer script
; Build: ISCC.exe installer\origin-router.iss /DAppVersion=<version> (see scripts/build-installer.ps1)
; Expects a packaged CLI at dist\win\ (produced by scripts/package-cli.mjs).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "OriginRouter"
#define AppPublisher "Origin Labs AI"
#define AppURL "https://github.com/origin-labs-ai/origin-router-suite"
#define AppExe "originrouter.cmd"
#define SourceDir "..\dist\win"

[Setup]
AppId={{7E2C5A41-9D33-4B7E-9F1A-2C5A419D334B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; Silent/auto updates must never stop at "OriginRouter cannot be closed": force
; closes a running instance instead of asking, and asks nothing at all.
CloseApplications=force
RestartApplications=no
OutputDir=..\dist\installer
OutputBaseFilename=OriginRouter-Setup-{#AppVersion}
SetupIconFile=..\desktop\assets\icon.ico
UninstallDisplayIcon={app}\app\src\cli\tray\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
LicenseFile=..\LICENSE
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start OriginRouter when Windows starts"; GroupDescription: "Startup:"

[InstallDelete]
Type: files; Name: "{userstartup}\originrouter.vbs"
Type: filesandordirs; Name: "{app}\app\.next-cli-build"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Autostart must not leave a console window on the desktop: the tray-mode CLI is
 ; launched through a hidden PowerShell so the gateway starts silently.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OriginRouter"; ValueData: """{sys}\WindowsPowerShell\v1.0\powershell.exe"" -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command ""Start-Process -FilePath '{app}\originrouter.cmd' -ArgumentList '--tray' -WindowStyle Hidden"""; Tasks: autostart
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath('{app}')

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if FileSearch('node.exe', ExpandConstant('{pf}') + '\nodejs;' + ExpandConstant('{localappdata}') + '\Programs\nodejs') = '' then
    MsgBox('OriginRouter needs Node.js 18 or newer. Install it from https://nodejs.org first.', mbInformation, MB_OK);
end;
