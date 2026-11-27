package app.freeseek.chat;

import android.content.Context;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** A bounded copy of diagnostic facts, stored independently of the WebView profile. */
final class RetainedClientLog {
    private static final int LIMIT = 512;
    private static final int HISTORY_RESERVE = 96;
    private static final int ISSUE_RESERVE = 128;
    private static final int MAX_FILE_BYTES = 1_048_576;
    private static final long RETENTION_MS = 7L * 24 * 3600 * 1000;
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final ArrayList<JSONObject> events = new ArrayList<>();
    private static final Set<String> scopes = fields("app api upload chat storage backup update speech search settings persona usage ui diagnostics");
    private static final Set<String> measures = fields("sessionCount previousSessionCount indexCount alternateCount restoredCount previousCount "
        + "activeCount actualKeyCount indexEntryCount databaseVersion previousVersion requestedVersion alternateKeyCount "
        + "verifiedAt elapsedMs timeoutMs attempt attempts retry retries status httpStatus statusCode code bytes "
        + "writtenBytes receivedBytes expectedBytes totalBytes expandedBytes fileCount originalBytes attachmentCount entryCount processed total "
        + "count sourceCount requestCount searchAttempts standaloneSearches inputTokens cachedInputTokens outputTokens "
        + "requestedTokens contextTokens limit maxTokens messageCount omittedFiles segments segment completedSegments step maxSteps "
        + "size width height versionCode percent pendingCount streamingCount resultCount uploadedBytes "
        + "retryAt rangeStart rangeEnd segmentRequests budgetRequests dropped");
    private static final Set<String> flags = fields("available cancelled preparing diskStaging confirmedEmpty previousSelection expected "
        + "usingStagingStores createdDatabase repaired restored missing cached online secureContext native saved exhausted "
        + "hasFile automatic canRetry complete retained hasMessageTarget blocking waitingForHistory checkpointPresent allowEmpty canStartFresh "
        + "selectorPresent committedSelectorPresent selectionConflict interruptedImport partial requestInFlight");
    private static final Set<String> codes = fields("Error TypeError SyntaxError ReferenceError RangeError AbortError TimeoutError "
        + "QuotaExceededError NetworkError NotAllowedError NotFoundError InvalidStateError NotSupportedError SecurityError DataError "
        + "ConstraintError UnknownError TransactionInactiveError EncodingError VersionError ApiError ProviderConfigError UnsupportedImageError "
        + "BackupError ArchiveError ArchiveLimitError StreamIdleTimeoutError StreamReadError InvalidModificationError "
        + "HistoryMissingError HistoryUpgradeBlockedError "
        + "http stream network interrupted protocol no-space permission invalid-image quota invalid-file-id timeout json-format "
        + "context-limit output-limit unclassified endpoint-rejected provider-tools-configured sources-exhausted "
        + "deepseek freeseek anthropic openai responses gemini picker read validate write finalize chooser prepare browser-download "
        + "browser-open web-share open fetch headers body connect directory archive staged import export clear replace interrupted "
        + "pending streaming done stopped failed completed cancelled error success retry idle verifying downloading available "
        + "preparing installing end_turn length stop tool_use max_tokens stop_sequence content_filter refusal unknown "
        + "install save share ios android windows web direct github mirror cancelled unsupported accepted reused native-fallback "
        + "blocked dns redirect browser rate-limit empty md xlsx docx calculate table data "
        + "tool plan files verification search running awaiting-review working paused partial "
        + "budget-time budget-requests host-busy host-unavailable notification-permission system-timeout "
        + "tools-unavailable provider-error source-failed waiting-browser waiting-foreground criteria-unmet no-progress storage user "
        + "project script model3d project-patch-rejected project-archive-invalid project-script-error project-timeout "
        + "project-runtime-unavailable model-invalid artifact-save-failed "
        + "project-workspace-missing project-outdated external-denied external-failed delegate integration "
        + "replyContextTooLong replyOutputLimitInvalid backupEmptyHistory backupIncomplete backupUnrecognized backupStorageFull "
        + "backupOtherTabBusy backupJsonTooLarge backupNewerVersion providerFileUnsupported providerFileTooLarge "
        + "compressionFailed compressionFailedKey compressionFailedBalance compressionFailedRateLimit compressionFailedNetwork "
        + "compressionFailedSave compressionFailedPaused compressionFailedServer compressionFailedContext compressionFailedOutput "
        + "compressionFailedOutputParameter compressionFailedRefused compressionFailedIncomplete compressionFailedEmpty compressionFailedNoSavings");
    private static final Set<String> codeKeys = fields("name kind toolKind reason stage status stopReason protocol format action failureKey localKey source");
    private static final Set<String> correlationKeys = fields("requestId upstreamRequestId operationId replyId runId stepId");
    private static final Set<String> limitKeys = fields("contextLimitTokens requestedTokens outputLimitTokens");
    private static final Set<String> startupSources = fields("native database legacy");
    private static final Set<String> startupPages = fields("last-chat new-chat");
    private static final Set<String> historyReasons = fields("empty-after-known-history unreadable read-timeout checkpoint-timeout selection-uncertain");
    private static final Set<String> historyRepairStates = fields("both-empty consistent conflict one-store");
    private static final Pattern eventName = Pattern.compile("[a-z][a-z0-9.-]{0,89}");
    private static final Pattern id = Pattern.compile("(?i)(?:file-api-|custom-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-z]{8,10}-[0-9a-z]{1,20}");
    private static final Pattern frame = Pattern.compile("[\\w-]{1,64}\\.[a-f0-9]{8}\\.js:\\d{1,7}:\\d{1,7}");
    private static final Pattern version = Pattern.compile("\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}");
    private static boolean loaded;
    private static String readState = "empty";
    private static long evicted, expired, rejected, failedWrites;

