# Lennart Terminal

An AI-powered terminal for Windows with an integrated **AI agent** — chat with your terminal, or let the AI take over and run a whole job for you.

[![CI](https://github.com/h4xtor/Lennart-Terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/h4xtor/Lennart-Terminal/actions/workflows/ci.yml) ![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## ⬇️ Download

**[Download Lennart Terminal for Windows (.exe)](https://github.com/h4xtor/Lennart-Terminal/releases/latest/download/LennartTerminal-portable.exe)** — always the newest version, one file, nothing to install (Windows 10/11, 64-bit).

Prefer a folder? [Download the zip](https://github.com/h4xtor/Lennart-Terminal/releases/latest/download/LennartTerminal-win-x64.zip) · [All releases & checksums](https://github.com/h4xtor/Lennart-Terminal/releases)

> **"Windows protected your PC"?** The EXE is not code-signed yet, so Windows SmartScreen does not know it. Click **More info → Run anyway**. Every release is built by GitHub Actions directly from the source code in this repository, and `SHA256SUMS.txt` on the release page lets you verify the file.

## Features

- **UI** — dark and light themes, left sidebar with shells, tabbed terminals, and the signature bottom prompt box
- **Real PTY sessions** — full-color PowerShell / PowerShell 7 / cmd / Git Bash tabs (ConPTY via node-pty)
- **AI chat panel** — streaming answers with command code blocks; every block gets **Kopiér / Indsæt / Kør** buttons (Kør runs it in the active tab — local or remote)
- **Focused AI knowledge** — every question only gets the matching knowledge cards (WinRM, SSH, RDP, ports, network, disk, services, …), so small offline models stay on topic instead of mixing subjects
- **Loop guard** — a looping answer is stopped the moment it repeats itself, duplicates and leaked prompt text are removed, and cut-off answers are tidied with a note
- **Agent mode** — describe a job ("find what's eating port 3000 and kill it") and the agent plans, runs commands in your terminal, reads the output and adapts until done. Live step-by-step view, Stop button, and a hard deny-list for dangerous commands
- **Bring any AI** — **indbygget offline-model** (Qwen2.5 Coder, hardkodet — virker uden internet), local (Ollama, LM Studio, llama.cpp) or cloud (OpenRouter, **OmniRoute**, OpenAI, Claude, Gemini, Qwen, Kimi) or the locally installed Antigravity CLI as the agent brain
- **USB-portable** — put the folder (with a `Data` directory) on a USB stick and carry your terminal, AI, settings, hosts and **full history** between PCs. Perfect for troubleshooting machines on a LAN
- **Network execution** — save hosts (SSH or WinRM) in the sidebar and run commands on remote PCs from dedicated remote tabs; output streams live and everything is logged
- **Permanent history** — every command (local, remote, agent) and every AI Q&A is stored in `Data/history.jsonl`. Open it with the 📚 button or `Ctrl+H` and search across everything that has happened
- **Keys stay local** — API keys are stored only in your local `settings.json` and sent only to the provider you chose. No telemetry, no middleman
- **Safety net** — destructive AI commands ask for confirmation first; `format`, `diskpart`, `shutdown` and friends are always blocked

## Quick start

### Option A — EXE (nothing to install)

- **[LennartTerminal-portable.exe](https://github.com/h4xtor/Lennart-Terminal/releases/latest/download/LennartTerminal-portable.exe)** — one single file, just double-click it
- **[LennartTerminal-win-x64.zip](https://github.com/h4xtor/Lennart-Terminal/releases/latest/download/LennartTerminal-win-x64.zip)** — unzip anywhere and double-click **`Lennart Terminal.exe`** (starts a little faster)

Both are portable: a `Data` folder (settings, hosts, history, offline AI) is created next to the program, so it works straight from a USB stick. No Node.js, no installer.

The built-in offline AI downloads its engine + model (~1 GB) on first use.

### Option B — run from source

Install [Node.js](https://nodejs.org) (LTS), then:

```cmd
git clone https://github.com/h4xtor/Lennart-Terminal.git
cd Lennart-Terminal
npm install
npm start
```

## Opdatering

Klik på det gyldne **versionsmærke** nederst til højre (eller **Indstillinger → Om → Søg efter opdatering**). Appen spørger GitHub Releases, viser hvad der er nyt siden din version, henter den portable `.exe` og kontrollerer dens SHA-256, før den installerer.

- **Portable build:** den kørende `.exe` erstattes på samme sted, og den nye version åbner automatisk. Den gamle fil gemmes som `.old`, så den kan gendannes ved problemer; flyt eller slet sikkerhedskopien selv, før du opdaterer igen.
- **Kildekode/udvikling:** den nye version lægges i `%LOCALAPPDATA%\Lennart Terminal` og åbner automatisk. Din kildekode og dit nuværende miljø røres ikke.
- **Efter genstart** vises en engangsoversigt med, hvad der blev opdateret, og hvilke ændringer der kom med.

Første opdatering fra en ældre build (f.eks. v0.2.0 → v0.4.2) kan ikke vise efter-oversigten *inde i den nye version*, fordi den pågældende release blev bygget før funktionen fandtes. Markøren gemmes, så en v0.4.2-build der selv indeholder updateren kan vise den; en nyere version ignorerer den som forældet. Selve download, kontrolsum og installation virker fra første gang.

Releasen skal indeholde en `*-portable.exe` og `SHA256SUMS.txt` — det gør de officielle releases. EXE-filen er ikke codesigned endnu; Windows kan derfor vise "Windows protected your PC" første gang.

## USB-stick mode (portable)

1. Copy the EXE (or the unzipped folder) to a USB stick
2. Double-click it

The app keeps **everything on the stick** in a `Data` folder next to the program:

```
USB:\LennartTerminal\
├── LennartTerminal-portable.exe   (or Lennart Terminal.exe + its files)
└── Data\
    ├── settings.json         (providers, API keys, hosts)
    ├── history.jsonl         (permanent history — travels with you)
    └── localai\              (offline AI engine + model)
```

Unplug, walk to the next PC, plug in, run — your AI, your hosts, your history, your keys. Nothing is left on the host PC.

## Run commands on network PCs

1. Click **+ Tilføj vært…** in the sidebar (or add hosts under Indstillinger → Netværk)
2. Choose **SSH** (recommended) or **WinRM**
3. On each target PC, run the one-time SSH setup command (button in Indstillinger → Netværk, run as admin):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic; New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

4. Click the host in the sidebar → a remote tab opens. Type commands in the bottom prompt box — they execute **on that PC**, stream output live, and land in the permanent history marked **Netværk**.

Commands are sent as a base64 `-EncodedCommand` with `-OutputFormat Text`, so `$variables` and `|` reach PowerShell intact instead of being expanded by the remote shell, and errors stay readable instead of arriving as `#< CLIXML` XML. SSH only: a Linux/macOS target works too — install PowerShell 7 (`pwsh`) and make `powershell.exe` resolve to it (`sudo ln -s "$(command -v pwsh)" /usr/local/bin/powershell.exe`). WinRM is Windows-only.

**Linux Mint 22.x / Ubuntu 24.04:** use the Ubuntu 24.04 Microsoft feed explicitly — Mint reports `VERSION_ID=22.3`, so the usual `$VERSION_ID` snippet would request a non-existent `ubuntu/22.3` repo:

```bash
sudo apt-get update
sudo apt-get install -y wget apt-transport-https software-properties-common
wget -q https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb && rm packages-microsoft-prod.deb
sudo apt-get update && sudo apt-get install -y powershell
sudo ln -sf /usr/bin/pwsh /usr/local/bin/powershell.exe
```

### Many PCs at once with WinRM (no domain)

1. On **each target PC** (as admin, once): Setup → **“Slå WinRM til (kør på MÅL-PC)”**, and for local admin accounts Fjernsupport → **“WinRM: tillad lokale admin-konti”**. Frozen PCs (Deep Freeze): do it while thawed.
2. On **your own PC** (as admin, once): Fjernsupport → **“WinRM: stol på LAN-PC'er”** (sets `TrustedHosts`).
3. Add each PC with **Tilføj vært…** → method **WinRM**. If the connection fails, the remote tab prints the exact fix (TrustedHosts, access denied, WinRM off).

Or straight from PowerShell: `Invoke-Command -ComputerName PC01,PC02,PC03 -Credential (Get-Credential) -ScriptBlock { hostname }`

## Connect an AI

Open **Indstillinger (Ctrl+,)** → *AI & modeller* → press **↻** to load models → pick one → **Save**. The sidebar LED turns green when the endpoint answers.

### Local / private (no key needed)

| Provider | Default endpoint | Notes |
|---|---|---|
| **Ollama** | `http://127.0.0.1:11434` | Start Ollama, then `ollama pull qwen2.5-coder:7b` |
| **LM Studio** | `http://127.0.0.1:1234/v1` | Start the local server in LM Studio |
| **llama.cpp** | `http://127.0.0.1:8080/v1` | Run `llama-server` |
| **Custom OpenAI-compatible** | your URL | vLLM, Jan, KoboldCpp, … |

Recommended local coding models: `qwen2.5-coder:7b`, `qwen2.5-coder:14b`, `deepseek-coder-v2`, `codellama:13b`.

### Cloud (API key per provider)

| Provider | Key / access |
|---|---|
| **OpenRouter** | one key, 400+ models — [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OmniRoute** | free local AI gateway — `npm install -g omniroute && omniroute`, then pick model `auto` (no key needed) |
| **OpenAI / Codex** | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Claude (Anthropic)** | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Qwen (DashScope)** | Alibaba Cloud console |
| **Kimi (Moonshot)** | [platform.moonshot.cn](https://platform.moonshot.cn/console/api-keys) |

Each provider remembers its own key and model, so you can switch between them without re-entering anything.

### OmniRoute in 30 seconds

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a free, open-source AI gateway that exposes **350+ providers through one OpenAI-compatible local endpoint** (port 20128):

```cmd
npm install -g omniroute
omniroute
```

Then in Lennart Terminal: Indstillinger → *OmniRoute (gateway)* → ↻ → pick `auto` (or any specific model) → Save. Done — no API keys required for the free tiers.

### Agent brain

Indstillinger → *Agent* lets you choose who drives Agent mode:

- **Built-in autopilot** — uses your selected AI provider, runs the plan/run/observe loop in your active terminal tab
- **Antigravity CLI** — if [`agy`](https://antdna.dev) is installed, its models appear here and the CLI becomes the agent engine (and chat backend)

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+J` | Toggle AI panel |
| `Ctrl+,` | Indstillinger |
| `Ctrl+0` / `Ctrl+=` / `Ctrl+-` | Reset / zoom in / zoom out |
| `Enter` (prompt box) | Run command in active tab |
| `Ctrl+Enter` (prompt box) | Send prompt text to the AI |

## Development

```cmd
npm run check   :: fast node --check syntax gate over all JS
npm test        :: offline AI-layer tests (no provider needed)
node scripts/eval-localai.js   :: answer-quality check against a running llama-server (127.0.0.1:9601)
```

### Windows smoke test (one command)

Double-click **`test-lennart.cmd`** to run the syntax check, the automated tests and a real UI smoke test. It starts the app in a temporary profile, so your settings, history and the embedded AI model are untouched. A small local stub answers the AI endpoint, which means **no internet and no ~1 GB model download** are needed.

The UI test checks the Danish labels, that a command typed directly in the terminal lands in the history, that the bottom prompt box still records commands, that the agent settings are remembered, that a new tab inherits the selected theme, and that the update dialog shows a new GitHub release (against a local stub). It needs Node.js 22+ and `npm ci`.

Run only the UI smoke test (without the two other gates):

```cmd
npm run smoke
```

Releases are automated on `main`: a version change in `package.json` (or a `v*` tag) makes GitHub Actions build the portable `.exe` and zip, write `SHA256SUMS.txt` and publish the release. The workflow runs are public: [github.com/h4xtor/Lennart-Terminal/actions](https://github.com/h4xtor/Lennart-Terminal/actions).

## Project layout

```
src/main/       Electron main process (window, PTY manager, settings store, AI clients, agent engine, GitHub updater)
src/preload/    Context-isolated IPC bridge
src/renderer/   Warp-style UI (xterm.js tabs, AI panel, settings dialog, update dialog)
test/           Offline AI-layer and updater tests (mock providers + local GitHub stub)
tools/          Portable Node.js runtime for dev (not committed)
```

## Tests

```cmd
npm test
```

Runs the AI layer against mock local servers (no Ollama required) and verifies model listing + token streaming for the Ollama, OpenAI-compatible, Anthropic and OpenRouter protocols.

## Security notes

- API keys live in `%APPDATA%\Lennart Terminal\settings.json` (or `Data\settings.json` in portable mode) — never commit this file, never paste keys into issues
- The agent's destructive-command confirmation can be relaxed in Indstillinger, but the hard deny-list (`format`, `diskpart`, `bcdedit`, …) cannot
- Terminal output is only sent to your configured AI provider when you attach it

## Contributing

PRs are welcome! Keep it dependency-light, match the existing code style, and run `npm test` before submitting. Good first issues: shell profiles for macOS/Linux, more agent safety heuristics.

## License

[MIT](LICENSE) — free for everyone, forever.
