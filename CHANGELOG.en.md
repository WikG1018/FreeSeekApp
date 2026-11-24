# Release notes

## v3.1.6

This stable release brings together changes since public version 3.0.0, covering chat backups and recovery, speech, long conversations, and the web app.

### Chat backups and recovery

- Import new chats alongside existing history and choose which copy to keep when a conversation appears in both places. Cancelling a failed or unfinished import preserves existing chats.
- Recover usable branches from official DeepSeek archives. When a selected branch is missing, a valid endpoint is selected. If some conversations cannot be recovered, review the count before importing what is available.
- Export available conversations and attachment originals when a record cannot be read or validated. Partial backups report skipped chats and missing originals and retain the names and details of missing attachments.
- Retry now checks and repairs a blank history index before reloading available chats. A single unreadable conversation no longer prevents other chats from opening.
- Improved web storage recovery and added history and storage evidence to diagnostic bundles.

### Voice input and character voices

- The composer shows recording time, a waveform, and transcription progress. Retry a failed transcription with the same recording, or discard it. Successful transcription goes into the draft for review.
- Character voices use distinct voices for dialogue and narration and show who is speaking. Long lines are split near sentence boundaries.
- Open the character list from the chat header to preview and edit voices. Aliases, shared walk-on voices, and character settings carry into continued conversations.
- Speech synthesis can reuse an existing Xiaomi MiMo connection or use separately configured preset and described voice models. Errors for lost audio, timeouts, and microphone access are clearer.

### Long conversations

- Improved context compression with compatible third-party endpoints. The app accepts common summary completion signals and retries when an endpoint rejects reasoning parameters.
- Improved estimates for models without a configured context window. Short chats get an earlier explanation, and completed compression work remains available for recovery.

### Web and platform compatibility

- Improved web startup on slow networks, offline loading, and cache handling. iPhone and iPad use the system font by default, with a choice under Appearance.
- Updated back navigation in mobile browsers and home-screen apps to follow the active screen or panel and reduce white flashes and accidental exits.
- Fixed a workspace file preview crash on older Android versions. In-app update notes display headings and lists in their correct sections.

## v3.1.5

### Stability fixes
- Fixed a crash when opening a file preview from the workspace on Android 7.0 to 10. The preview screen used several APIs that only exist in Android 9 and 10 (the data directory suffix, status and navigation bar contrast, the render process callback and the animator switch), and calling them on older releases crashed the screen. They are now used only where they exist; the preview itself still opens.

## v3.1.4

### Stability fixes
- Fixed the cases where saved chats were not shown and retrying never helped: records sitting in the other storage bank, an index that no longer matches the conversation bodies, a native checkpoint read that times out, and a single unreadable conversation. Retry now repairs first without changing or deleting any conversation record, then reads again. A conversation that cannot be opened can be deleted on its own while the rest stay usable.
- Fixed context compression failing behind compatible third-party endpoints: a summary that arrives without the standard end event is no longer treated as incomplete, and endpoints that reject thinking or reasoning parameters are retried once without them.
- Custom models without a configured context window are no longer assumed to be 8192 tokens when compressing, which split the history too finely and capped the summary output at 1024. The default is now 32768.
- Short conversations no longer make you wait only to learn that compression cannot save space: the button explains that there is too little to compress, and a compression that saves nothing no longer discards its finished progress.

### Character voices
- The voice list in the prompt is grouped by language, so Chinese-speaking characters are no longer given English voices (four of eight characters in a real ten-turn test).
- Walk-on characters and the narrator no longer default to the same voice: walk-ons now default to a voice of their own.
- Only the eight voices that exist in the app are offered, so the model cannot pick a voice the edit dialog cannot show.

## v3.1.3

