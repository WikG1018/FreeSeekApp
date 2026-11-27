package app.freeseek.chat;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HistoryVaultObjectsTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void chunkedWriteAndDiskCopyShareContentButRecoveryKeepsSeparateBytes() throws Exception {
        File root = temporary.newFolder();
        HistoryVaultObjects objects = new HistoryVaultObjects(root, directory -> {}, HistoryVaultObjectsTest::replace);
        byte[] first = new byte[HistoryVaultObjects.CHUNK_BYTES];
        Arrays.fill(first, (byte) 52);
        byte[] last = new byte[]{1, 2, 3, 4};
        int size = first.length + last.length;
        String digest;
        try (HistoryVaultObjects.Write output = objects.open(size)) {
            output.append(first, first.length);
            output.append(last, last.length);
            digest = objects.install(output, null, null);
        }
        File original = new File(temporary.newFolder(), "original.bin");
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(original)) {
            output.write(first);
            output.write(last);
        }
        assertEquals(digest, objects.copyFrom(original, size, digest));
        assertEquals(1, countObjects(root));
        assertArrayEquals(last, objects.read(digest, size, first.length, HistoryVaultObjects.CHUNK_BYTES));
        File restored = new File(temporary.newFolder(), "restored.bin");
        objects.restore(digest, size, restored);
        try (java.io.RandomAccessFile overwrite = new java.io.RandomAccessFile(restored, "rw")) {
            overwrite.write(0);
        }
        assertArrayEquals(new byte[]{52}, objects.read(digest, size, 0, 1));
        assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> objects.restore(digest, size, restored));
    }

    @Test public void partialAndOutOfSpaceWritesNeverInstallAnObject() throws Exception {
        File root = temporary.newFolder();
        HistoryVaultObjects objects = new HistoryVaultObjects(root, directory -> {}, HistoryVaultObjectsTest::replace);
        try (HistoryVaultObjects.Write output = objects.open(4)) {
            output.append(new byte[]{1}, 1);
            assertThrows(HistoryVaultObjects.IntegrityFailure.class, () -> objects.install(output, null, null));
        }
        assertThrows(HistoryVaultObjects.NoSpace.class, () -> objects.open(Long.MAX_VALUE));
        assertEquals(0, countObjects(root));
        assertEquals(0, new File(root, "staging").list().length);
    }

    @Test public void retrySynchronizesTheDirectoryEvenWhenItCanReuseTheObject() throws Exception {
        File root = temporary.newFolder();
        AtomicBoolean denyObjectDirectory = new AtomicBoolean(true);
        HistoryVaultObjects objects = new HistoryVaultObjects(root, directory -> {
            if (directory.getName().matches("[0-9a-f]{2}") && denyObjectDirectory.get()) {
                throw new IOException("Injected directory sync failure");
            }
        }, HistoryVaultObjectsTest::replace);
        byte[] data = new byte[]{5, 6, 7};
        try (HistoryVaultObjects.Write output = objects.open(data.length)) {
            output.append(data, data.length);
            assertThrows(IOException.class, () -> objects.install(output, null, null));
        }
        assertEquals(1, countObjects(root));
        try (HistoryVaultObjects.Write output = objects.open(data.length)) {
            output.append(data, data.length);
            assertThrows(IOException.class, () -> objects.install(output, null, null));
        }
        denyObjectDirectory.set(false);
        try (HistoryVaultObjects.Write output = objects.open(data.length)) {
            output.append(data, data.length);
            String digest = objects.install(output, null, null);
            objects.verifyAvailable(digest, data.length);
        }
    }

    @Test public void aVerifiedHealthySourceAtomicallyRepairsSameSizedCorruption() throws Exception {
        File root = temporary.newFolder();
        HistoryVaultObjects objects = new HistoryVaultObjects(root, directory -> {}, HistoryVaultObjectsTest::replace);
        byte[] healthy = new byte[]{10, 11, 12};
        File primary = temporary.newFile();
        Files.write(primary.toPath(), healthy);
        String digest = objects.copyFrom(primary, healthy.length, null);
        File stored = new File(new File(new File(root, "objects"), digest.substring(0, 2)), digest.substring(2));
        Files.write(stored.toPath(), new byte[]{14, 15, 16});
        assertTrue(objects.contains(digest, healthy.length, false));
        assertFalse(objects.contains(digest, healthy.length, true));
        assertEquals(digest, objects.copyFrom(primary, healthy.length, digest));
        objects.verifyAvailable(digest, healthy.length);
        assertArrayEquals(healthy, Files.readAllBytes(stored.toPath()));
        assertEquals(1, countObjects(root));
    }

    private static void replace(File source, File target) throws IOException {
        Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private static long countObjects(File root) throws IOException {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(new File(root, "objects").toPath())) {
            return paths.filter(Files::isRegularFile).count();
        }
    }
}
