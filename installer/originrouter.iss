; OriginRouter — Inno Setup 6 installer script
; Build: ISCC.exe installer\originrouter.iss /DAppVersion=0.5.111
; Expects a packaged CLI at dist\win\ (produced by scripts/package-cli.mjs).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "OriginRouter"
#define AppPublisher "Origin Labs"
#define AppURL "https://github.com/origin-labs-ai/originrouter"
#define AppExe "originrouter.cmd"
#define SourceDir "..\dist\win"

[Setup]
AppId={{7E2C5A41-9D33-4B7E-9F1A-ORIGINROUTER1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=OriginRouter-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start OriginRouter when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OriginRouter"; ValueData: """{app}\{#AppExe}"" --tray"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
  if FileSearch('node.exe', ExpandConstant('{pf}') + '\nodejs;' + ExpandConstant('{localappdata}') + '\Programs\nodejs') = '' then
    MsgBox('OriginRouter needs Node.js 18 or newer. Install it from https://nodejs.org first.', mbInformation, MB_OK);
end;
