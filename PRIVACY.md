# Privacy policy — Lennart Terminal

_Last updated: 28 October 2026_

Lennart Terminal is a Windows terminal with a built-in AI assistant. It is made by Lennart Jensen and is open source (MIT): https://github.com/h4xtor/Lennart-Terminal

## What stays on your computer

- **Settings, saved hosts, passwords for hosts and API keys** are stored only in `settings.json` in the app's `Data` folder (next to the program) or in `%APPDATA%\Lennart Terminal`.
- **History** of commands and AI questions is stored only in `Data/history.jsonl` on your computer. You can delete it any time (Ctrl+H → "Ryd historik").
- **The built-in offline AI** runs entirely on your computer. Your questions are not sent anywhere.

## What is sent over the internet — and only when you choose it

- **Cloud AI providers** (OpenRouter, OpenAI, Anthropic, Google Gemini, and the others in Settings): only if you select one. Your question — and terminal output, if you attach it — is sent to **that provider only**, under their privacy policy.
- **Downloads**: the first time the built-in AI is used, the app downloads the AI engine (from github.com/ggml-org/llama.cpp) and the AI model (from huggingface.co). Optional extra models are downloaded from huggingface.co when you click "Hent".
- **Remote PCs**: commands you run in a remote tab are sent to the PC you added, over SSH or WinRM on your own network.

## What we never do

- No telemetry, no analytics, no tracking, no ads.
- No account is needed, and nothing is sent to the author.

## Contact

Questions: open an issue at https://github.com/h4xtor/Lennart-Terminal/issues
