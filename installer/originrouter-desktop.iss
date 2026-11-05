; Inno Setup script for the OriginRouter Desktop window app.
;
; The Electron build is produced with `electron-builder --win --dir`, which only
; unpacks the app (no NSIS): this script is the single installer format used by
; both products, so the same silent Inno path installs, updates and uninstalls
; the gateway and the window app.
#define AppName "OriginRouter Desktop"
#define AppPublisher "Origin Labs AI"
#define AppURL "https://github.com/origin-labs-ai/origin-router-suite"
#define SourceDir "..\desktop\dist\win-unpacked"

[Setup]
AppId={{7E2C5A41-9B7D-4F0C-8E3A-51D6C4B0A9F2}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; Never stop with "cannot be closed": force-close the running app, ask nothing.
CloseApplications=force
RestartApplications=no
OutputDir=..\dist\installer
OutputBaseFilename=OriginRouter-Desktop-Setup-{#AppVersion}
SetupIconFile=..\desktop\assets\icon.ico
UninstallDisplayIcon={app}\OriginRouter Desktop.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
LicenseFile=..\LICENSE
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
; The Next build dir is replaced wholesale on every upgrade. Without this, files
; from the previous build stay behind: old hashed JS chunks plus the runtime
; `server\route-cache`, and that cache is what answers page requests — so the app
; keeps rendering the *previous* build's UI forever, however many times it is
; rebuilt and reinstalled. Same rule as the gateway installer.
Type: filesandordirs; Name: "{app}\resources\server\app\.next-cli-build"
Type: filesandordirs; Name: "{app}\resources\server\app\.next"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\OriginRouter Desktop.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\OriginRouter Desktop.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\OriginRouter Desktop.exe"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
