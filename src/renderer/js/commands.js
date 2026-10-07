'use strict';

/**
 * Command catalogue for Lennart Terminal.
 *
 * NETWORK_QUICK_COMMANDS — the 20 most used network PowerShell commands,
 * shown as one-click buttons in the sidebar (they run in the active tab,
 * including remote host tabs).
 *
 * COMMAND_MENUS — the dropdown menus in the top menubar: PowerShell
 * commands grouped by topic, plus app actions (setup, remote, AI helpers).
 * An item is either { label, cmd } (runs the command) or
 * { label, action } (handled by app.js's runMenuAction).
 *
 * Every menu is sorted alphabetically (Danish collation) at load time.
 * The first menu is "Setup" so the app's setup/help is easy to find.
 *
 * Pure data: no DOM access, so scripts/check.js + tests can load it.
 */

const NETWORK_QUICK_COMMANDS = [
  { label: 'IP-konfig', cmd: 'ipconfig /all' },
  { label: 'DNS flush', cmd: 'ipconfig /flushdns' },
  { label: 'Ping 8.8.8.8', cmd: 'ping 8.8.8.8 -n 4' },
  { label: 'Ping gateway', cmd: "$gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop; if($gw){ping $gw -n 4}else{'Ingen default-gateway fundet'}" },
  { label: 'Traceroute', cmd: 'tracert -d 8.8.8.8' },
  { label: 'DNS-opslag', cmd: 'Resolve-DnsName google.com' },
  { label: 'nslookup', cmd: 'nslookup google.com' },
  { label: 'TCP-porttest', cmd: 'Test-NetConnection www.google.com -Port 443' },
  { label: 'Lytterporte', cmd: 'Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize' },
  { label: 'Aktive forbindelser', cmd: 'netstat -ano' },
  { label: 'DNS-cache', cmd: 'Get-DnsClientCache | Select-Object -First 30 Entry,Data' },
  { label: 'Netværkskort', cmd: 'Get-NetAdapter | Format-Table Name,Status,LinkSpeed,MacAddress -AutoSize' },
  { label: 'IP-adresser', cmd: 'Get-NetIPConfiguration | Format-Table InterfaceAlias,IPv4Address,IPv4DefaultGateway -AutoSize' },
  { label: 'Ruter', cmd: 'Get-NetRoute -AddressFamily IPv4 | Format-Table DestinationPrefix,NextHop,RouteMetric -AutoSize' },
  { label: 'ARP-tabel', cmd: 'Get-NetNeighbor | Sort-Object IPAddress | Format-Table IPAddress,LinkLayerAddress,State -AutoSize' },
  { label: 'DHCP', cmd: "Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.DHCPEnabled} | Select-Object Description,DHCPServer,IPAddress | Format-List" },
  { label: 'Wi-Fi profiler', cmd: 'netsh wlan show profiles' },
  { label: 'Wi-Fi status', cmd: 'netsh wlan show interfaces' },
  { label: 'Firewall-status', cmd: 'Get-NetFirewallProfile | Format-Table Name,Enabled,DefaultInboundAction -AutoSize' },
  { label: 'Delte mapper', cmd: 'Get-SmbShare | Format-Table Name,Path,Description -AutoSize' },
];

