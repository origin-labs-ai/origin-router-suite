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
; The user PATH is written by CleanUserPath() in [Code]. Doing it here with
; {olddata} appended the install folder again on every update, so a machine
; that was updated a few times carried a dozen copies of the same path.

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
{ Puts the install folder on the user PATH exactly once.
  Every copy of it is removed first, so a machine that was installed or
  updated several times ends up with one clean entry instead of a dozen. }
procedure CleanUserPath;
var
  OrigPath, NewPath, Target, Part: String;
  StartPos, SepPos: Integer;
  Last: Boolean;
begin
  Target := ExpandConstant('{app}');

  OrigPath := '';
  RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath);

  NewPath := '';
  StartPos := 1;
  Last := False;
  while not Last do
  begin
    SepPos := Pos(';', Copy(OrigPath, StartPos, MaxInt));
    if SepPos = 0 then
    begin
      Part := Trim(Copy(OrigPath, StartPos, MaxInt));
      Last := True;
    end
    else
    begin
      Part := Trim(Copy(OrigPath, StartPos, SepPos - 1));
      StartPos := StartPos + SepPos;
    end;

    if (Part <> '') and
       (Uppercase(Part) <> Uppercase(Target)) and
       (Uppercase(Part) <> Uppercase(Target + '\')) then
    begin
      if NewPath <> '' then
        NewPath := NewPath + ';';
      NewPath := NewPath + Part;
    end;
  end;

  if NewPath <> '' then
    NewPath := NewPath + ';';
  NewPath := NewPath + Target;

  { No WM_SETTINGCHANGE broadcast: Inno's Pascal Script takes integers-only
    in SendMessage, and the CAST_STRING_TOLPARAM shim this needs is missing
    from some Inno Setup 6 builds — a bare string literal there compiles but
    throws "Runtime error: Type mismatch" at post-install (the 1:1520 crash).
    The rewritten PATH applies to every process started AFTER the installer
    exits, which covers the launcher it offers to run. }
  if RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath) then
  begin
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Marker: String;
begin
  if CurStep = ssPostInstall then
  begin
    { The packaged folder is marked "portable", so the launcher knows it has no
      uninstaller and asks whether to start in the system tray. An installed
      copy is not portable - it has an uninstaller, an autostart entry and
      installer updates - so the marker is rewritten here. }
    Marker := ExpandConstant('{app}\install.json');
    SaveStringToFile(Marker,
      '{"mode":"installer","name":"@origin-labs-ai/origin-router","version":"' + '{#AppVersion}' +
      '","updateRepo":"origin-labs-ai/origin-router-suite"}', False);

    CleanUserPath;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if FileSearch('node.exe', ExpandConstant('{pf}') + '\nodejs;' + ExpandConstant('{localappdata}') + '\Programs\nodejs') = '' then
    MsgBox('OriginRouter needs Node.js 18 or newer. Install it from https://nodejs.org first.', mbInformation, MB_OK);
end;