### Stability fixes
- Fixed the lead-voice setting doing nothing. It could be switched and saved but was never passed to the model: with "Preset" selected, a lead could still get a described voice and make every line wait for the whole synthesis. "Preset" now keeps every character on preset voices; "Described" has leads described. The setting applies to characters that appear from now on; existing ones are left alone.
- "Aliases: none" from the model no longer creates an alias called "none".
- A voice or nature the model adds to an existing character later is no longer dropped when its importance is unchanged and no alias was added.
- The narrator and walk-on characters are never switched to a described voice.

### Interface
- Relaxed what counts as a lead: the character with the most lines in a scene. It used to require a character who runs through the whole work, so a two-person exchange had no lead at all and the "Described" setting never applied.
- Narration-only stories are now tagged reliably. Text with nobody speaking used to count as "no tags", so a story told entirely by the narrator could skip the narrator's voice.

## v3.1.2

### Interface
- The Character voices switch now appears once, in Chat preferences. The Speech synthesis page shows its state and jumps there, so two switches can no longer disagree.
- The Speech synthesis page gains the lead-voice setting, which previously lived only in Chat preferences.
- The prompt now carries a worked example and tighter rules, so the model reliably uses one tag format, always states importance, and picks voices from the preset list.

### Stability fixes
- Eleven dialogue shapes were tested against the real model (plain Q&A, code, one character, several characters, narration only, walk-on roles, one character with three moods, mixed narration and dialogue, English, eight-turn argument, relaying someone else's words). No tags leak into reply text in any of them.
- The English interface no longer contains Chinese sample text.

## v3.1.1

### Stability fixes
- Fixed read-aloud tags leaking into reply text. The prompt asked for one specific bracket pair, but the model writes other brackets or none at all, so tags stayed visible and no character was recognised. Tags are now detected by their structure, independent of brackets.
- Fixed characters like the narrator getting no voice: the model often names a character without a full declaration, and those were skipped. They are now registered and read like any other character.
- Fixed the same character being created twice with mismatched voices: the model uses short names (a given name instead of the full name), which are now resolved to the same role.
- Fixed character importance never updating: a full declaration that arrives later now fills in the role it was guessed from.
- Multi-segment playback no longer stutters between speakers: the next segment starts synthesizing while the current one plays.

### Interface
- Shows "Reading: <character>" while a character is being read.
- The whole row in the character panel opens the editor, not just the small button.
- The editor gains "have the model rewrite it" for the voice description.

## v3.1.0

### Interface
- New "Character voices": with it on, each character in a reply is read in a different voice, like a radio play. The switch lives in Settings → Chat preferences; a mask button appears in the conversation header, and opening it shows every character in this work.
- A character's voice and nature are fixed the first time it appears and kept from then on — chapter one hundred still sounds like the same Daiyu.
- The tone of each line is performed by the model as the story goes: trembling when hurt, lifting when happy. What you edit in the panel is the voice itself (timbre, aliases, nature); the tone is deliberately not yours to set.
- If a voice does not fit, open the panel and pick another; save and you hear it immediately.
- A long novel does not need a voice for every walk-on: shopkeepers and passers-by share one voice by default, folded into a single row in the panel, and the merging can be turned off in settings.
- Continuing a story into a new conversation carries the characters and their voices across, so nothing needs re-configuring.
- With the feature off, nothing extra appears in the interface and no tags show in replies.

### Added
- Xiaomi MiMo-V2.5 TTS: nine preset voices plus one-line voice design. Preset voices stream as they synthesize; designed voices wait for the whole segment.
- Settings → API services → Advanced custom configuration now has "Speech synthesis": follow the chat model and reuse the configured MiMo, or fill in a separate speech service endpoint and key (for TTS-only services, or to bill separately).

### Other
- The read-aloud button now reads a tagged reply segment by segment, one voice per character; untagged replies behave exactly as before.

## v3.0.9

### Stability fixes
- Export no longer fails as a whole when a single conversation cannot be read: it skips those and exports the rest, with a note saying "Skipped N conversations". Previously one unreadable conversation blocked the entire backup.
- The app now asks for persistent storage at startup, so the system is less likely to clear local records when space runs low.
- If the database connection is terminated, the conversation list is re-synced instead of showing conversations that no longer exist.
- If the app had conversations last time but finds none now, diagnostics record a "sessions.lost" event so it is clear whether the system cleared the data.

## v3.0.8

### Stability fixes
- Fixed the iPhone home-screen build flashing a blank white screen when swiping back from Settings: the iOS edge swipe is a Safari history traversal, and it paints the previous entry, while guard entries were never actually displayed. The home-screen build no longer creates those entries, so the flash is gone.
- Settings now has a close button in the top-right corner. The home page used to rely on the back gesture alone, which would have made Settings impossible to leave on iPhone.
- iPad landscape, Android and desktop back behaviour is unchanged.

## v3.0.7

### Interface
- On iPhone and iPad the interface now uses the system font by default, skipping the ~14 MB Chinese webfont download — it opens faster and uses less data. You can switch back to MiSans in Settings → Appearance → Font; the option notes the data cost.

## v3.0.6

### Stability fixes
- Fixed the web build never opening on slow networks: it used to give up after 10 seconds and stay on the error screen, which also meant the cache never filled, so every later launch failed too. A slow network now just shows "Loading…" and keeps waiting, up to 60 seconds.
- Less to download on first load: iPhone and newer Android no longer fetch the full compatibility polyfill set.
- The offline cache is filled earlier, so the second launch is noticeably faster.
- Failure messages are device-aware: iPhone no longer tells you to update Android System WebView.
- Startup diagnostics now record which step it stopped at.

## v3.0.5

### Interface
- On the iPhone home-screen build, "back" is an edge swipe, not a button. Swiping now closes the current layer (settings, dialogs, sidebar, chat); once on the home screen another swipe does nothing — no more "press back again to exit" prompt and no more being thrown out of the app.
- Android and desktop browsers still have a back key, so "press back again on the home screen to exit" stays.

### Stability fixes
- Some Android browsers (e.g. Xiaomi's built-in browser) close the app themselves when they decide there is nothing left to go back to, before any page code runs. On those, use the Android installer; Chrome's "Add to Home screen" is not affected.

## v3.0.4

### Stability fixes
- Fixed the web / add-to-home-screen build leaving the app after two quick back presses. Between a back press and the app being notified there is a short gap (22–650 ms measured); with only one guard entry, a second press inside that gap made the browser think there was nothing left to go back to and close the app. Two guard entries are now kept, so the extra press still lands inside the app. Verified on Android 17: presses 0–150 ms apart no longer exit.
- History length stays constant and no longer grows with use.
- Confirming "press back again to exit" now really leaves instead of being pulled back in.

## v3.0.3

### Stability fixes
- Every back press in the web build now re-arms the history guard first, so a consumed entry can no longer make the next press exit; the outermost level asks for one more press before leaving.
- The guard is also restored when the app returns from the background or the back-forward cache.

## v3.0.2

### Stability fixes
- The web build now restores its back guard when it returns from the background, from the back-forward cache, or after being suspended, so a single back press can no longer make the next one exit.
- Back at the outermost level still needs a second press within two seconds; the version shown in Settings → About FreeSeek tells you whether the web build has updated.

## v3.0.1

### Stability fixes
- Fixed the web build and installed PWA closing as soon as the system back gesture was used: back now closes settings pages, dialogs, search and the sidebar in turn, then returns to the welcome screen, and only asks for one more press at the outermost level instead of leaving the app immediately.
- Back at the outermost level now needs a second press within two seconds, and each back press logs which layer it hit so a stuck sidebar or welcome screen can be diagnosed.

## v3.0.0

### A note from the author
- For the past days I have been working on one thing: making FreeSeek usable on a computer and on an iPhone. Both finally work: Windows now has a real installer, and iPhone needs no signing at all.
- FreeSeek has no paid tier, no membership and no in-app purchases. You bring your own API key, and features and limits depend only on that key. I do not earn anything from your usage.
- This project has always been a labour of love. If it helps you, you can buy me a coffee with "Support the developer" at the bottom of the sidebar. Not donating changes nothing about the app.
- One thing to be clear about: the "Top up API" button opens the official DeepSeek top-up page. The money goes to DeepSeek and has nothing to do with me.

### Interface and input
- Sidebar: search and new chat share one row, with the New chat button at the right. Regular chats and Agent chats use different icons, and can be sorted by time or type with pinned chats always first.
- Settings → Chat preferences now has a Start page choice: reopen the last conversation, or go straight to a new chat.
- Settings → Chat preferences now has an Enter key choice: send on Enter, or insert a line break, matching your input method.
- Settings home: phones exit with the back gesture, while the desktop layout keeps only the rail back button. Memory & Agent is marked as experimental.
- Appearance offers the default font or the system font, four text sizes, and the accent colour is now consistent in both themes.

### Desktop release
- New Windows x64 client: local chat history, long conversation compression, third-party models, web search, speech, camera and diagnostic export, matching the phone app. Installer: https://github.com/WikG1018/FreeSeekApp/releases/latest

### iPhone / iPad
- No Apple signing needed: open the web app at https://wikg1018.github.io/FreeSeekApp/ in Safari, tap Share → Add to Home Screen, and it opens full screen from its icon and still loads its shell offline.

### Agent and memory (in testing)
- Agent and memory are still in testing and can behave unreliably: a run may stop early, retry, or return incomplete results. If you hit a problem, export a diagnostic bundle from Settings → About FreeSeek.
- New chats can be a regular chat or an Agent chat. The Agent toolbar offers tasks, plans and goals: plans are approved before running, goals take completion criteria and a budget, and background runs can be watched or stopped from the Android notification or the Windows tray.
- The plan expands above the composer with the current step, what was read and why something failed. Tool calls follow the answer and thinking stays collapsed. Usage accumulates per model request and saved artifacts are kept.
- Automatic memory is off by default. When enabled it saves and updates long-term preferences, which can be inspected, undone or deleted, and paused per conversation; memory usage is reported separately.
- Tool settings manage the search, web, GitHub, attachment, calculation and file generation tools available to the Agent. Skills can be imported, MCP servers connected and sub-agents used for review, and outgoing tool calls show what will be sent before they run.

### Agent files and results
- The Agent can run JavaScript tests and an isolated web preview on the device, edit local projects, inspect and undo changes, and export patches, adjust 3D part sizes, check meshes and save GLB or STL.
- Generated files are grouped by turn under Results and can be previewed, shared, saved, or reused in the next turn.
- Word, Excel, PDF and PPTX handled by the Agent can be viewed in their original layout: pages, zoom, find and formulas. Excel and CSV support filtering, grouping and summaries, and attachments support local text and DOCX parsing.
- On Windows, an installed LibreOffice can render complex Office pages, with the built-in reader used when no engine is available.

### Stability fixes
- Fixed the white screen when the app starts from a notification: a late system splash view is now removed immediately. Before this it could stay above the interface, which looked like a permanent white screen after tapping a notification.
- Tapping a reply-ready notification returns to that conversation. It still works after the process was killed, and tapping the same notification twice no longer breaks the route.
- A long document no longer fails the whole turn: the official API parses documents into text with a 32k cap, so the app now resends that turn with the text parsed on the device while the original attachment stays in the conversation.
- Oversized requests now show a translated explanation with the token counts reported by the model service. The context panel separates compressible history from a message that is itself too large, and suggests splitting the attachment or sending in several messages.
- A missing conversation index is rebuilt from local records. Backups are read and written in chunks, imports show progress and replace data only after validation.
- Diagnostic bundles record the phase and timing of startup, storage, model requests, attachments, updates and sharing, and keep the key evidence.

### Other
- Completed the English interface: built-in personas, provider presets, narrow labels and English release notes.
- Fixed third-party models being unable to send text when continuing an old conversation whose original attachments are missing.
