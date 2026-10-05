# Lennart Terminal

A AI-inspired terminal for Windows with an integrated **AI agent** — chat with your terminal, or let the AI take over and run a whole job for you.

[![CI](https://github.com/h4xtor/Lennarts-Terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/h4xtor/Lennarts-Terminal/actions/workflows/ci.yml) ![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **UI** — dark theme, left sidebar with shells, tabbed terminals, and the signature bottom prompt box
- **Real PTY sessions** — full-color PowerShell / PowerShell 7 / cmd / Git Bash tabs (ConPTY via node-pty)
- **AI chat panel** — streaming answers with command code blocks; every block gets **Copy / Insert / Run** buttons (Run types it into the active tab)
- **Agent mode** — describe a job ("find what's eating port 3000 and kill it") and the agent plans, runs commands in your terminal, reads the output and adapts until done. Live step-by-step view, Stop button, and a hard deny-list for dangerous commands
- **Bring any AI** — local (Ollama, LM Studio, llama.cpp) or cloud (OpenRouter, **OmniRoute**, OpenAI, Claude, Gemini, Qwen, Kimi) or the locally installed Antigravity CLI as the agent brain
- **Keys stay local** — API keys are stored only in your local `settings.json` and sent only to the provider you chose. No telemetry, no middleman
- **Safety net** — destructive AI commands ask for confirmation first; `format`, `diskpart`, `shutdown` and friends are always blocked

## Quick start

### Option A — portable zip (nothing to install)

Grab `LennartTerminal-portable-*.zip` from the [latest release](https://github.com/h4xtor/Lennarts-Terminal/releases/latest), unzip it anywhere and double-click `start-lennart-terminal.cmd`. No Node.js, no installer.

### Option B — run from source

Install [Node.js](https://nodejs.org) (LTS), then:

```cmd
git clone https://github.com/h4xtor/Lennarts-Terminal.git
cd Lennarts-Terminal
npm install
npm start
```

## Connect an AI

Open **Settings (Ctrl+,)** → *AI Provider* → press **↻** to load models → pick one → **Save**. The sidebar LED turns green when the endpoint answers.

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

Then in Lennart Terminal: Settings → *OmniRoute (gateway)* → ↻ → pick `auto` (or any specific model) → Save. Done — no API keys required for the free tiers.

### Agent brain

Settings → *Agent* lets you choose who drives Agent mode:

- **Built-in autopilot** — uses your selected AI provider, runs the plan/run/observe loop in your active terminal tab
- **Antigravity CLI** — if [`agy`](https://antdna.dev) is installed, its models appear here and the CLI becomes the agent engine (and chat backend)

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+J` | Toggle AI panel |
| `Ctrl+,` | Settings |
| `Ctrl+0` / `Ctrl+=` / `Ctrl+-` | Reset / zoom in / zoom out |
| `Enter` (prompt box) | Run command in active tab |
| `Ctrl+Enter` (prompt box) | Send prompt text to the AI |

## Development

```cmd
npm run check   :: fast node --check syntax gate over all JS
npm test        :: offline AI-layer tests (no provider needed)
```

Releases are automated: push a tag (`git tag v0.2.0 && git push origin v0.2.0`) and GitHub Actions builds the portable zip and publishes the release.

## Project layout

```
src/main/       Electron main process (window, PTY manager, settings store, AI clients, agent engine)
src/preload/    Context-isolated IPC bridge
src/renderer/   Warp-style UI (xterm.js tabs, AI panel, settings dialog)
test/           Offline AI-layer tests (mock Ollama + OpenAI + Anthropic servers)
tools/          Portable Node.js runtime for dev (not committed)
```

## Tests

```cmd
npm test
```

Runs the AI layer against mock local servers (no Ollama required) and verifies model listing + token streaming for the Ollama, OpenAI-compatible, Anthropic and OpenRouter protocols.

## Security notes

- API keys live in `%APPDATA%\Lennart Terminal\settings.json` — never commit this file, never paste keys into issues
- The agent's destructive-command confirmation can be relaxed in Settings, but the hard deny-list (`format`, `diskpart`, `bcdedit`, …) cannot
- Terminal output is only sent to your configured AI provider when you attach it

## Contributing

PRs are welcome! Keep it dependency-light, match the existing code style, and run `npm test` before submitting. Good first issues: shell profiles for macOS/Linux, i18n of the UI strings, more agent safety heuristics.

## License

[MIT](LICENSE) — free for everyone, forever.
