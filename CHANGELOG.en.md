# Release notes

## v3.0.1

### Stability fixes
- Fixed the web build and installed PWA closing as soon as the system back gesture was used: back now closes settings pages, dialogs, search and the sidebar in turn, then returns to the welcome screen, and only asks for one more press at the outermost level instead of leaving the app immediately.

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
