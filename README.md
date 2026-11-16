# FreeSeek

简体中文 | **English** · [Changelog](CHANGELOG.md)

**A local-first chat app that uses your own DeepSeek API key — no message limits, no daily quota, no "inactive conversation" cleanup.**

Forked from DeepSeek's official open-source [chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT), with the full official-app experience and three additions:

- **Continue from any chat** — start a new conversation that inherits all context of another.
- **Persona library** — builtin & custom system prompts (writer, translator, coder, Xiaohongshu copywriter, brainstorm partner…), applied to new chats.
- **Usage & cost dashboard** — daily token usage and estimated cost with peak/off-peak DeepSeek pricing (editable).

<p>
  <img src="docs/screenshots/desktop-welcome.png" width="49%" alt="Welcome (light)" />
  <img src="docs/screenshots/dark-welcome.png" width="49%" alt="Welcome (dark)" />
</p>

## v1.1.1 highlights

- True edge-to-edge layout (content under status & gesture bars, SystemBars integration)
- Official-style home: centered whale mark, greeting, rounded input card; no auto-opened settings
- Settings rebuilt as grouped full-screen card page (Account / App / Data / About) with version & links
- Full-width drawer with title search and avatar footer
- v1.1.0: pixel-whale icon, motion tokens, animations, back-to-bottom, Android back button

See the [Chinese README](README.zh-CN.md) for full documentation (installation, API key, build & signing, iOS, FAQ).

## Quick start

1. Create an API key at [platform.deepseek.com](https://platform.deepseek.com/) (top up a small amount).
2. Install `freeseek-v1.1.1-release.apk` from [Releases](https://github.com/WikG1018/freeseek/releases) (Android 7.0+), or build the web version: `pnpm install && pnpm build`, then serve `dist/`.
3. Paste your key in Settings and chat. Usage is billed per token by DeepSeek — watch the built-in cost dashboard.

## Building

```sh
pnpm install
pnpm build
npx cap sync android
cd android && gradlew assembleDebug   # or assembleRelease with android/keystore.properties
```

iOS requires macOS + Xcode: run `npx cap add ios` on a Mac, or trigger `.github/workflows/ios.yml` for an unsigned archive you can sign locally. Requires Node 22.12+, pnpm 10, JDK 21, Android SDK 36.

## License

MIT — retained from the upstream project (see [LICENSE](LICENSE)). This is an independent personal client, not affiliated with DeepSeek; follow the DeepSeek API terms of service.
