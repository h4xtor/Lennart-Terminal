'use strict';

/**
 * Knowledge base for the AI assistant — split into small topic cards.
 *
 * Why: the embedded 1.5B/3B model used to get ONE giant compendium (~3.5k
 * tokens) with every topic on earth in it. Small models cannot ignore the
 * irrelevant parts: a WinRM question came back with sshd/OpenSSH steps and
 * Get-SmbShare, because those lines sat right next to WinRM in the prompt.
 *
 * Now every question only gets the 1–2 cards that match it (plain keyword
 * scoring — no embeddings, works offline on a USB stick). That keeps the
 * prompt small (faster on a plain CPU), on-topic, and correct.
 *
 * Card rules: concrete facts and exact commands, Danish, short lines, no
 * numbered lists (the model copies the shape of what it reads).
 */

// weight 3 = the card is clearly about this; weight 1 = a weak hint
const CARDS = [
  {
    id: 'winrm',
    title: 'WinRM / PowerShell Remoting',
    keywords: [
      [/winrm|ps-?remoting|powershell remoting|invoke-command|enter-pssession|new-pssession|wsman|trustedhosts|5985|5986/i, 3],
      [/fjernstyr|styre .*pc|køre .*på (alle|flere|mange|hver)|på (alle|flere|mange) (de )?\d* ?pc|\b\d+ pc'?er|alle pc'?er|flere pc'?er/i, 2],
      [/remote(?!\s*desktop)|fjern-?pc|anden pc|andre pc/i, 1],
    ],
    text: [
      'WinRM (PowerShell Remoting) lader én PC sende PowerShell-kommandoer til andre Windows-PC\'er over netværket. Mål-PC\'en kører kommandoen og sender resultatet tilbage. Porte: 5985 (HTTP) og 5986 (HTTPS), begge TCP.',
      'Slå til på HVER mål-PC (én gang, som administrator): Enable-PSRemoting -Force -SkipNetworkProfileCheck — starter tjenesten, laver en lytter og åbner firewallen.',
      'Netværket på mål-PC\'en bør være Privat: Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private',
      'Tillad lokale administrator-konti at fjernstyre (kun når der ikke er domæne) — kør på mål-PC\'en: New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force',
      'På DIN egen PC (uden domæne) skal mål-PC\'erne være betroede: Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "192.168.1.*" -Force',
      'Test forbindelsen: Test-WSMan 192.168.1.50 eller Test-NetConnection 192.168.1.50 -Port 5985',
      'Kør på mange PC\'er på én gang: $cred = Get-Credential; Invoke-Command -ComputerName PC01,PC02,PC03 -Credential $cred -ScriptBlock { hostname }',
      'Interaktivt på én PC: Enter-PSSession -ComputerName PC01 -Credential $cred (afslut med Exit-PSSession).',
      'Status lokalt: Get-Service WinRM · winrm enumerate winrm/config/listener',
      'PC\'er med Deep Freeze eller anden "frysning": lav opsætningen mens de er optøet (Thawed), ellers forsvinder den ved genstart.',
      'I Lennart Terminal: “Tilføj vært…” → metode WinRM, IP, brugernavn og adgangskode → fjern-fanen kører kommandoerne på den PC.',
      'WinRM og SSH er to forskellige metoder — et WinRM-svar handler kun om WinRM.',
    ],
  },
  {
    id: 'ssh',
    title: 'SSH (OpenSSH)',
    keywords: [
      [/\bssh\b|sshd|openssh|ssh-keygen|scp\b|port 22\b/i, 3],
    ],
    text: [
      'SSH er en anden fjernstyrings-metode end WinRM (port 22).',
      'Slå SSH-serveren til på mål-PC\'en (som administrator): Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic',
      'Firewall: New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22',
      'Forbind: ssh bruger@192.168.1.50 · test: Test-NetConnection 192.168.1.50 -Port 22',
      'Nøgle uden adgangskode: ssh-keygen -t ed25519 (offentlig nøgle i C:\\Users\\<bruger>\\.ssh\\id_ed25519.pub).',
      'I Lennart Terminal: Setup → “Slå SSH til”, og “Tilføj vært…” med metoden SSH.',
    ],
  },
  {
    id: 'rdp',
    title: 'Remote Desktop (RDP)',
    keywords: [
      [/\brdp\b|remote desktop|fjernskrivebord|mstsc|3389|fdenytsconnections/i, 3],
    ],
    text: [
      'Slå Remote Desktop til (som administrator): Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0; Enable-NetFirewallRule -DisplayGroup "Remote Desktop"',
      'Forbind fra en anden PC: mstsc /v:192.168.1.50 · test porten: Test-NetConnection 192.168.1.50 -Port 3389',
      'Hvem er logget på: quser',
      'I Lennart Terminal: Setup → “Slå RDP til”.',
    ],
  },
  {
    id: 'ports',
    title: 'Porte og processer',
    keywords: [
      [/\bport\b|porte|lytter|listen|optaget|owningprocess|netstat/i, 3],
      [/proces|process|pid\b|dræb|kill|taskkill|stop-process/i, 2],
    ],
    text: [
      'Hvem lytter på en port: Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalPort,OwningProcess',
      'OwningProcess er PID\'en. Se programmet: Get-Process -Id <PID>',
      'Alt på én linje: Get-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess',
      'Stop processen (advar først — data kan gå tabt): Stop-Process -Id <PID>',
      'Klassisk alternativ: netstat -ano | findstr :3000',
      'Tungeste processer: Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU',
    ],
  },
  {
    id: 'network',
    title: 'Netværk og internet',
    keywords: [
      [/\bip\b|ip-?adresse|ipconfig|dns|gateway|router|ping|tracert|traceroute|internet|netværk|wi-?fi|wlan|dhcp|mac-?adresse/i, 3],
    ],
    text: [
      'IP-konfiguration: ipconfig /all (alt) eller Get-NetIPConfiguration (kort).',
      'Forbindelse: ping 8.8.8.8 -n 4 virker men ping google.com fejler → DNS-problem.',
      'DNS: Resolve-DnsName google.com · ryd cache: ipconfig /flushdns',
      'Netkort: Get-NetAdapter | Format-Table Name,Status,LinkSpeed,MacAddress',
      'Port-test mod en anden maskine: Test-NetConnection 192.168.1.50 -Port 445',
      'Netværk i kaos: ipconfig /release; ipconfig /renew; ipconfig /flushdns — og evt. netsh winsock reset (kræver genstart).',
      'Wi-Fi: netsh wlan show interfaces · gemt kode: netsh wlan show profile name="NAVN" key=clear',
      'Offentlig IP: (Invoke-WebRequest -UseBasicParsing https://api.ipify.org).Content',
    ],
  },
  {
    id: 'disk',
    title: 'Disk og filer',
    keywords: [
      [/disk|drev|harddisk|ssd|plads|fuld|største filer|store filer|stor fil|temp|ryd op|oprydning|chkdsk|mappe/i, 3],
      [/fil(er)?\b/i, 1],
    ],
    text: [
      'Ledig plads på alle drev: Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n="Fri GB";e={[math]::Round($_.Free/1GB,1)}}',
      'De 5 største filer i mappen (og undermapper): Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 5 Name,@{n="MB";e={[math]::Round($_.Length/1MB,1)}},FullName',
      'Mappestørrelse: (Get-ChildItem C:\\Sti -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB',
      'Temp-mappen: mål først med Get-ChildItem $env:TEMP -Recurse -File | Measure-Object Length -Sum, ryd så med Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue (advar: sletter filer).',
      'Diskens sundhed: Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus · fejltjek: chkdsk C: /scan',
    ],
  },
  {
    id: 'services',
    title: 'Tjenester (services)',
    keywords: [
      [/tjeneste|service|spooler|printer|print|udskriv|lyd|audio|wuauserv|start-service|restart-service/i, 3],
    ],
    text: [
      'Status: Get-Service Spooler (navnet kan findes med Get-Service *print*).',
      'Genstart en tjeneste (som administrator): Restart-Service Spooler -Force',
      'Hængt print-kø: Stop-Service Spooler -Force; Remove-Item "C:\\Windows\\System32\\spool\\PRINTERS\\*" -Force; Start-Service Spooler',
      'Lyd virker ikke: Restart-Service Audiosrv -Force',
      'Tjenester der skulle køre men er stoppet: Get-Service | Where-Object {$_.StartType -eq "Automatic" -and $_.Status -ne "Running"}',
      'Start automatisk: Set-Service NAVN -StartupType Automatic',
    ],
  },
  {
    id: 'performance',
    title: 'Langsom PC og ydelse',
    keywords: [
      [/langsom|hakker|lagger|lag\b|ydelse|performance|cpu|ram|hukommelse|hænger|fryser|varm|opstart|autostart/i, 3],
    ],
    text: [
      'Tungeste processer på CPU: Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU',
      'Tungeste på RAM: Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name,@{n="MB";e={[math]::Round($_.WorkingSet64/1MB)}}',
      'Programmer ved opstart: Get-CimInstance Win32_StartupCommand | Select-Object Name,Command',
      'Oppetid (genstart hjælper ofte): (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime',
      'Fri RAM: Get-CimInstance Win32_OperatingSystem | Select-Object @{n="Fri GB";e={[math]::Round($_.FreePhysicalMemory/1MB,1)}}',
    ],
  },
  {
    id: 'repair',
    title: 'Fejl, logs og reparation',
    keywords: [
      [/fejl|error|crash|nedbrud|bluescreen|blå skærm|bsod|log|hændelse|event|sfc|dism|reparer|reparation|korrupt|genstartede/i, 3],
    ],
    text: [
      'Seneste fejl i systemloggen: Get-WinEvent -FilterHashtable @{LogName="System";Level=1,2} -MaxEvents 20 | Format-Table TimeCreated,Id,ProviderName -AutoSize',
      'Hændelse 6008 = uventet nedlukning · WHEA-Logger = hardwarefejl · dumps ligger i C:\\Windows\\Minidump.',
      'Reparér Windows-filer (som administrator, i denne rækkefølge): sfc /scannow — derefter DISM /Online /Cleanup-Image /RestoreHealth',
      'Opdateringer installeret: Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10',
    ],
  },
  {
    id: 'security',
    title: 'Sikkerhed, firewall og brugere',
    keywords: [
      [/firewall|defender|antivirus|virus|scan|sikkerhed|bitlocker|tpm|secure ?boot|administrator|admin-?rettighed|bruger|konto|adgangskode|password/i, 3],
    ],
    text: [
      'Firewall-status: Get-NetFirewallProfile | Format-Table Name,Enabled',
      'Defender-status: Get-MpComputerStatus | Select-Object AMServiceEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated',
      'Hurtig virusscan: Start-MpScan -ScanType QuickScan',
      'Lokale brugere: Get-LocalUser · administratorer: Get-LocalGroupMember Administrators',
      'Er jeg administrator: whoami /groups | findstr /i "S-1-5-32-544"',
      'BitLocker: manage-bde -status · TPM: Get-Tpm',
    ],
  },
  {
    id: 'gpu',
    title: 'GPU, skærm og strøm',
    keywords: [
      [/gpu|grafikkort|nvidia|amd|driver|skærm|fps|hz|strøm|power|batteri|dvale|sleep/i, 3],
    ],
    text: [
      'NVIDIA-status: nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv',
      'Grafikkort og driver: Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentRefreshRate',
      'Strømplan: powercfg /getactivescheme · alle planer: powercfg /list',
      'Batterirapport: powercfg /batteryreport (gemmes som HTML i den aktuelle mappe).',
    ],
  },
  {
    id: 'software',
    title: 'Programmer, opdateringer og system',
    keywords: [
      [/install|afinstall|program|software|app\b|winget|opdater|update|version|windows-version|build|pc-?navn|computernavn|hostname/i, 3],
    ],
    text: [
      'Installér med winget: winget search NAVN · winget install --id Firefox.Firefox -e',
      'Opdater alle programmer: winget upgrade --all',
      'Installerede programmer: winget list',
      'Windows-version og model: Get-ComputerInfo | Select-Object OsName,OsVersion,CsModel',
      'PC-navn: $env:COMPUTERNAME · omdøb (som administrator, kræver genstart): Rename-Computer -NewName "PC01"',
    ],
  },
  {
    id: 'app',
    title: 'Lennart Terminal (selve appen)',
    keywords: [
      [/lennart|appen|programmet|terminalen|denne terminal|fane|genvej|tastatur|menu|menuen|knap|knappen|indstilling|settings|historik|hent modeller|agent-?tilstand|agent mode|usb|offline|ai-?panel|prompt-?boks/i, 3],
      [/model|værter?|tilføj vært|fjern-?fane/i, 1],
    ],
    text: [
      'Layout: venstre sidebar (shells, 20 netværksknapper, quick-connect til LAN-IP), menuer øverst (Setup, Netværk, System, Processer, Disk, Sikkerhed, GPU & spil, Fejlfinding, Fjernsupport, AI), terminal i midten med prompt-boks nederst, AI-panel til højre.',
      'Genveje: Ctrl+T ny fane · Ctrl+W luk fane · Ctrl+J AI-panel · Ctrl+H historik · Ctrl+, Settings. I prompt-boksen: Enter kører kommandoen, Ctrl+Enter spørger AI\'en.',
      'Kodeblokke i AI-svar har knapperne Kopiér, Indsæt og Kør (kører i den aktive fane — også fjern-faner).',
      'Agent-tilstand: AI\'en kører selv kommandoerne trin for trin; farlige kommandoer kræver godkendelse.',
      'Fjern-PC: “Tilføj vært…” (SSH eller WinRM) → klik værten → fjern-fane, hvor alt køres på den PC.',
      'Modeller: Setup → “Hent modeller” henter større offline-modeller (fx Qwen2.5 Coder 7B). Historik: Ctrl+H. Alt kan ligge på et USB-stik i Data-mappen.',
    ],
  },
];

// Used when nothing matches: the handful of commands people need most
const GENERAL_CARD = {
  id: 'general',
  title: 'Almindelige Windows-kommandoer',
  text: [
    'Brug PowerShell-cmdlets (Get-*) først; Get-CimInstance frem for Get-WmiObject.',
    'Filtrér med Where-Object, sortér med Sort-Object, vis med Format-Table -AutoSize.',
    'Systeminfo: Get-ComputerInfo · tjenester: Get-Service · processer: Get-Process · netværk: Get-NetIPConfiguration · disk: Get-PSDrive -PSProvider FileSystem',
    'Ved ændringer: prøv -WhatIf først, og kør som administrator når det kræves.',
  ],
};

function scoreCard(card, text) {
  let score = 0;
  for (const [re, weight] of card.keywords) {
    if (re.test(text)) score += weight;
  }
  return score;
}

/**
 * Pick the cards that match a question. The latest question counts fully,
 * the previous one (follow-ups like "og på de andre PC'er?") counts half.
 * A second card is only added when it is nearly as relevant as the first —
 * mixing topics is exactly what confused the small model.
 */
function selectCards(question, previous, { max = 2 } = {}) {
  const q = String(question || '');
  const p = String(previous || '');
  const scored = CARDS
    .map((card) => ({ card, score: scoreCard(card, q) + scoreCard(card, p) * 0.5 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [GENERAL_CARD];
  const top = scored[0].score;
  return scored
    .filter((s, i) => i === 0 || s.score >= top * 0.75)
    .slice(0, max)
    .map((s) => s.card);
}

function renderCards(cards) {
  return cards
    .map((c) => [`[${c.title}]`, ...c.text.map((l) => `- ${l}`)].join('\n'))
    .join('\n\n');
}

module.exports = { CARDS, GENERAL_CARD, selectCards, renderCards, scoreCard };
