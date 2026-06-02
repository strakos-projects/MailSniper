# Mail Sniper 🎯

An intelligent, zero-knowledge email sorter for Mozilla Thunderbird.

Mail Sniper connects directly to your local LLM (via LM Studio) to read, categorize, and route incoming emails into dynamically created folders. Your emails never leave your machine.

## ⚡ Core Features

- **100% Local AI Processing:** Integrates seamlessly with LM Studio via local REST API.
- **Auto-Routing:** AI evaluates the email content and moves it to specific smart folders (e.g., `AI_Work`, `AI_Invoice`) or flags it as Junk.
- **Zero-Data Leak:** No third-party APIs, no cloud processing. Your inbox privacy is strictly maintained.

## 🛠️ Tech Stack

- **Platform:** Mozilla Thunderbird (Manifest V3 WebExtension)
- **AI Engine:** Local LLM via LM Studio (Default: `http://127.0.0.1:1234/v1/chat/completions`)
- **Logic:** Asynchronous JavaScript background workers manipulating the Thunderbird accounts/messages API.

## 🚀 How to Use

1. Start your local inference server in [LM Studio](https://lmstudio.ai/).
2. Load this extension into Thunderbird via Add-on Manager (Debug mode).
3. (Optional) Tweak the model name and system prompt in the extension Options.
4. Watch your inbox sort itself automatically.