    private RetainedClientLog() {}

    private static Set<String> fields(String list) {
        return new HashSet<>(Arrays.asList(list.split(" ")));
    }

    static void enqueue(Runnable action) { io.execute(action); }

    private static AtomicFile file(Context context) {
        File dir = new File(context.getNoBackupFilesDir(), "diagnostics");
        return new AtomicFile(new File(dir, "retained-client-events.json"));
    }

    private static String opaque(String value) {
        return value.length() <= 60 && id.matcher(value).matches() ? value : null;
    }

    private static boolean issueLevel(String value) { return "warn".equals(value) || "error".equals(value); }

    private static void copyEnum(JSONObject source, JSObject details, String key, Set<String> allowed) {
        Object value = source.opt(key);
        if (value instanceof String && allowed.contains(value)) details.put(key, (String) value);
    }

    private static JSONObject sanitize(JSONObject input, long now) {
        if (input == null) return null;
        String scope = input.optString("scope"), event = input.optString("event"), level = input.optString("level");
        String eventId = opaque(input.optString("id")), runId = opaque(input.optString("runId"));
        long timestamp = input.optLong("timestamp", -1);
        if (!scopes.contains(scope) || !eventName.matcher(event).matches() || eventId == null || runId == null ||
            timestamp <= now - RETENTION_MS || timestamp > now + 60_000L || (!"info".equals(level) && !issueLevel(level))) return null;
        JSObject details = new JSObject();
        JSONObject source = input.optJSONObject("details");
        if (source != null) {
            for (String key : measures) {
                Object value = source.opt(key);
                if (value instanceof Number && Double.isFinite(((Number) value).doubleValue())) {
                    details.put(key, ((Number) value).longValue());
                }
            }
            for (String key : flags) {
                Object value = source.opt(key);
                if (value instanceof Boolean) details.put(key, (Boolean) value);
            }
            for (String key : codeKeys) {
                String value = source.optString(key);
                if (codes.contains(value)) details.put(key, value);
            }
            if ("app".equals(scope) && "startup.chat-route".equals(event)) {
                copyEnum(source, details, "startupPreferenceSource", startupSources);
                copyEnum(source, details, "lastSelectionSource", startupSources);
                copyEnum(source, details, "startupPage", startupPages);
            }
            if ("storage".equals(scope) && event.startsWith("history.")) {
                copyEnum(source, details, "historyReason", historyReasons);
                if ("history.repaired".equals(event) || "history.retry-repaired".equals(event)) {
                    copyEnum(source, details, "state", historyRepairStates);
                }
            }
            for (String key : correlationKeys) {
                String value = opaque(source.optString(key));
                if (value != null) details.put(key, value);
            }
            String appVersion = source.optString("version");
            if (version.matcher(appVersion).matches()) details.put("version", appVersion);
            JSONObject limits = source.optJSONObject("limits");
            if (limits != null) {
                JSObject safeLimits = new JSObject();
                for (String key : limitKeys) {
                    Object value = limits.opt(key);
                    if (value instanceof Number && ((Number) value).longValue() > 0 && ((Number) value).longValue() <= 10_000_000) {
                        safeLimits.put(key, ((Number) value).longValue());
                    }
                }
                if (safeLimits.length() > 0) details.put("limits", safeLimits);
            }
            JSONArray frames = source.optJSONArray("frames");
            if (frames != null) {
                JSONArray safe = new JSONArray();
                for (int i = 0; i < Math.min(frames.length(), 4); i++) {
                    String value = frames.optString(i);
                    if (value.length() <= 110 && frame.matcher(value).matches()) safe.put(value);
                }
                if (safe.length() > 0) details.put("frames", safe);
            }
        }
        // Preserve the event and its scalar context even if a supplied stack is unusually long.
        if (details.toString().length() > 1350) details.remove("frames");
        return new JSObject().put("id", eventId).put("runId", runId).put("timestamp", timestamp)
            .put("source", "client").put("scope", scope).put("event", event).put("level", level).put("details", details);
    }

