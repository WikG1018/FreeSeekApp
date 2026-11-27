package app.freeseek.chat;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.JsonReader;
import android.util.JsonToken;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/** Private history generations. Call from the vault's single serial executor. */
final class HistoryVault implements AutoCloseable {
    private static final int SCHEMA = 1;
    private static final int MAX_VERIFIED_SESSIONS = 256;
    static final int MAX_PAGE = 128;
    static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    static final class Fault extends IOException {
        final String code;
        Fault(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    static final class Status {
        final long generation, verifiedAt, sessions, originals, missingOriginals, bytes;
        final String pendingId;

        Status(long generation, long verifiedAt, long sessions, long originals,
               long missingOriginals, long bytes, String pendingId) {
            this.generation = generation;
            this.verifiedAt = verifiedAt;
            this.sessions = sessions;
            this.originals = originals;
            this.missingOriginals = missingOriginals;
            this.bytes = bytes;
            this.pendingId = pendingId;
        }
    }

    static final class Item {
        final String id, sha256, type, revision;
        final long size;

        Item(String id, String sha256, long size, String type, String revision) {
            this.id = id;
            this.sha256 = sha256;
            this.size = size;
            this.type = type;
            this.revision = revision;
        }
    }

    static final class Page {
        final List<Item> items;
        final String next;
        Page(List<Item> items, String next) {
            this.items = items;
            this.next = next;
        }
    }

    static final class Chunk {
        final byte[] data;
        final long nextOffset;
        final boolean eof;
        Chunk(byte[] data, long nextOffset, boolean eof) {
            this.data = data;
            this.nextOffset = nextOffset;
            this.eof = eof;
        }
    }

    private static final class Entry {
        final String id, revision, mediaType, expectedDigest;
        final long size;
        final List<String> originals, missing;
        final HistoryVaultObjects.Write writer;

        Entry(String id, String revision, String mediaType, long size, String expectedDigest,
              List<String> originals, List<String> missing, HistoryVaultObjects.Write writer) {
            this.id = id;
            this.revision = revision;
            this.mediaType = mediaType;
            this.size = size;
            this.expectedDigest = expectedDigest;
            this.originals = originals;
            this.missing = missing;
            this.writer = writer;
        }

        boolean isSession() { return mediaType == null; }
    }

    private static final class Batch {
        final String id;
        final boolean replacing;
        final Object owner;
        Entry entry;
        boolean prepared;
        boolean failed;

        Batch(String id, boolean replacing, Object owner, boolean prepared) {
            this.id = id;
            this.replacing = replacing;
            this.owner = owner;
            this.prepared = prepared;
        }
    }

    @FunctionalInterface
    private interface SqlChange { void run(); }

    private final SQLiteDatabase db;
    private final HistoryVaultObjects objects;
    private final Consumer<Exception> cleanupFailed;
    private final Map<String, Boolean> verifiedSessions =
        new LinkedHashMap<String, Boolean>(16, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> entry) {
                return size() > MAX_VERIFIED_SESSIONS;
            }
        };
    private Batch active;

    HistoryVault(File directory, Consumer<Exception> cleanupFailed) throws IOException {
        this.cleanupFailed = cleanupFailed;
        objects = new HistoryVaultObjects(directory, HistoryVault::syncDirectory, HistoryVault::replaceObject);
        File database = new File(directory, "history.sqlite");
        // Corruption must be reported. Android's default corruption handler deletes the database.
        db = SQLiteDatabase.openDatabase(
            database.getAbsolutePath(), null, SQLiteDatabase.CREATE_IF_NECESSARY, ignored -> { }
        );
        try {
            db.disableWriteAheadLogging();
            try (Cursor journal = db.rawQuery("PRAGMA journal_mode=DELETE", null)) {
                if (!journal.moveToFirst() || !"delete".equalsIgnoreCase(journal.getString(0))) {
                    throw new IOException("Could not enable durable history journal");
                }
            }
            db.execSQL("PRAGMA synchronous=EXTRA");
            if (scalar("PRAGMA synchronous", null) != 3) {
                throw new IOException("Could not enable durable history transactions");
            }
            int version = db.getVersion();
            if (version == 0) createSchema();
            else if (version != SCHEMA) throw new Fault("UNREADABLE", "Unknown private history format");
            syncDirectory(directory);
            recoverInterruptedBatch();
        } catch (IOException | RuntimeException failure) {
            db.close();
            throw failure;
        }
    }

    private void createSchema() {
        transaction(() -> {
            db.execSQL("CREATE TABLE vault_state (key INTEGER PRIMARY KEY CHECK(key=1), generation INTEGER NOT NULL,"
                + " verified_at INTEGER NOT NULL, pending_id TEXT, pending_mode TEXT, last_commit_id TEXT)");
            db.execSQL("INSERT INTO vault_state (key,generation,verified_at) VALUES (1,0,0)");
            db.execSQL("CREATE TABLE sessions (id TEXT NOT NULL PRIMARY KEY, sha TEXT NOT NULL,"
                + " size INTEGER NOT NULL, revision TEXT NOT NULL)");
            db.execSQL("CREATE TABLE originals (id TEXT NOT NULL PRIMARY KEY, sha TEXT NOT NULL,"
                + " size INTEGER NOT NULL, type TEXT NOT NULL, source_revision TEXT)");
            db.execSQL("CREATE TABLE refs (session_id TEXT NOT NULL, original_id TEXT NOT NULL,"
                + " missing INTEGER NOT NULL, PRIMARY KEY (session_id, original_id))");
            db.execSQL("CREATE INDEX vault_ref_original ON refs(original_id)");
            db.execSQL("CREATE INDEX vault_session_sha ON sessions(sha)");
            db.execSQL("CREATE INDEX vault_original_sha ON originals(sha)");
            db.execSQL("CREATE TABLE pending_sessions (id TEXT NOT NULL PRIMARY KEY, sha TEXT,"
                + " size INTEGER, revision TEXT, removed INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE pending_originals (id TEXT NOT NULL PRIMARY KEY, sha TEXT NOT NULL,"
                + " size INTEGER NOT NULL, type TEXT NOT NULL, source_revision TEXT)");
            db.execSQL("CREATE TABLE pending_refs (session_id TEXT NOT NULL, original_id TEXT NOT NULL,"
                + " missing INTEGER NOT NULL, PRIMARY KEY (session_id, original_id))");
            db.execSQL("CREATE TABLE retired (sha TEXT NOT NULL PRIMARY KEY)");
            db.setVersion(SCHEMA);
        });
    }

    private void recoverInterruptedBatch() {
        try (Cursor row = db.rawQuery("SELECT pending_id,pending_mode FROM vault_state WHERE key=1", null)) {
            if (!row.moveToFirst()) throw new IllegalStateException("History state is missing");
            String pending = row.getString(0);
            if (pending != null) {
                active = new Batch(pending, "replace".equals(row.getString(1)), null, true);
            }
        }
        if (active == null) transaction(this::clearStagingRows);
        try {
            objects.discardStaging();
            objects.collectOrphans(this::retainedOnDisk);
        } catch (IOException | RuntimeException failure) {
            cleanupFailed.accept(failure);
        }
        if (active == null) collectRetired();
    }

    Status status() {
        String query = "SELECT generation,verified_at,pending_id,"
            + " (SELECT COUNT(*) FROM sessions),"
            + " (SELECT COUNT(*) FROM originals),"
            + " (SELECT COUNT(DISTINCT original_id) FROM refs WHERE missing=1"
            + " AND NOT EXISTS(SELECT 1 FROM originals WHERE id=refs.original_id)),"
            + " (SELECT COALESCE(SUM(size),0) FROM"
            + " (SELECT sha,size FROM sessions UNION SELECT sha,size FROM originals))"
            + " FROM vault_state WHERE key=1";
        try (Cursor row = db.rawQuery(query, null)) {
            if (!row.moveToFirst()) throw new IllegalStateException("History state is missing");
            return new Status(row.getLong(0), row.getLong(1), row.getLong(3), row.getLong(4),
                row.getLong(5), row.getLong(6), row.getString(2));
        }
    }

    String begin(String mode, Long generation, Object owner) throws IOException {
        if (active != null) throw new Fault("BUSY", "A history batch is already open");
        if (!"merge".equals(mode) && !"replace".equals(mode)) throw new IllegalArgumentException("Invalid history batch mode");
        if (generation != null) checkGeneration(generation);
        active = new Batch(UUID.randomUUID().toString(), "replace".equals(mode), owner, false);
        return active.id;
    }

    void putSession(String batchId, String sessionId, long size, String revision,
                    List<String> originalIds, List<String> missingIds) throws IOException {
        Batch batch = writable(batchId);
        requireIdleEntry(batch);
        try {
            validateId(sessionId);
            validateRevision(revision);
            if (size < 2 || size > MAX_SAFE_INTEGER) throw new IllegalArgumentException("Invalid session length");
            List<String> present = validatedIds(originalIds);
            List<String> missing = validatedIds(missingIds);
            Set<String> overlap = new LinkedHashSet<>(present);
            overlap.retainAll(missing);
            if (!overlap.isEmpty()) throw new IllegalArgumentException("History original cannot be both present and missing");
            batch.entry = new Entry(sessionId, revision, null, size, null, present, missing, objects.open(size));
        } catch (IOException | RuntimeException failure) {
            batch.failed = true;
            throw failure;
        }
    }

    boolean putOriginal(String batchId, String fileId, long size, String mediaType,
                        String sourceRevision, File source, String expectedDigest, boolean verifyExisting) throws IOException {
        Batch batch = writable(batchId);
        requireIdleEntry(batch);
        try {
            validateId(fileId);
            if (sourceRevision != null) validateRevision(sourceRevision);
            if (size < 0 || size > MAX_SAFE_INTEGER || mediaType == null || mediaType.length() > 255
                || hasControl(mediaType) || (expectedDigest != null && !HistoryVaultObjects.validDigest(expectedDigest))) {
                throw new IllegalArgumentException("Invalid original metadata");
            }
            Item saved = findOriginal("pending_originals", fileId);
            if (saved == null) saved = findOriginal("originals", fileId);
            boolean unchangedSource = saved != null && sourceRevision != null && sourceRevision.equals(saved.revision);
            if (unchangedSource) {
                if (size != saved.size || (expectedDigest != null && !expectedDigest.equals(saved.sha256))) {
                    throw new Fault("CHANGED", "The original does not match its saved revision");
                }
                // A verified revision fixes the expected bytes, even if both on-device copies have since failed.
                expectedDigest = saved.sha256;
            }
            if (unchangedSource && mediaType.equals(saved.type)
                && objects.contains(saved.sha256, size, verifyExisting)) {
                stageOriginal(new Item(fileId, saved.sha256, size, mediaType, sourceRevision));
                return false;
            }
            if (source != null) {
                String digest = objects.copyFrom(source, size, expectedDigest);
                stageOriginal(new Item(fileId, digest, size, mediaType, sourceRevision));
                return false;
            }
            if (expectedDigest != null && objects.contains(expectedDigest, size, true)) {
                stageOriginal(new Item(fileId, expectedDigest, size, mediaType, sourceRevision));
                return false;
            }
            batch.entry = new Entry(fileId, sourceRevision, mediaType, size, expectedDigest,
                null, null, objects.open(size));
            return true;
        } catch (IOException | RuntimeException failure) {
            batch.failed = true;
            throw failure;
        }
    }

    private void stageOriginal(Item item) {
        transaction(() -> {
            retire(item.sha256);
            db.execSQL("INSERT OR REPLACE INTO pending_originals (id,sha,size,type,source_revision) VALUES (?,?,?,?,?)",
                new Object[]{item.id, item.sha256, item.size, item.type, item.revision});
        });
    }

    void append(String id, byte[] bytes) throws IOException {
        Batch batch = writable(id);
        Entry entry = requireOpenEntry(batch);
        try {
            if (bytes.length > HistoryVaultObjects.CHUNK_BYTES) throw new IllegalArgumentException("History chunk too large");
            entry.writer.append(bytes, bytes.length);
        } catch (IOException | RuntimeException failure) {
            batch.failed = true;
            entry.writer.close();
            batch.entry = null;
            throw failure;
        }
    }

    String finishEntry(String id) throws IOException {
        Batch batch = writable(id);
        Entry entry = requireOpenEntry(batch);
        batch.entry = null;
        try {
            HistoryVaultObjects.Validator validator = entry.isSession()
                ? file -> validateSessionJson(file, entry.id) : null;
            String digest = objects.install(entry.writer, entry.expectedDigest, validator);
            if (entry.isSession()) stageSession(entry, digest);
            else stageOriginal(new Item(entry.id, digest, entry.size, entry.mediaType, entry.revision));
            return digest;
        } catch (IOException | RuntimeException failure) {
            batch.failed = true;
            throw failure;
        }
    }

    private void stageSession(Entry entry, String digest) {
        transaction(() -> {
            retire(digest);
            db.execSQL("INSERT OR REPLACE INTO pending_sessions (id,sha,size,revision,removed) VALUES (?,?,?,?,0)",
                new Object[]{entry.id, digest, entry.size, entry.revision});
            db.execSQL("DELETE FROM pending_refs WHERE session_id=?", new Object[]{entry.id});
            stageReferences(entry.id, entry.originals, 0);
            stageReferences(entry.id, entry.missing, 1);
        });
    }

    private void stageReferences(String sessionId, List<String> originals, int missing) {
        try (android.database.sqlite.SQLiteStatement statement = db.compileStatement(
            "INSERT INTO pending_refs (session_id,original_id,missing) VALUES (?,?,?)"
        )) {
            statement.bindString(1, sessionId);
            statement.bindLong(3, missing);
            for (String original : originals) {
                statement.bindString(2, original);
                statement.executeInsert();
            }
        }
    }

    void deleteSession(String id, String sessionId) throws IOException {
        Batch batch = writable(id);
        requireIdleEntry(batch);
        try {
            validateId(sessionId);
            transaction(() -> {
                db.execSQL("INSERT OR REPLACE INTO pending_sessions (id,removed) VALUES (?,1)", new Object[]{sessionId});
                db.execSQL("DELETE FROM pending_refs WHERE session_id=?", new Object[]{sessionId});
            });
        } catch (RuntimeException failure) {
            batch.failed = true;
            throw failure;
        }
    }

    Status prepare(String id) throws IOException {
        Batch batch = requireBatch(id);
        requireReady(batch);
        if (!batch.prepared) {
            validateCandidate(batch);
            transaction(() -> db.execSQL("UPDATE vault_state SET pending_id=?,pending_mode=? WHERE key=1",
                new Object[]{id, batch.replacing ? "replace" : "merge"}));
            batch.prepared = true;
        }
        return status();
    }

    Status commit(String id) throws IOException {
        if (id != null && id.equals(lastCommitId())) {
            if (active != null && active.id.equals(id)) {
                active = null;
                verifiedSessions.clear();
                collectRetired();
            }
            return status();
        }
        Batch batch = requireBatch(id);
        requireReady(batch);
        validateCandidate(batch);
        long next = generation() + 1;
        if (next > MAX_SAFE_INTEGER) throw new Fault("IO", "History generation cannot advance");
        long verifiedAt = System.currentTimeMillis();
        transaction(() -> {
            if (batch.replacing) {
                db.execSQL("INSERT OR IGNORE INTO retired SELECT sha FROM sessions");
                db.execSQL("INSERT OR IGNORE INTO retired SELECT sha FROM originals");
                db.execSQL("DELETE FROM refs");
                db.execSQL("DELETE FROM sessions");
                db.execSQL("DELETE FROM originals");
            } else {
                db.execSQL("INSERT OR IGNORE INTO retired SELECT sha FROM sessions WHERE id IN (SELECT id FROM pending_sessions)");
                db.execSQL("INSERT OR IGNORE INTO retired SELECT sha FROM originals WHERE id IN (SELECT id FROM pending_originals)");
                db.execSQL("DELETE FROM refs WHERE session_id IN (SELECT id FROM pending_sessions)");
                db.execSQL("DELETE FROM sessions WHERE id IN (SELECT id FROM pending_sessions)");
            }
            db.execSQL("INSERT INTO sessions SELECT id,sha,size,revision FROM pending_sessions WHERE removed=0");
            db.execSQL("INSERT OR REPLACE INTO originals SELECT id,sha,size,type,source_revision FROM pending_originals");
            db.execSQL("INSERT INTO refs SELECT session_id,original_id,missing FROM pending_refs");
            String unreferenced = " WHERE NOT EXISTS (SELECT 1 FROM refs WHERE original_id=originals.id)";
            db.execSQL("INSERT OR IGNORE INTO retired SELECT sha FROM originals" + unreferenced);
            db.execSQL("DELETE FROM originals" + unreferenced);
            db.execSQL("UPDATE vault_state SET generation=?,verified_at=?,pending_id=NULL,pending_mode=NULL,last_commit_id=? WHERE key=1",
                new Object[]{next, verifiedAt, id});
            clearStagingRows();
        });
        active = null;
        verifiedSessions.clear();
        collectRetired();
        return status();
    }

    void cancel(String id) throws IOException {
        if (active == null) return;
        Batch batch = requireBatch(id);
        if (batch.entry != null) {
            batch.entry.writer.close();
            batch.entry = null;
        }
        transaction(() -> {
            clearStagingRows();
            db.execSQL("UPDATE vault_state SET pending_id=NULL,pending_mode=NULL WHERE key=1");
        });
        active = null;
        collectRetired();
    }

    void abandon(Object owner) throws IOException {
        if (active != null && !active.prepared && active.owner == owner) cancel(active.id);
    }

    Page list(boolean session, long generation, String after, int limit) throws IOException {
        checkGeneration(generation);
        if (after != null) validateId(after);
        if (limit < 1 || limit > MAX_PAGE) throw new IllegalArgumentException("Invalid history page size");
        String table = session ? "sessions" : "originals";
        String columns = session ? "id,sha,size,NULL,revision" : "id,sha,size,type,source_revision";
        String sql = "SELECT " + columns + " FROM " + table
            + (after == null ? "" : " WHERE id>?") + " ORDER BY id LIMIT ?";
        String count = Integer.toString(limit + 1);
        String[] args = after == null ? new String[]{count} : new String[]{after, count};
        List<Item> items = new ArrayList<>(limit);
        String next = null;
        try (Cursor cursor = db.rawQuery(sql, args)) {
            while (cursor.moveToNext()) {
                if (items.size() == limit) {
                    next = items.get(limit - 1).id;
                    break;
                }
                items.add(item(cursor));
            }
        }
        return new Page(items, next);
    }

    Chunk readSession(long generation, String sessionId, long offset, int limit) throws IOException {
        checkGeneration(generation);
        validateId(sessionId);
        Item saved = findItem("SELECT id,sha,size,NULL,revision FROM sessions WHERE id=?", sessionId);
        if (saved == null) throw new Fault("UNREADABLE", "The saved conversation is unavailable");
        if (verifiedSessions.get(saved.sha256) == null) {
            objects.verifyAvailable(saved.sha256, saved.size);
            verifiedSessions.put(saved.sha256, true);
        }
        byte[] bytes = objects.read(saved.sha256, saved.size, offset, limit);
        return new Chunk(bytes, offset + bytes.length, offset + bytes.length == saved.size);
    }

    Item restoreOriginal(long generation, String originalId, File destination) throws IOException {
        checkGeneration(generation);
        validateId(originalId);
        Item saved = findOriginal("originals", originalId);
        if (saved == null) throw new Fault("UNREADABLE", "The saved original is unavailable");
        objects.restore(saved.sha256, saved.size, destination);
        return saved;
    }

    private void validateCandidate(Batch batch) throws IOException {
        String refs = "SELECT original_id FROM pending_refs WHERE missing=0";
        String originals = "SELECT id FROM pending_originals";
        if (!batch.replacing) {
            refs += " UNION ALL SELECT original_id FROM refs WHERE missing=0"
                + " AND NOT EXISTS(SELECT 1 FROM pending_sessions WHERE id=refs.session_id)";
            originals += " UNION ALL SELECT id FROM originals";
        }
        String query = "SELECT EXISTS(SELECT original_id FROM (" + refs + ") EXCEPT SELECT id FROM (" + originals + "))";
        if (scalar(query, null) != 0) throw new Fault("UNREADABLE", "The next history generation is missing an original");
        try (Cursor files = db.rawQuery(
            "SELECT sha,size FROM pending_sessions WHERE removed=0 UNION SELECT sha,size FROM pending_originals", null
        )) {
            while (files.moveToNext()) objects.requireAvailable(files.getString(0), files.getLong(1));
        }
    }

    private Item findOriginal(String table, String id) {
        return findItem("SELECT id,sha,size,type,source_revision FROM " + table + " WHERE id=?", id);
    }

    private Item findItem(String sql, String id) {
        try (Cursor row = db.rawQuery(sql, new String[]{id})) {
            return row.moveToFirst() ? item(row) : null;
        }
    }

    private static Item item(Cursor row) {
        return new Item(row.getString(0), row.getString(1), row.getLong(2), row.getString(3), row.getString(4));
    }

    private String lastCommitId() {
        try (Cursor cursor = db.rawQuery("SELECT last_commit_id FROM vault_state WHERE key=1", null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    private long generation() { return scalar("SELECT generation FROM vault_state WHERE key=1", null); }

    private void checkGeneration(long expected) throws IOException {
        if (generation() != expected) throw new Fault("CHANGED", "The saved history generation has changed");
    }

    private Batch requireBatch(String id) throws IOException {
        if (active == null || !active.id.equals(id)) throw new Fault("CHANGED", "The history batch is no longer current");
        return active;
    }

    private Batch writable(String id) throws IOException {
        Batch batch = requireBatch(id);
        if (batch.prepared || batch.failed) throw new Fault("CHANGED", "The history batch is no longer writable");
        return batch;
    }

    private static void requireIdleEntry(Batch batch) throws IOException {
        if (batch.entry != null) throw new Fault("BUSY", "The preceding history object is unfinished");
    }

    private static void requireReady(Batch batch) throws IOException {
        requireIdleEntry(batch);
        if (batch.failed) throw new Fault("UNREADABLE", "A history object failed to write");
    }

    private static Entry requireOpenEntry(Batch batch) throws IOException {
        if (batch.entry == null) throw new Fault("CHANGED", "No history object is open");
        return batch.entry;
    }

    private void transaction(SqlChange change) {
        db.beginTransaction();
        try {
            change.run();
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private long scalar(String sql, String[] args) {
        try (Cursor result = db.rawQuery(sql, args)) {
            if (!result.moveToFirst()) throw new IllegalStateException("Missing history result");
            return result.getLong(0);
        }
    }

    private void clearStagingRows() {
        db.execSQL("DELETE FROM pending_refs");
        db.execSQL("DELETE FROM pending_sessions");
        db.execSQL("DELETE FROM pending_originals");
    }

    private void retire(String sha) {
        db.execSQL("INSERT OR IGNORE INTO retired (sha) VALUES (?)", new Object[]{sha});
    }

    private static final String LIVE_DIGEST =
        "EXISTS(SELECT 1 FROM sessions WHERE sha=retired.sha) OR EXISTS(SELECT 1 FROM originals WHERE sha=retired.sha)";

    private void collectRetired() {
        try {
            db.execSQL("DELETE FROM retired WHERE " + LIVE_DIGEST);
            String after = "";
            for (;;) {
                List<String> slice = new ArrayList<>(MAX_PAGE);
                try (Cursor rows = db.rawQuery("SELECT sha FROM retired WHERE sha>? ORDER BY sha LIMIT " + MAX_PAGE,
                    new String[]{after})) {
                    while (rows.moveToNext()) slice.add(rows.getString(0));
                }
                if (slice.isEmpty()) return;
                for (String digest : slice) {
                    try {
                        objects.remove(digest);
                        db.execSQL("DELETE FROM retired WHERE sha=?", new Object[]{digest});
                    } catch (IOException failure) {
                        cleanupFailed.accept(failure);
                    }
                }
                after = slice.get(slice.size() - 1);
            }
        } catch (RuntimeException failure) {
            cleanupFailed.accept(failure);
        }
    }

    private boolean retainedOnDisk(String digest) {
        return scalar("SELECT EXISTS(SELECT sha FROM sessions WHERE sha=?"
            + " UNION ALL SELECT sha FROM originals WHERE sha=?"
            + " UNION ALL SELECT sha FROM pending_sessions WHERE sha=?"
            + " UNION ALL SELECT sha FROM pending_originals WHERE sha=?)",
            new String[]{digest, digest, digest, digest}) != 0;
    }

    private static List<String> validatedIds(List<String> ids) {
        Set<String> unique = new LinkedHashSet<>();
        for (String id : ids) {
            validateId(id);
            unique.add(id);
        }
        return new ArrayList<>(unique);
    }

    static void validateId(String id) {
        if (id == null || id.isEmpty() || id.length() > 512 || hasControl(id)) {
            throw new IllegalArgumentException("Invalid history object ID");
        }
    }

    private static void validateRevision(String revision) {
        if (revision == null || revision.isEmpty() || revision.length() > 512 || hasControl(revision)) {
            throw new IllegalArgumentException("Invalid history object's revision");
        }
    }

    private static boolean hasControl(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return true;
        }
        return false;
    }

    private static void validateSessionJson(File file, String expectedId) throws IOException {
        try (JsonReader json = new JsonReader(new InputStreamReader(new FileInputStream(file),
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)))) {
            json.setLenient(false);
            json.beginObject();
            String id = null;
            while (json.hasNext()) {
                if ("id".equals(json.nextName())) {
                    if (id != null || json.peek() != JsonToken.STRING) throw new IOException("Invalid saved conversation ID");
                    id = json.nextString();
                } else {
                    json.skipValue();
                }
            }
            json.endObject();
            if (!expectedId.equals(id) || json.peek() != JsonToken.END_DOCUMENT) {
                throw new IOException("Invalid saved conversation snapshot");
            }
        } catch (IOException | IllegalStateException failure) {
            throw new Fault("UNREADABLE", "Invalid UTF-8 history conversation snapshot");
        }
    }

    private static void syncDirectory(File directory) throws IOException {
        FileDescriptor fd = null;
        try {
            fd = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            if (!OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) throw new IOException("History path is not a directory");
            Os.fsync(fd);
        } catch (ErrnoException failure) {
            throw new IOException("Could not synchronize private history directory", failure);
        } finally {
            if (fd != null) {
                try { Os.close(fd); } catch (ErrnoException ignored) { }
            }
        }
    }

    private static void replaceObject(File source, File target) throws IOException {
        try {
            Os.rename(source.getAbsolutePath(), target.getAbsolutePath());
        } catch (ErrnoException failure) {
            throw new IOException("Could not install verified history object", failure);
        }
    }

    @Override public void close() {
        if (active != null && active.entry != null) active.entry.writer.close();
        db.close();
    }
}
