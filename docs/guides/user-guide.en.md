# FreeSeek user guide

[Project home](../../README.en.md) · [简体中文](user-guide.md)

- [Install and update](#install-and-update)
- [Connect a model](#connect-a-model)
- [Chats, search, and context](#chats-search-and-context)
- [Voice and character voices](#voice-and-character-voices)
- [Personas, memory, and Agent](#personas-memory-and-agent)
- [Backup, import, and restore](#backup-import-and-restore)
- [Usage and preferences](#usage-and-preferences)
- [Where your data goes](#where-your-data-goes)
- [Troubleshooting and diagnostics](#troubleshooting-and-diagnostics)

## Install and update

| Platform | What to do |
| --- | --- |
| Android | Download `freeseek-v…-release.apk` from [Releases](https://github.com/WikG1018/FreeSeekApp/releases/latest). Open the APK, then follow Android's prompts to allow your installer to install it. An update with the same signing certificate can be installed over your existing copy. |
| Windows | Run `freeseek-v…-windows-x64-setup.exe` from the same release and open FreeSeek from Start. Windows may label the unsigned installer as an unknown publisher. |
| Web | Open the [web app](https://wikg1018.github.io/FreeSeekApp/). Your browser profile and the site's address determine where your data is stored. |
| iPhone / iPad | Open the web app in Safari. Open Share, tap **Add to Home Screen**, and enable **Open as Web App** if shown. Open FreeSeek from the new icon. |

Compare the installer hash against the release's `SHA256SUMS` file. In PowerShell, use `Get-FileHash -Algorithm SHA256 -LiteralPath 'your installer path'`.

On first launch, read the notice and choose to set up chat or import your history. Installed apps can prepare downloads when an update is available. Open the version button in the sidebar to read the notes and confirm installation. **Settings → About FreeSeek → Check for updates** also checks manually. When the web update is ready, finish any reply in progress and send or remove draft attachments before choosing **Reload to update**. Text drafts are kept. In browsers that support offline access, you can reopen the fully loaded app offline and read local chats.

## Connect a model

### Official DeepSeek

1. Open **Settings → API service** and follow the setup guide to create an API key at the [DeepSeek platform](https://platform.deepseek.com/).
2. Paste the key, then verify and save it.
3. Select Flash (`deepseek-flash`) or V4 Pro (`deepseek-v4-pro`). The model row shows supported inputs. Use a model with image support to send images.

Model access, balance, and billing are managed by the provider. [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)

### Other providers and self-hosted services

1. Open **API service → Advanced API configuration** and add a connection. For providers with separate API and subscription endpoints, pick the option that issued your key.
2. Enter the service URL, protocol, and API key. Available protocol families include OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini.
3. Fetch the model list or enter the exact model ID. Configure the model's context, maximum output, default reasoning, and image or PDF inputs according to its documented capabilities.
4. Test the model, then save and select it for chat. Testing sends a short request that can use your plan's allowance or incur a charge.

Web endpoints need to accept cross-origin requests from the FreeSeek website. Use HTTPS for self-hosted services to protect requests and keys in transit.

## Chats, search, and context

- Tap the conversation title to go to the top. Press and hold it to open the chat assistant. Editing a prompt or regenerating an answer creates versions you can switch between.
- Sidebar search matches titles and text in the visible conversation branch. Expand a chat to see more results and choose a match to jump to it. Reopening the sidebar restores the query and page. Switching reply versions refreshes the results. Scroll to load adjacent older or newer messages. Tap **Latest** to return to the newest messages.
- Pin conversations from their menu. Use the sidebar sort control to group chats by time or type. Enable model and reasoning controls in Chat preferences to change them above the composer.
- In an ordinary Flash chat, Smart search uses DeepSeek's server-side tools. For V4 Pro or a compatible custom model, configure a search service under Advanced API configuration. The model calls search when needed and can cite its sources.
- Use the plus button to attach files, select photos, or take a photo where supported. Image and PDF support depends on the selected model and endpoint. FreeSeek can extract text from supported documents locally. Open an image to zoom or use the available file preview to read and save an original.

The ring above the composer estimates how much of the model window the current request may use, including historical context and space reserved for the reply. DeepSeek lists a 1M-token window for Flash and V4 Pro. A custom model uses its configured or known limit. Conversation usage totals sum requests over time. [DeepSeek context limits](https://api-docs.deepseek.com/quick_start/pricing/)

Use **Organize and compress context** from the conversation menu or enable automatic compression under Chat preferences. Compression summarizes earlier turns and keeps the pending message and attachments for the request that comes next. The recent turns and full original history remain available locally. The selected model creates the summary and may charge for it. If a segment is refused, usable completed summaries are retained. The option to continue with recent chat can send the current message in the same conversation. Restore full context later from the conversation's compression menu. If a single attachment exceeds an input or parsing limit, use smaller sections or a compatible model.

## Voice and character voices

- **Voice input** uses the mic in the composer. Review the transcribed draft before sending. Voice input and single-voice read-aloud use the official DeepSeek speech service and need its API key.
- **Single-voice reading** uses the speaker button beside a reply. Choose a read-aloud voice in Chat preferences.
- **Character voices** can give narration and characters different voices. In **Chat preferences → Read-aloud mode**, choose **Character voices** and open the **Speech service** connection.

Use an existing Xiaomi MiMo connection or configure one separately. Choose **Pay-as-you-go API** for keys created from the guide's API link, or **Token Plan subscription** for keys from the plan page. Official MiMo can use the displayed defaults for preset and described voice models. Preview the narration and lead voices, then save. [MiMo speech synthesis](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5)

Open the character button at the top of a chat to audition voices and edit roles, aliases, descriptions, and role importance. Stories can have multiple leads. Manually assigned voices take priority. Use the live reading control to listen while a reply is being generated, or pause, resume, and stop playback in place. Regenerating a reply also changes the version used for voice playback.

## Personas, memory, and Agent

Create or import personas under **Settings → Personas & prompts** and apply them to a chat or set a default.

Automatic memory starts off. Turn it on under **Memory & Agents** (or **Memory** on Windows) to save long-term preferences. Relevant memories can be sent to the active model. Review or undo entries and view their source under **Recent memory**. To pause memory for a chat, open the chat assistant from the conversation title.

For example, “From now on, use tables for my weekly reports” saves a preference on your device. When you express a similar preference across several messages in the same chat, FreeSeek can ask the model to organize it. **Automatic memory usage** counts those model requests. You can also see preferences saved directly in **Manage memory**.

Agent is experimental on Android and the web. Turn on the option to choose a mode for new chats in **Memory & Agents**, then choose **Agent** when starting a conversation.

| Mode | How it works |
| --- | --- |
| Task | Carry out a defined request in the current turn. |
| Plan | Research and draft steps. Review the plan, request changes, or confirm execution. |
| Goal | Work toward completion criteria. View progress and pause or resume the run. |

Open the status control above the composer to inspect steps and tool use. Find outputs by turn in **Results** in the header, then preview, save, or share an original. Configure network, file, calculation, and project tools in Agent settings. Tool calling depends on the model. Browser restrictions affect web tools and background work. Windows can open Agent history and artifacts restored from backups. Use **Chat preferences → Background and notifications** on Android to enable completion notices. Background work depends on system policy and notification permissions.

## Backup, import, and restore

For a single conversation, open its sidebar menu and choose **Back up this chat**. The ZIP contains that chat and its associated files. Restore it on a version of FreeSeek that supports single-chat backups. If the same conversation exists, you can choose which copy to keep.

**Android on-device recovery.** After an upgrade, FreeSeek automatically copies existing chat text, branches and available original attachments into its private app storage. The copy is updated as you use the app. Open **Settings → Data management → On-device recovery copy** to see protected counts and storage use. If your chat list unexpectedly becomes empty, choose **Restore from the on-device copy**. Recovery adds missing chats and originals and keeps existing chat text.

Deleting a chat removes its recovery copy. Originals shared with other chats are retained. If you skip recovery, you can still choose **Data management → Delete all chats** and confirm to erase the remaining copy. Clearing all app data or uninstalling also removes the on-device copy. Export a ZIP outside the app before reinstalling or changing devices.

1. **Back up.** Open **Settings → Data management → Export all chats**. Save the ZIP and keep the original file. FreeSeek backups can preserve reply branches, pinned chats, available attachments and artifacts, usage, and personas. Partial backups identify skipped chats and missing originals.
2. **Move from DeepSeek.** Export chats in the DeepSeek app's data management settings. Select that ZIP from **Import chat history** in FreeSeek. Reading imported history requires no model key.
3. **Restore or merge.** Choose a FreeSeek ZIP from the same import entry. New chats are added alongside existing history. When a conversation ID is duplicated, choose to keep the local copy or use the backup. Two separate chats with the same title remain separate.
4. **Check before committing.** Review the counts and conflicts. Cancelling before the commit or an import validation failure preserves the existing records. If a supported archive contains some unrecoverable chats, review the skip count before importing the rest.

Supported ZIP64 archives can contain large backups. Individual decoded sessions have a 256 MiB read limit and are also subject to complexity and available space. Keep the app in the foreground while importing a large ZIP. A missing original can be supplied again from your device. Set up API keys and endpoints separately on the new device.

## Usage and preferences

- **Usage & cost** shows model and chat totals, estimated prices, and cache hit rates where the service reports cache data. Open an individual reply's usage label for a breakdown. Custom pricing applies to estimates. Check the provider's invoice for actual charges.
- **Screen time** shows local usage and conversation rankings.
- **Chat preferences** controls the startup page, the chat composer's Enter behavior, automatic compression, model controls, and usage labels.
- **Appearance & language** offers light or dark appearance, font size, MiSans or the system font, and Simplified Chinese or English.

## Where your data goes

Chats, attachments, and app settings are stored on the current device or in the selected site's browser storage. A chat request and inputs go to the model provider you choose. Search, web access, and speech send the related inputs to the corresponding service. Memory can send relevant entries when enabled. App update checks contact GitHub or configured download mirrors.

Export a ZIP before clearing app or site storage, reinstalling, changing browsers, or moving devices. A backup is stored wherever you choose to save it.

## Troubleshooting and diagnostics

| Issue | What to check |
| --- | --- |
| Requests fail after entering a key | Confirm the provider balance, supported model ID, and matching endpoint for the key. Test a custom model from its configuration. For web use, check the provider's cross-origin policy. |
| A photo or document will not send | Check the selected model's supported inputs. Reattach the original if an imported record has only its name or metadata. Consider sending a section of a large document. |
| A long chat exceeds its context | Open the context ring details. Try compressing older turns or continuing with recent messages. Split an oversized attachment if needed. |
| The sidebar appears empty | Use the history retry action to let FreeSeek read and repair the local index. Save any readable chats before changing app storage. |
| Estimated cost differs from the bill | Check the model's pricing, reported cache data, and separately billed service calls. |

In **Settings → About FreeSeek**, save the diagnostic bundle to a file or use the share option. Include the version, device or browser, approximate time, and steps in your [issue report](https://github.com/WikG1018/FreeSeekApp/issues). A diagnostic bundle contains device and runtime details and redacted logs. Standard bundles exclude credentials, chat and persona text, original attachments, and recordings. Review the ZIP before sharing. If startup fails, the startup screen can save basic diagnostic details.