const COMMAND_MENUS = [
  // -------------------------------------------------------------------------
  // Setup — first menu so setup, help and remote prerequisites are easy to
  // find. Actions are handled by app.js (open Settings, copy SSH setup, …).
  // -------------------------------------------------------------------------
  {
    id: 'setup',
    label: 'Setup',
    items: [
      { label: 'Åbn Settings', action: 'setup-settings' },
      { label: 'Hent modeller (lokal AI)', action: 'setup-models' },
      { label: 'Farver & udseende', action: 'setup-colors' },
      { label: 'Genopfrisk modellisten', action: 'models-refresh' },
      { label: '/help — AI hjælper dig videre', action: 'ai-help' },
      { label: 'SSH setup-kommando (kopier)', action: 'ssh-setup' },
      { label: 'Tilføj vært…', action: 'add-host' },
      { label: 'Test alle værter', action: 'test-hosts' },
      { label: 'Genstart som administrator', action: 'run-as-admin' },
      { label: 'Se GitHub Actions (CI)', action: 'github-actions' },
      { label: 'Om Lennart Terminal', action: 'about' },
      { label: 'Slå SSH til (OpenSSH Server)', cmd: 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0' },
      { label: 'SSH-tjeneste auto-start', cmd: 'Set-Service -Name sshd -StartupType Automatic; Start-Service sshd; Get-Service sshd' },
      { label: 'Firewall: åbn port 22 (SSH)', cmd: "New-NetFirewallRule -Name 'OpenSSH-22' -DisplayName 'OpenSSH Server (SSH)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue" },
      { label: 'Slå RDP til', cmd: "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0; Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue" },
      { label: 'WinRM status', cmd: 'winrm get winrm/config' },
      { label: 'Ryd DNS-cache hurtigt', cmd: 'ipconfig /flushdns' },
    ],
  },

  {
    id: 'network',
    label: 'Netværk',
    items: [
      { label: 'Hostname', cmd: 'hostname' },
      { label: 'Logget på som', cmd: 'whoami' },
      { label: 'Ping (kontinuerlig — Ctrl+C stopper)', cmd: 'ping 8.8.8.8 -t' },
      { label: 'Port 445 test (SMB)', cmd: 'Test-NetConnection 127.0.0.1 -Port 445' },
      { label: 'Port 443 test (microsoft.com)', cmd: 'Test-NetConnection www.microsoft.com -Port 443 -InformationLevel Detailed' },
      { label: 'Etablerede forbindelser', cmd: 'Get-NetTCPConnection -State Established | Sort-Object OwningProcess | Format-Table LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess -AutoSize' },
      { label: 'UDP-endepunkter', cmd: 'Get-NetUDPEndpoint | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize' },
      { label: 'Lytterporte pr. proces', cmd: 'Get-NetTCPConnection -State Listen | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 10 Count,Name | Format-Table -AutoSize' },
      { label: 'Netværksinterfaces', cmd: 'netsh interface show interface' },
      { label: 'Ryd DNS-cache', cmd: 'Clear-DnsClientCache' },
      { label: 'Adapter-detaljer', cmd: 'Get-NetAdapterAdvancedProperty | Format-Table Name,DisplayName,DisplayValue -AutoSize' },
      { label: 'Wi-Fi synlige net', cmd: 'netsh wlan show networks mode=bssid' },
      { label: 'Wi-Fi signalstyrke', cmd: "(netsh wlan show interfaces | Select-String 'Signal|SSID|Radio type') -join \"`n\"" },
      { label: 'Aktiv DNS-server', cmd: 'Get-DnsClientServerAddress | Where-Object {$_.ServerAddresses} | Format-Table InterfaceAlias,ServerAddresses -AutoSize' },
      { label: 'DNS-suffiks', cmd: 'Get-DnsClient | Format-Table InterfaceAlias,ConnectionSpecificSuffix -AutoSize' },
      { label: 'Netværksprofil', cmd: 'Get-NetConnectionProfile | Format-Table InterfaceAlias,NetworkCategory,IPv4Connectivity -AutoSize' },
      { label: 'HTTP-svar fra gateway', cmd: "$gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop; Test-NetConnection $gw -InformationLevel Detailed" },
      { label: 'Traceroute til gateway', cmd: "$gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop; tracert -d $gw" },
      { label: 'Offentlig IP', cmd: '(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 https://api.ipify.org).Content' },
      { label: 'IPv4-adresser', cmd: 'Get-NetIPAddress -AddressFamily IPv4 | Format-Table InterfaceAlias,IPAddress,PrefixLength -AutoSize' },
      { label: 'DHCP-server', cmd: "Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.DHCPEnabled} | Select-Object Description,DHCPServer | Format-List" },
      { label: 'Proxy-konfiguration', cmd: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | Format-List" },
      { label: 'Netstat-fejl (rejser)', cmd: 'netstat -e' },
      { label: 'SMB-forbindelser (klient)', cmd: 'Get-SmbConnection | Format-Table ServerName,Dialect,NumOpens -AutoSize' },
      { label: 'Route tabellen', cmd: 'Get-NetRoute -AddressFamily IPv4 | Sort-Object RouteMetric | Select-Object -First 25 DestinationPrefix,NextHop,RouteMetric | Format-Table -AutoSize' },
      { label: 'Wi-Fi profiler (detaljer)', cmd: 'netsh wlan show profile' },
    ],
  },

  {
    id: 'system',
    label: 'System',
    items: [
      { label: 'Maskine & OS', cmd: 'Get-ComputerInfo | Select-Object CsName,OsName,OsVersion,OsBuildNumber | Format-List' },
      { label: 'systeminfo', cmd: 'systeminfo' },
      { label: 'Genstartet sidst', cmd: "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime" },
      { label: 'Windows-version (registry)', cmd: "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object ProductName,DisplayVersion,CurrentBuild | Format-List" },
      { label: 'Opdateringer (hotfix)', cmd: 'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10' },
      { label: 'Hotfix (WMI)', cmd: 'Get-WmiObject Win32_QuickFixEngineering | Sort-Object InstalledOn -Descending | Select-Object -First 10 HotFixID,Description' },
      { label: 'Bruger & maskine', cmd: '$env:USERNAME; $env:COMPUTERNAME; $env:USERDOMAIN' },
      { label: 'Tidszone & sprog', cmd: 'Get-TimeZone; Get-Culture | Select-Object Name,DisplayName' },
      { label: 'Tidszone (tzutil)', cmd: 'tzutil /g' },
      { label: 'Miljøvariabler (PATH)', cmd: '$env:PATH -split "; "' },
      { label: 'Installerede programmer', cmd: "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Sort-Object DisplayName | Select-Object -First 40 DisplayName,DisplayVersion | Format-Table -AutoSize" },
      { label: 'Politikker (gpresult)', cmd: 'gpresult /r | Select-Object -First 60' },
      { label: 'Brugere på maskinen', cmd: 'Get-LocalUser | Format-Table Name,Enabled,LastLogon -AutoSize' },
      { label: 'Grupper', cmd: 'Get-LocalGroup | Format-Table Name,Description -AutoSize' },
      { label: 'CPU', cmd: 'Get-CimInstance Win32_Processor | Format-List Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed' },
      { label: 'Hukommelse (GB)', cmd: 'Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory | ForEach-Object {[math]::Round($_.TotalPhysicalMemory/1GB,1)}' },
      { label: 'Model & producent', cmd: 'Get-CimInstance Win32_ComputerSystem | Format-List Manufacturer,Model,TotalPhysicalMemory' },
      { label: 'BIOS', cmd: 'Get-CimInstance Win32_BIOS | Format-List Manufacturer,SMBIOSBIOSVersion,ReleaseDate' },
      { label: 'Aktiverings-status', cmd: 'slmgr /xpr' },
      { label: 'Alle services', cmd: 'Get-Service | Format-Table Name,DisplayName,Status,StartType -AutoSize' },
      { label: 'Systemdisk plads', cmd: 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Format-Table DeviceID,@{n="GB";e={[math]::Round($_.Size/1GB)}},@{n="Fri GB";e={[math]::Round($_.FreeSpace/1GB)}} -AutoSize' },
      { label: 'System-stier', cmd: '$env:USERPROFILE; $env:ProgramData; $env:ProgramFiles' },
      { label: 'Winget-version', cmd: 'winget --version' },
      { label: 'Genstart (hvad-if)', cmd: 'Restart-Computer -WhatIf' },
    ],
  },

  {
    id: 'processes',
    label: 'Processer',
    items: [
      { label: 'Top CPU', cmd: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,CPU,Id | Format-Table -AutoSize' },
      { label: 'Top hukommelse (MB)', cmd: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}},Id | Format-Table -AutoSize" },
      { label: 'CPU over 5 %', cmd: 'Get-Process | Where-Object {$_.CPU -gt 5} | Sort-Object CPU -Descending | Select-Object -First 15 Name,CPU,Id | Format-Table -AutoSize' },
      { label: 'CPU-kontra (counter)', cmd: "Get-Counter '\\Processor(_Total)\\% Processor Time' | Select-Object -ExpandProperty CounterSamples | Select-Object CookedValue" },
      { label: 'Kørende tjenester', cmd: "Get-Service | Where-Object {$_.Status -eq 'Running'} | Format-Table Name,DisplayName -AutoSize" },
      { label: 'Stoppede tjenester', cmd: "Get-Service | Where-Object {$_.Status -eq 'Stopped'} | Format-Table Name,DisplayName -AutoSize" },
      { label: 'Auto-start men stoppet', cmd: 'Get-Service | Where-Object {$_.Status -eq "Stopped" -and $_.StartType -eq "Automatic"} | Format-Table Name,DisplayName -AutoSize' },
      { label: 'Tjenester sat til auto-start', cmd: "Get-Service | Where-Object {$_.StartType -eq 'Automatic'} | Format-Table Name,Status,StartType -AutoSize" },
      { label: 'Programmer ved start', cmd: 'Get-CimInstance Win32_StartupCommand | Format-Table Name,Command,Location -AutoSize' },
      { label: 'Start (Run-nøgler)', cmd: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | Format-List" },
      { label: 'Planlagte opgaver', cmd: 'Get-ScheduledTask | Where-Object {$_.State -ne "Disabled"} | Select-Object -First 30 TaskName,State | Format-Table -AutoSize' },
      { label: 'Kørende opgaver', cmd: 'Get-ScheduledTask | Where-Object {$_.State -eq "Running"} | Format-Table TaskName,State -AutoSize' },
      { label: 'Vinduer (kørende GUI)', cmd: 'Get-Process | Where-Object {$_.MainWindowTitle} | Format-Table Id,ProcessName,MainWindowTitle -AutoSize' },
      { label: 'tasklist med services', cmd: 'tasklist /svc' },
      { label: 'Svchost værter', cmd: 'tasklist /svc | findstr /i svchost' },
      { label: 'Antal processer pr. navn', cmd: 'Get-Process | Group-Object Name | Where-Object {$_.Count -gt 1} | Sort-Object Count -Descending | Format-Table Count,Name -AutoSize' },
      { label: 'Processti', cmd: 'Get-Process | Where-Object {$_.Path} | Sort-Object Name | Select-Object -First 40 Name,Id,Path | Format-Table -AutoSize' },
      { label: 'Senest startet', cmd: 'Get-Process | Sort-Object StartTime -Descending | Select-Object -First 10 Name,Id,StartTime | Format-Table -AutoSize' },
      { label: 'Explorer-processer', cmd: 'tasklist | findstr /i explorer' },
      { label: 'Tråde pr. proces', cmd: 'Get-Process | Sort-Object Threads.Count -Descending | Select-Object -First 10 Name,Id,@{n="Tråde";e={$_.Threads.Count}} | Format-Table -AutoSize' },
      { label: 'System32-processer (antal)', cmd: 'Get-Process | Where-Object {$_.Path -like "*System32*"} | Measure-Object | Select-Object Count' },
      { label: 'Stop proces (hvad-if)', cmd: 'Stop-Process -Name notepad -WhatIf' },
      { label: 'I/O læsning/skrivning', cmd: 'Get-Process | Sort-Object IOReadBytes -Descending | Select-Object -First 10 Name,IOReadBytes,IOWriteBytes | Format-Table -AutoSize' },
    ],
  },

  {
    id: 'disk',
    label: 'Disk',
    items: [
      { label: 'Drev', cmd: 'Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free,Root -AutoSize' },
      { label: 'Volume', cmd: 'Get-Volume | Format-Table DriveLetter,FileSystemLabel,FileSystem,SizeRemaining,Size -AutoSize' },
      { label: 'Volume i fare (sundhed)', cmd: 'Get-Volume | Where-Object {$_.HealthStatus -ne "OK"} | Format-Table DriveLetter,FileSystemLabel,HealthStatus -AutoSize' },
      { label: 'Fysiske diske', cmd: 'Get-PhysicalDisk | Format-Table FriendlyName,MediaType,HealthStatus,Size -AutoSize' },
      { label: 'SSD sundhed', cmd: 'Get-PhysicalDisk | Get-StorageReliabilityCounter | Format-List DeviceId,Temperature,PowerOnHours,Wear' },
      { label: 'Partitioner', cmd: 'Get-Partition | Format-Table DiskNumber,PartitionNumber,DriveLetter,Size -AutoSize' },
      { label: 'Partitionsskema', cmd: 'Get-Disk | Format-Table Number,PartitionStyle,FriendlyName -AutoSize' },
      { label: 'Disk-id & sundhed', cmd: 'Get-Disk | Format-Table Number,FriendlyName,SerialNumber,HealthStatus -AutoSize' },
      { label: 'USB-enheder', cmd: 'Get-Disk | Where-Object BusType -eq "USB" | Format-Table Number,FriendlyName,@{n="GB";e={[math]::Round($_.Size/1GB)}} -AutoSize' },
      { label: '10 største filer i Users', cmd: "Get-ChildItem \"$env:USERPROFILE\" -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{n='MB';e={[math]::Round($_.Length/1MB,1)}},FullName | Format-Table -AutoSize" },
      { label: 'Temp-mappe størrelse', cmd: "$f=Get-ChildItem $env:TEMP -Recurse -File -ErrorAction SilentlyContinue; '{0} filer · {1} MB' -f $f.Count,[math]::Round(($f | Measure-Object Length -Sum).Sum/1MB)" },
      { label: 'Ryd temp (hvad-if)', cmd: 'Remove-Item $env:TEMP\\* -Recurse -Force -WhatIf -ErrorAction SilentlyContinue' },
      { label: 'Mapper i C:\\', cmd: 'Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | Format-Table Name,LastWriteTime -AutoSize' },
      { label: 'Diskplads pr. mapper (top)', cmd: "Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | ForEach-Object { $s=(Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; [PSCustomObject]@{GB=[math]::Round($s/1GB,2);Dir=$_.FullName} } | Sort-Object GB -Descending | Select-Object -First 10 | Format-Table -AutoSize" },
      { label: 'Program Files størrelse', cmd: "Get-ChildItem 'C:\\Program Files','C:\\Program Files (x86)' -Directory -ErrorAction SilentlyContinue | ForEach-Object {$s=(Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; [PSCustomObject]@{GB=[math]::Round($s/1GB,2);Navn=$_.Name}} | Sort-Object GB -Descending | Select-Object -First 15 | Format-Table -AutoSize" },
      { label: 'Defrag analyse (C:)', cmd: 'Optimize-Volume -DriveLetter C -Analyze -Verbose' },
      { label: 'TRIM slået til?', cmd: 'fsutil behavior query DisableDeleteNotify' },
      { label: 'CHKDSK (scan)', cmd: 'chkdsk C: /scan' },
      { label: 'Skyggekopier', cmd: 'vssadmin list shadows' },
      { label: 'Paging-fil', cmd: 'Get-CimInstance Win32_PageFileUsage | Format-Table Name,AllocatedBaseSize,CurrentUsage -AutoSize' },
      { label: 'Windows-logs størrelse', cmd: "Get-ChildItem C:\\Windows\\Logs -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{n='MB';e={[math]::Round($_.Length/1MB,1)}},FullName | Format-Table -AutoSize" },
    ],
  },

  {
    id: 'security',
    label: 'Sikkerhed',
    items: [
      { label: 'Firewall-regler (inbound)', cmd: 'Get-NetFirewallRule -Direction Inbound -Enabled True | Select-Object -First 25 DisplayName,Action,Profile | Format-Table -AutoSize' },
      { label: 'Firewall-regler (udgående)', cmd: 'Get-NetFirewallRule -Direction Outbound -Enabled True | Select-Object -First 25 DisplayName,Action,Profile | Format-Table -AutoSize' },
      { label: 'Tilladte porte (firewall)', cmd: 'Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow | Get-NetFirewallPortFilter | Where-Object {$_.LocalPort -ne "Any"} | Select-Object -First 30 LocalPort,Protocol | Format-Table -AutoSize' },
      { label: 'Windows Defender status', cmd: 'Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated | Format-List' },
      { label: 'Fundne trusler', cmd: 'Get-MpThreatDetection | Select-Object -First 10 ThreatID,InitialDetectionTime,ProcessingSuccess | Format-Table -AutoSize' },
      { label: 'Defender eksklusioner', cmd: 'Get-MpPreference | Select-Object -ExpandProperty ExclusionPath' },
      { label: 'Defender hurtig scan', cmd: 'Start-MpScan -ScanType QuickScan' },
      { label: 'Seneste logon-fejl (4625)', cmd: "Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625} -MaxEvents 10 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Message -AutoSize -Wrap" },
      { label: 'Seneste logons (4624)', cmd: "Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624} -MaxEvents 10 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Message -AutoSize -Wrap" },
      { label: 'Seneste sikkerhedshændelser', cmd: 'Get-WinEvent -LogName Security -MaxEvents 15 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Id,Message -AutoSize -Wrap' },
      { label: 'Rettigheder (whoami /priv)', cmd: 'whoami /priv' },
      { label: 'Grupper jeg er i', cmd: 'whoami /groups | Select-String "S-1-5|Alias|Label"' },
      { label: 'Administrators-medlemmer', cmd: 'Get-LocalGroupMember -Group "Administrators" | Format-Table Name,PrincipalSource -AutoSize' },
      { label: 'Adgangskode-politik', cmd: 'net accounts' },
      { label: 'Maskincertifikater', cmd: 'Get-ChildItem Cert:\\LocalMachine\\My | Select-Object -First 10 Subject,NotAfter,HasPrivateKey | Format-Table -AutoSize' },
      { label: 'Certifikater snart udløbet', cmd: 'Get-ChildItem Cert:\\LocalMachine\\My | Where-Object {$_.NotAfter -lt (Get-Date).AddDays(30)} | Format-Table Subject,NotAfter -AutoSize' },
      { label: 'UAC-niveau', cmd: "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' | Select-Object EnableLUA,ConsentPromptBehaviorAdmin | Format-List" },
      { label: 'BitLocker status', cmd: 'Manage-bde -status C: 2>$null; if(-not $?){"Manage-bde kræver elevation / BitLocker er ikke tilgængelig"}' },
      { label: 'Secure Boot', cmd: 'Confirm-SecureBootUEFI' },
      { label: 'TPM', cmd: 'Get-Tpm | Format-List TpmPresent,TpmEnabled,TpmReady' },
      { label: 'Kørselsespolitik', cmd: 'Get-ExecutionPolicy -List' },
      { label: 'Gruppepolitik opdatering', cmd: 'gpupdate /force' },
    ],
  },

  {
    id: 'gpu',
    label: 'GPU & spil',
    items: [
      { label: 'nvidia-smi', cmd: 'nvidia-smi' },
      { label: 'nvidia GPU-detaljer (csv)', cmd: 'nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv' },
      { label: 'nvidia GPU-ure (csv)', cmd: 'nvidia-smi --query-gpu=utilization.gpu,clocks.sm,temperature.gpu --format=csv,noheader' },
      { label: 'nvidia hukommelse', cmd: 'nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv' },
      { label: 'NVIDIA-services', cmd: 'Get-Service | Where-Object {$_.Name -like "*nv*"} | Format-Table Name,Status -AutoSize' },
      { label: 'GPU-detaljer', cmd: 'Get-CimInstance Win32_VideoController | Format-List Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor' },
      { label: 'GPU-belastning', cmd: "Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue | ForEach-Object { $_.CounterSamples | Where-Object {$_.CookedValue -gt 1} | Select-Object InstanceName,CookedValue } | Format-Table -AutoSize" },
      { label: 'Strømplan (aktiv)', cmd: 'powercfg /getactivescheme' },
      { label: 'Alle strømplaner', cmd: 'powercfg /list' },
      { label: 'Søvntilstandstyper', cmd: 'powercfg /a' },
      { label: 'Aktiv strømplan (detaljer)', cmd: 'powercfg /query SCHEME_CURRENT' },
      { label: 'Strømrapport (HTML)', cmd: 'powercfg /systempowerreport' },
      { label: 'GPU-link & refresh', cmd: 'Get-CimInstance Win32_VideoController | Select-Object Name,CurrentRefreshRate,CurrentHorizontalResolution,CurrentVerticalResolution | Format-List' },
      { label: 'Refresh-rates (tabel)', cmd: 'Get-CimInstance Win32_VideoController | Select-Object CurrentRefreshRate,CurrentHorizontalResolution,CurrentVerticalResolution | Format-Table -AutoSize' },
      { label: 'Videobeskrivelse', cmd: 'Get-CimInstance Win32_VideoController | Where-Object {$_.VideoModeDescription} | Format-List Name,VideoModeDescription,AdapterCompatibility' },
      { label: 'Skærme (PnP)', cmd: 'Get-PnpDevice -Class Monitor | Format-Table FriendlyName,Status -AutoSize' },
      { label: 'DPI-skalering', cmd: 'Get-ItemProperty "HKCU:\\Control Panel\\Desktop\\WindowMetrics" -Name AppliedDPI | Format-List' },
      { label: 'GameDVR / Game Bar', cmd: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -ErrorAction SilentlyContinue | Format-List; Get-AppxPackage *Microsoft.XboxGamingOverlay* | Select-Object Name,Version | Format-List" },
      { label: 'Game Mode (registry)', cmd: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -ErrorAction SilentlyContinue | Format-List AllowAutoGameMode,AutoGameModeEnabled" },
      { label: 'Tunge processer (spil/klienter)', cmd: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}},CPU | Format-Table -AutoSize" },
      { label: 'Skærm & refresh', cmd: 'Get-CimInstance Win32_DesktopMonitor | Format-Table Name,ScreenHeight,ScreenWidth -AutoSize' },
      { label: 'DirectX-diagnose', cmd: 'dxdiag | Select-Object -First 60' },
      { label: 'DirectX-version', cmd: "(dxdiag | Select-String 'DirectX Version').Line" },
    ],
  },

  {
    id: 'fix',
    label: 'Fejlfinding',
    items: [
      { label: 'Windows Update service', cmd: 'Get-Service wuauserv | Format-Table Name,Status,StartType -AutoSize' },
      { label: 'Windows Update hændelser', cmd: 'Get-WinEvent -LogName System -MaxEvents 30 | Where-Object {$_.ProviderName -like "*Update*"} | Format-Table TimeCreated,Id,Message -AutoSize -Wrap' },
      { label: 'Service-fejl (SCM)', cmd: "Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'} -MaxEvents 10 | Format-Table TimeCreated,Id,Message -AutoSize -Wrap" },
      { label: 'System-fejl (log)', cmd: 'Get-EventLog -LogName System -Newest 20 -EntryType Error' },
      { label: 'Application-fejl (log)', cmd: 'Get-EventLog -LogName Application -Newest 20 -EntryType Error' },
      { label: 'Certifikat-fejl (log)', cmd: 'Get-EventLog -LogName Application -Newest 100 -EntryType Error | Where-Object {$_.Source -like "*Cert*"} | Format-Table TimeCreated,Message -AutoSize' },
      { label: 'Seneste kritiske hændelser', cmd: "Get-WinEvent -FilterHashtable @{Level=1;LogName='System'} -MaxEvents 10 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Id,Message -AutoSize -Wrap" },
      { label: 'Bluescreen (WHEA)', cmd: "Get-WinEvent -FilterHashtable @{ProviderName='Microsoft-Windows-WHEA-Logger'} -MaxEvents 5 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Id,Message -AutoSize" },
      { label: 'Uventede genstarte (6008)', cmd: 'Get-WinEvent -FilterHashtable @{Id=6008} -MaxEvents 5 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Message -AutoSize' },
      { label: 'Systemfil-kontrol', cmd: 'sfc /scannow' },
      { label: 'DISM sundhedstjek', cmd: 'DISM /Online /Cleanup-Image /CheckHealth' },
      { label: 'DISM reparer (RestoreHealth)', cmd: 'Dism /Online /Cleanup-Image /RestoreHealth' },
      { label: 'Netværk nulstil (winsock+IP)', cmd: 'ipconfig /release; ipconfig /flushdns; ipconfig /renew; netsh winsock reset' },
      { label: 'Proxy nulstil (winhttp)', cmd: 'netsh winhttp reset proxy' },
      { label: 'DNS fejltest', cmd: 'Resolve-DnsName github.com -ErrorAction SilentlyContinue; Test-NetConnection github.com -Port 443 -InformationLevel Quiet' },
      { label: 'Adapter-statistik', cmd: 'Get-NetAdapterStatistics | Format-Table Name,ReceivedBytes,SentBytes -AutoSize' },
      { label: 'Bluescreen-historik (dump)', cmd: 'Get-ChildItem C:\\Windows\\Minidump -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name,LastWriteTime | Format-Table -AutoSize' },
      { label: 'Windows-aktivering', cmd: 'slmgr /dlv | Select-Object -First 20' },
      { label: 'Hændelseslog-kilder (fejl)', cmd: "Get-EventLog -LogName System -Newest 200 -EntryType Error | Group-Object Source | Sort-Object Count -Descending | Select-Object -First 10 Count,Name | Format-Table -AutoSize" },
      { label: 'Test-internettet', cmd: 'Test-Connection 1.1.1.1 -Count 4' },
      { label: 'Hosts-fil', cmd: 'Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts' },
      { label: 'Print Spooler (hvad-if)', cmd: 'Get-Service Spooler | Restart-Service -WhatIf' },
      { label: 'Lyd-services', cmd: 'Get-Service Audiodg,AudioSrv | Format-Table Name,Status,StartType -AutoSize' },
      { label: 'Boot-log (Wininit/Winlogon)', cmd: "Get-WinEvent -LogName Application -MaxEvents 50 | Where-Object {$_.ProviderName -like '*Wininit*' -or $_.ProviderName -like '*Winlogon*'} | Format-Table TimeCreated,Message -AutoSize -Wrap" },
    ],
  },

  {
    id: 'remote',
    label: 'Fjernsupport',
    items: [
      // All known remote-support functions in one menu (actions are wired
      // in app.js; commands run in the active tab — on remote tabs they
      // execute on the remote host).
      { label: 'Forbind til IP (quick-connect)', action: 'remote-connect' },
      { label: 'SSH setup-kommando (kopier)', action: 'ssh-setup' },
      { label: 'Tilføj vært…', action: 'add-host' },
      { label: 'Test alle værter', action: 'test-hosts' },
      { label: 'Åbn SSH-session med ssh', cmd: 'ssh' },
      { label: 'SSH-version', cmd: 'ssh -V' },
      { label: 'Vis SSH offentlige nøgle', cmd: 'type "$env:USERPROFILE\\.ssh\\id_rsa.pub" -ErrorAction SilentlyContinue' },
      { label: 'Generér SSH-nøgle', cmd: 'ssh-keygen -t ed25519 -f "$env:USERPROFILE\\.ssh\\id_ed25519"' },
      { label: 'sshd_config vis', cmd: 'Get-Content "$env:ProgramData\\ssh\\sshd_config" -ErrorAction SilentlyContinue' },
      { label: 'SSH-firewall-regler', cmd: 'Get-NetFirewallRule -Name *ssh* -ErrorAction SilentlyContinue | Format-Table DisplayName,Enabled,Direction -AutoSize' },
      { label: 'Slå PowerShell Remoting til', cmd: 'Enable-PSRemoting -Force -SkipNetworkProfileCheck' },
      { label: 'Test-WSMan (local)', cmd: 'Test-WSMan localhost' },
      { label: 'WinRM service-konfig', cmd: 'winrm get winrm/config/service' },
      { label: 'WinRM firewall-regler', cmd: 'Get-NetFirewallRule -Name "WINRM-*" | Format-Table DisplayName,Enabled -AutoSize' },
      { label: 'Test port 445 (gateway)', cmd: "$gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop; Test-NetConnection $gw -Port 445" },
      { label: 'Se aktive RDP-sessioner', cmd: 'query session' },
      { label: 'Alle brugere (quser)', cmd: 'quser' },
      { label: 'RDP port (registry)', cmd: "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name PortNumber | Format-List" },
      { label: 'Wake-on-LAN guide (MAC)', cmd: 'Get-NetNeighbor | Where-Object {$_.State -eq "Reachable"} | Format-Table IPAddress,LinkLayerAddress -AutoSize' },
      { label: 'Wake-on-LAN slå til', cmd: 'Set-NetAdapterAdvancedProperty -Name "*" -DisplayName "Wake on Magic Packet" -DisplayValue "Enabled" -ErrorAction SilentlyContinue' },
      { label: 'Fjern-hjælp (invite)', cmd: 'msra /offerEra' },
      { label: 'Deling: aktive forbindelser', cmd: 'net use' },
      { label: 'Slå fil/printdeling til', cmd: 'Set-Service LanmanServer -StartupType Automatic; Start-Service LanmanServer' },
      { label: 'SMB-sessioner (server)', cmd: 'Get-SmbSession | Format-Table ClientComputerName,NumOpens -AutoSize' },
    ],
  },

  {
    id: 'ai',
    label: 'AI',
    items: [
      { label: 'Ryd AI-chat', action: 'ai-clear' },
      { label: 'Vis/skjul AI-panel (Ctrl+J)', action: 'ai-toggle' },
      { label: 'Agent-mode til/fra', action: 'ai-agent-mode' },
      { label: 'Fokusér AI-chat', action: 'ai-focus' },
      { label: '/help — AI hjælper dig videre', action: 'ai-help' },
      { label: 'Hent modeller (lokal AI)', action: 'setup-models' },
      { label: 'Spørg: "Hvad er kommanden til at tjekke port 8080?"', action: 'ai-ask-port' },
      { label: 'Spørg: "Udfør en ipconfig /all for mig"', action: 'ai-ask-ipconfig' },
      { label: 'Ollama-version', cmd: 'ollama --version' },
      { label: 'Ollama-modeller', cmd: 'ollama list' },
      { label: 'Ollama-service', cmd: 'Get-Service ollama -ErrorAction SilentlyContinue | Format-Table Name,Status -AutoSize' },
      { label: 'Installér Ollama (winget)', cmd: 'winget install Ollama.Ollama' },
      { label: 'llama-server kørende?', cmd: 'Get-Process llama-server -ErrorAction SilentlyContinue | Format-Table Id,CPU,WorkingSet -AutoSize' },
      { label: 'Lokal AI-port (9601)', cmd: 'Get-NetTCPConnection -LocalPort 9601 -State Listen -ErrorAction SilentlyContinue | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize' },
      { label: 'Test lokal AI (health)', cmd: '(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:9601/health).Content' },
      { label: 'PSReadLine-historiksti', cmd: 'Get-PSReadLineOption | Format-List HistorySavePath,HistorySaveStyle' },
      { label: 'Kommandooversigt (Get-Command)', cmd: 'Get-Command | Select-Object -First 25 Name,CommandType | Format-Table -AutoSize' },
    ],
  },
];

// Alphabetical order inside every dropdown (Danish collation) — the user
// asked for the commands to be easy to scan.
for (const menu of COMMAND_MENUS) {
  menu.items.sort((a, b) => a.label.localeCompare(b.label, 'da'));
}

/**
 * True when a command needs administrator rights on Windows. Used to label
 * menu items “kræver administrator” when the app is NOT running elevated
 * (Lennart Terminal prefers running everything as administrator).
 */
function requiresAdmin(cmd) {
  const c = String(cmd || '');
  // Writes / service control / system repair clearly need elevation
  if (/^(Set-|New-|Remove-|Add-|Disable-|gpupdate|sfc |DISM |Manage-bde|slmgr|vssadmin|fsutil|Optimize-Volume|Confirm-SecureBootUEFI|Get-Tpm|chkdsk|Restart-Computer|Stop-Computer|winget install|reg )/i.test(c)) return true;
  if (/Enable-(PSRemoting|NetFirewallRule|PSRemoting)|Start-Service|Set-Service|netsh winsock|New-NetFirewallRule|Expand-Archive/i.test(c)) return true;
  // Security event logs and HKLM changes require elevation
  if (/LogName='Security'|LogName Security|-LogName Security|HKLM:.*-Name\s+fDenyTSConnections/i.test(c)) return true;
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NETWORK_QUICK_COMMANDS, COMMAND_MENUS, requiresAdmin };
}