    private static boolean history(JSONObject entry) {
        String name = entry.optString("event"), scope = entry.optString("scope");
        return ("storage".equals(scope) && (name.startsWith("history.") || "sessions.loaded".equals(name))) ||
            ("backup".equals(scope) && (name.startsWith("history.") || name.startsWith("import."))) ||
            ("app".equals(scope) && "startup.chat-route".equals(name));
    }

    private static void prune(long now) {
        int oldCount = events.size();
        events.removeIf(entry -> entry.optLong("timestamp") <= now - RETENTION_MS);
        expired += oldCount - events.size();
        if (events.size() <= LIMIT) return;
        int historyCount = 0, issueCount = 0;
        for (JSONObject entry : events) {
            if (history(entry)) historyCount++;
            if (issueLevel(entry.optString("level"))) issueCount++;
        }
        Iterator<JSONObject> iterator = events.iterator();
        while (events.size() > LIMIT && iterator.hasNext()) {
            JSONObject entry = iterator.next();
            boolean history = history(entry), issue = issueLevel(entry.optString("level"));
            if ((history && historyCount <= HISTORY_RESERVE) || (issue && issueCount <= ISSUE_RESERVE)) continue;
            iterator.remove(); evicted++;
            if (history) historyCount--;
            if (issue) issueCount--;
        }
    }

    private static void load(Context context, long now) {
        if (loaded) return;
        loaded = true;
        try {
            AtomicFile stored = file(context);
            if (stored.getBaseFile().length() > MAX_FILE_BYTES) { readState = "size-limit"; return; }
            JSONObject payload = new JSONObject(new String(stored.readFully(), StandardCharsets.UTF_8));
            JSONArray rows = payload.getJSONArray("events");
            evicted = payload.optLong("evicted"); expired = payload.optLong("expired");
            rejected = payload.optLong("rejected"); failedWrites = payload.optLong("failedWrites");
            for (int i = Math.max(0, rows.length() - LIMIT); i < rows.length(); i++) {
                JSONObject raw = rows.optJSONObject(i);
                if (raw != null && raw.optLong("timestamp") <= now - RETENTION_MS) { expired++; continue; }
                JSONObject safe = sanitize(raw, now);
                if (safe != null) events.add(safe); else rejected++;
            }
            String savedState = payload.optString("readState");
            readState = "unreadable".equals(savedState) || "size-limit".equals(savedState) ? savedState : "available";
        } catch (FileNotFoundException ignored) {
            // The first run has no native record yet.
        } catch (Exception ignored) {
            readState = "unreadable";
        }
    }

    static synchronized void append(Context context, JSONArray batch) throws IOException {
        long now = System.currentTimeMillis();
        load(context, now);
        Set<String> ids = new HashSet<>();
        for (JSONObject entry : events) ids.add(entry.optString("id"));
        for (int i = 0; i < batch.length(); i++) {
            JSONObject entry = sanitize(batch.optJSONObject(i), now);
            if (entry == null) { rejected++; continue; }
            if (ids.add(entry.optString("id"))) events.add(entry);
        }
        prune(now);
        AtomicFile target = file(context);
        FileOutputStream out = null;
        try {
            byte[] bytes = snapshotFields().toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_FILE_BYTES) throw new IOException("Diagnostic record capacity exceeded");
            out = target.startWrite();
            out.write(bytes);
            target.finishWrite(out);
            if ("empty".equals(readState)) readState = "available";
        } catch (IOException error) {
            failedWrites += batch.length();
            if (out != null) target.failWrite(out);
            throw error;
        }
    }

    private static JSObject snapshotFields() {
        return new JSObject().put("events", new JSONArray(events)).put("limit", LIMIT)
            .put("historyReserve", HISTORY_RESERVE).put("issueReserve", ISSUE_RESERVE).put("readState", readState)
            .put("failedWrites", failedWrites).put("evicted", evicted).put("expired", expired).put("rejected", rejected);
    }

    static synchronized JSObject snapshot(Context context) {
        long now = System.currentTimeMillis();
        load(context, now);
        prune(now);
        return snapshotFields();
    }
}
