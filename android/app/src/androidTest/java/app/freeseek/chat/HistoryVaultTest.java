package app.freeseek.chat;

import static org.junit.Assert.*;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class HistoryVaultTest {
    private static final String BINARY = "application/octet-stream";
    private static final List<String> NONE = Collections.emptyList();
    private File sandbox, root;
    private HistoryVault store;
    private final List<Exception> cleanupErrors = new ArrayList<>();

    @Before public void setUp() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        sandbox = new File(context.getNoBackupFilesDir(), "vault-test-" + UUID.randomUUID());
        assertTrue(sandbox.mkdir());
        root = new File(sandbox, "vault");
        open();
    }

    @After public void tearDown() {
        if (store != null) store.close();
        if (sandbox != null) removeTestTree(sandbox);
    }

    private static void removeTestTree(File path) {
        File[] children = path.listFiles();
        if (children != null) for (File child : children) removeTestTree(child);
        path.delete();
    }

    private void open() throws IOException { store = new HistoryVault(root, cleanupErrors::add); }

    private void restart() throws IOException {
        store.close();
        store = null;
        open();
    }

    private static List<String> ids(String... values) { return Arrays.asList(values); }

    private String addSession(String batch, String id, String revision, List<String> present, List<String> missing)
        throws IOException {
        byte[] bytes = ("{\"id\":\"" + id + "\",\"messages\":[{\"content\":\"旧内容与附件 ☀\"}]}")
            .getBytes(StandardCharsets.UTF_8);
        store.putSession(batch, id, bytes.length, revision, present, missing);
        for (int offset = 0; offset < bytes.length; offset += 7) {
            store.append(batch, Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 7)));
        }
        return store.finishEntry(batch);
    }

    private String addOriginal(String batch, String id, String revision, byte[] bytes) throws IOException {
        assertTrue(store.putOriginal(batch, id, bytes.length, BINARY, revision, null, null, false));
        if (bytes.length != 0) store.append(batch, bytes);
        return store.finishEntry(batch);
    }

    private File source(String name, byte[] bytes) throws IOException {
        File source = new File(sandbox, name);
        try (FileOutputStream output = new FileOutputStream(source)) { output.write(bytes); }
        return source;
    }

    private static byte[] readBytes(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[64];
            for (int count; (count = input.read(bytes)) != -1;) output.write(bytes, 0, count);
            return output.toByteArray();
        }
    }

    private File stored(String digest) {
        return new File(new File(new File(root, "objects"), digest.substring(0, 2)), digest.substring(2));
    }

    @Test public void deduplicatesOriginalsAndAppliesSameSizeReplacementToSharedReferences() throws Exception {
        assertEquals(0, store.status().generation);
        assertEquals(0, store.status().verifiedAt);
        byte[] old = new byte[]{1, 2, 3, 4};
        byte[] replacement = new byte[]{9, 8, 7, 6};
        String batch = store.begin("merge", 0L, this);
        String oldDigest = addOriginal(batch, "shared", "original-r1", old);
        assertFalse(store.putOriginal(batch, "same-content", old.length, BINARY, "copy-r1", source("old.bin", old), null, false));
        addSession(batch, "chat-a", "session-r1", ids("shared"), ids("unavailable"));
        addSession(batch, "chat-b", "session-r2", ids("shared", "same-content"), ids("unavailable"));
        HistoryVault.Status first = store.commit(batch);
        assertEquals(1, first.generation);
        assertTrue(first.verifiedAt > 0);
        assertEquals(2, first.sessions);
        assertEquals(2, first.originals);
        assertEquals(1, first.missingOriginals);
        List<HistoryVault.Item> originals = store.list(false, 1, null, 2).items;
        assertEquals(oldDigest, originals.get(0).sha256);
        assertEquals(oldDigest, originals.get(1).sha256);
        assertTrue(stored(oldDigest).isFile());

        HistoryVault.Page firstPage = store.list(true, 1, null, 1);
        assertEquals("chat-a", firstPage.items.get(0).id);
        assertEquals("session-r1", firstPage.items.get(0).revision);
        assertEquals("chat-a", firstPage.next);
        HistoryVault.Page secondPage = store.list(true, 1, firstPage.next, 1);
        assertEquals("chat-b", secondPage.items.get(0).id);
        assertNull(secondPage.next);
        ByteArrayOutputStream conversation = new ByteArrayOutputStream();
        HistoryVault.Chunk chunk;
        long offset = 0;
        do {
            chunk = store.readSession(1, "chat-a", offset, 7);
            conversation.write(chunk.data);
            offset = chunk.nextOffset;
        } while (!chunk.eof);
        assertTrue(conversation.toString("UTF-8").contains("旧内容与附件 ☀"));

        batch = store.begin("merge", 1L, this);
        assertFalse(store.putOriginal(batch, "shared", old.length, BINARY, "original-r1", null, null, false));
        assertFalse(store.putOriginal(batch, "shared", replacement.length, BINARY, "original-r2", source("new.bin", replacement), null, false));
        assertEquals(batch, store.prepare(batch).pendingId);
        assertEquals(1, store.status().generation);
        File oldRestored = new File(sandbox, "old-restored");
        store.restoreOriginal(1, "shared", oldRestored);
        assertArrayEquals(old, readBytes(oldRestored));
        restart();
        assertEquals(batch, store.status().pendingId);
        assertEquals(2, store.commit(batch).generation);
        assertEquals(2, store.commit(batch).generation);
        assertNull(store.status().pendingId);
        File newRestored = new File(sandbox, "new-restored");
        store.restoreOriginal(2, "shared", newRestored);
        assertArrayEquals(replacement, readBytes(newRestored));
        assertTrue("The second file ID keeps the old content live", stored(oldDigest).isFile());
        assertEquals("CHANGED", assertThrows(HistoryVault.Fault.class, () -> store.list(true, 1, null, 1)).code);

        batch = store.begin("merge", 2L, this);
        store.deleteSession(batch, "chat-a");
        store.prepare(batch);
        restart();
        assertEquals(1, store.commit(batch).sessions);
        assertEquals(2, store.status().originals);
        File copy = new File(sandbox, "copy-restored");
        store.restoreOriginal(3, "same-content", copy);
        assertArrayEquals(old, readBytes(copy));
        batch = store.begin("merge", 3L, this);
        store.deleteSession(batch, "chat-b");
        assertEquals(0, store.commit(batch).originals);
        assertFalse("No references remain", stored(oldDigest).exists());
        assertEquals(0, store.status().missingOriginals);
        assertTrue(cleanupErrors.isEmpty());
    }

    @Test public void unpreparedWorkRollsBackAndPreparedClearStaysEmptyAfterRestart() throws Exception {
        String batch = store.begin("merge", 0L, this);
        addSession(batch, "old-chat", "first", NONE, NONE);
        assertEquals(1, store.commit(batch).generation);

        batch = store.begin("replace", 1L, this);
        String interrupted = addSession(batch, "interrupted", "second", NONE, NONE);
        assertTrue(stored(interrupted).exists());
        restart();
        assertNull(store.status().pendingId);
        assertFalse(stored(interrupted).exists());
        assertEquals("old-chat", store.list(true, 1, null, 4).items.get(0).id);

        batch = store.begin("replace", 1L, this);
        store.prepare(batch);
        restart();
        assertEquals(batch, store.status().pendingId);
        assertEquals(1, store.status().sessions);
        store.cancel(batch);
        restart();
        assertNull(store.status().pendingId);
        assertEquals(1, store.status().generation);
        assertEquals(1, store.status().sessions);

        batch = store.begin("replace", 1L, this);
        store.prepare(batch);
        restart();
        assertEquals(2, store.commit(batch).generation);
        restart();
        assertEquals(2, store.status().generation);
        assertTrue(store.list(true, 2, null, 4).items.isEmpty());
        assertEquals(0, store.status().originals);
        assertNull(store.status().pendingId);
        assertTrue(cleanupErrors.isEmpty());
    }

    @Test public void badWritesAndFailedSqlCommitLeavePreviousGeneration() throws Exception {
        String good = store.begin("merge", 0L, this);
        addSession(good, "saved-chat", "saved", NONE, NONE);
        store.commit(good);
        String tooLarge = store.begin("merge", 1L, this);
        assertThrows(HistoryVaultObjects.NoSpace.class,
            () -> store.putOriginal(tooLarge, "overflow", HistoryVault.MAX_SAFE_INTEGER, BINARY, "r1", null, null, false));
        assertEquals("UNREADABLE", assertThrows(HistoryVault.Fault.class, () -> store.commit(tooLarge)).code);
        store.cancel(tooLarge);

        String missing = store.begin("replace", 1L, this);
        addSession(missing, "unverified", "new", ids("absent-copy"), NONE);
        assertEquals("UNREADABLE", assertThrows(HistoryVault.Fault.class, () -> store.prepare(missing)).code);
        assertNull(store.status().pendingId);
        store.cancel(missing);
        assertEquals(1, store.status().generation);

        String incomplete = store.begin("merge", 1L, this);
        assertTrue(store.putOriginal(incomplete, "incomplete", 4, BINARY, "r1", null, null, false));
        store.append(incomplete, new byte[]{7});
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.finishEntry(incomplete));
        assertThrows(HistoryVault.Fault.class, () -> store.commit(incomplete));
        store.cancel(incomplete);

        String rejected = store.begin("replace", 1L, this);
        addSession(rejected, "replacement", "new", NONE, NONE);
        store.prepare(rejected);
        try (SQLiteDatabase attacker = SQLiteDatabase.openDatabase(new File(root, "history.sqlite").getAbsolutePath(),
            null, SQLiteDatabase.OPEN_READWRITE)) {
            attacker.execSQL("CREATE TRIGGER simulated_disk_failure BEFORE INSERT ON sessions"
                + " WHEN NEW.id='replacement' BEGIN SELECT RAISE(ABORT, 'simulated writer failure'); END");
        }
        assertThrows(android.database.sqlite.SQLiteException.class, () -> store.commit(rejected));
        assertEquals(1, store.status().generation);
        assertEquals(rejected, store.status().pendingId);
        assertEquals("saved-chat", store.list(true, 1, null, 10).items.get(0).id);
        store.cancel(rejected);
        restart();
        assertEquals("saved-chat", store.list(true, 1, null, 10).items.get(0).id);
    }

    @Test public void corruptSameSizedBytesAreRejectedBeforeRecoveryPublishesThem() throws Exception {
        String batch = store.begin("replace", 0L, this);
        byte[] bytes = new byte[]{1, 2, 3};
        String original = addOriginal(batch, "media", "one", bytes);
        String session = addSession(batch, "session", "r1", ids("media"), NONE);
        store.commit(batch);
        try (FileOutputStream bad = new FileOutputStream(stored(original))) { bad.write(new byte[]{9, 2, 3}); }
        File destination = new File(sandbox, "must-not-publish");
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.restoreOriginal(1, "media", destination));
        assertFalse(destination.exists());

        File conversation = stored(session);
        byte[] body = readBytes(conversation);
        body[2] = (byte) (body[2] ^ 1);
        try (FileOutputStream bad = new FileOutputStream(conversation)) { bad.write(body); }
        restart();
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.readSession(1, "session", 0, 32));
        assertEquals(1, store.status().generation);
    }

    @Test public void manualVerificationRepairsSameSizedCorruptionWithoutChangingTheExpectedContent() throws Exception {
        byte[] original = new byte[]{1, 32, 88, 76};
        File primary = source("primary-retained.bin", original);
        String saved = store.begin("merge", 0L, this);
        String originalSha = addOriginal(saved, "original", "immutable-r1", original);
        String sessionSha = addSession(saved, "test-chat", "s1", ids("original"), NONE);
        addSession(saved, "shared-chat", "s2", ids("original"), NONE);
        store.commit(saved);

        try (FileOutputStream output = new FileOutputStream(stored(originalSha))) { output.write(new byte[4]); }
        String ordinary = store.begin("merge", 1L, this);
        assertFalse(store.putOriginal(ordinary, "original", 4, BINARY, "immutable-r1", primary, null, false));
        store.cancel(ordinary);
        File rejected = new File(sandbox, "bad-restore.bin");
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.restoreOriginal(1, "original", rejected));
        assertFalse(rejected.exists());

        String repair = store.begin("merge", 1L, this);
        assertFalse(store.putOriginal(repair, "original", 4, BINARY, "immutable-r1", primary, null, true));
        assertEquals(2, store.commit(repair).generation);
        assertEquals(originalSha, store.list(false, 2, null, 4).items.get(0).sha256);
        File restored = new File(sandbox, "healthy-restore.bin");
        store.restoreOriginal(2, "original", restored);
        assertArrayEquals(original, readBytes(restored));
        assertEquals(2, store.status().sessions);

        try (FileOutputStream output = new FileOutputStream(stored(originalSha))) { output.write(new byte[4]); }
        byte[] snapshot = readBytes(stored(sessionSha));
        try (FileOutputStream output = new FileOutputStream(stored(sessionSha))) { output.write(new byte[snapshot.length]); }
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.readSession(2, "test-chat", 0, 64));
        String boundedRepair = store.begin("merge", 2L, this);
        assertTrue(store.putOriginal(boundedRepair, "original", 4, BINARY, "immutable-r1", null, null, true));
        store.append(boundedRepair, original);
        assertEquals(originalSha, store.finishEntry(boundedRepair));
        assertEquals(sessionSha, addSession(boundedRepair, "test-chat", "s1", ids("original"), NONE));
        assertEquals(3, store.commit(boundedRepair).generation);
        assertArrayEquals(snapshot, store.readSession(3, "test-chat", 0, 256).data);
        File restoredAgain = new File(sandbox, "again.bin");
        store.restoreOriginal(3, "original", restoredAgain);
        assertArrayEquals(original, readBytes(restoredAgain));
    }

    @Test public void manualVerificationRefusesDamagedPrimaryBytesForTheSameRevision() throws Exception {
        byte[] original = new byte[]{1, 32, 88, 76};
        byte[] damaged = new byte[]{2, 33, 89, 77};
        String initial = store.begin("merge", 0L, this);
        String originalSha = addOriginal(initial, "original", "immutable-r1", original);
        addSession(initial, "test-chat", "s1", ids("original"), NONE);
        store.commit(initial);
        try (FileOutputStream output = new FileOutputStream(stored(originalSha))) { output.write(damaged); }

        File damagedPrimary = source("primary-damaged.bin", damaged);
        String nativeCopy = store.begin("merge", 1L, this);
        assertThrows(HistoryVaultObjects.IntegrityFailure.class,
            () -> store.putOriginal(nativeCopy, "original", damaged.length, BINARY, "immutable-r1", damagedPrimary, null, true));
        assertThrows(HistoryVault.Fault.class, () -> store.commit(nativeCopy));
        store.cancel(nativeCopy);

        String bridgeCopy = store.begin("merge", 1L, this);
        assertTrue(store.putOriginal(bridgeCopy, "original", damaged.length, BINARY, "immutable-r1", null, null, true));
        store.append(bridgeCopy, damaged);
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> store.finishEntry(bridgeCopy));
        assertThrows(HistoryVault.Fault.class, () -> store.commit(bridgeCopy));
        store.cancel(bridgeCopy);

        assertEquals(1, store.status().generation);
        assertEquals(originalSha, store.list(false, 1, null, 4).items.get(0).sha256);
        assertEquals("test-chat", store.list(true, 1, null, 4).items.get(0).id);
        assertEquals(1, store.status().originals);
        String recovered = store.begin("merge", 1L, this);
        assertFalse(store.putOriginal(recovered, "original", original.length, BINARY, "immutable-r1",
            source("primary-healed.bin", original), null, true));
        assertEquals(2, store.commit(recovered).generation);
        File restored = new File(sandbox, "verified-original.bin");
        store.restoreOriginal(2, "original", restored);
        assertArrayEquals(original, readBytes(restored));
    }
}
