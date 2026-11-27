package app.freeseek.chat;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.function.Predicate;

/** Bounded, content-addressed storage shared by the vault's committed and pending generations. */
final class HistoryVaultObjects {
    static final int CHUNK_BYTES = 256 * 1024;
    private static final int COPY_BYTES = 1024 * 1024;

    interface DirectorySync { void sync(File directory) throws IOException; }
    interface AtomicReplace { void move(File source, File target) throws IOException; }
    interface Validator { void check(File file) throws IOException; }

    static class IntegrityFailure extends IOException {
        IntegrityFailure(String message) { super(message); }
    }

    static class NoSpace extends IOException {
        NoSpace() { super("Not enough space for a history object"); }
    }

    static final class Write implements AutoCloseable {
        private final File temp;
        private final long expected;
        private final MessageDigest digest = sha256();
        private final FileOutputStream stream;
        private long written;
        private boolean sealed;

        Write(File directory, long expected) throws IOException {
            if (expected < 0) throw new IllegalArgumentException("Invalid object length");
            if (expected > directory.getUsableSpace()) throw new NoSpace();
            this.expected = expected;
            temp = File.createTempFile("history-", ".part", directory);
            try {
                stream = new FileOutputStream(temp);
            } catch (IOException failure) {
                temp.delete();
                throw failure;
            }
        }

        void append(byte[] bytes, int length) throws IOException {
            if (sealed || length <= 0 || length > bytes.length || length > expected - written) {
                throw new IntegrityFailure("Unexpected object byte count");
            }
            stream.write(bytes, 0, length);
            digest.update(bytes, 0, length);
            written += length;
        }

        String seal() throws IOException {
            if (sealed) throw new IntegrityFailure("Object was already closed");
            sealed = true;
            try (FileOutputStream output = stream) {
                if (written != expected || temp.length() != expected) {
                    throw new IntegrityFailure("Incomplete history object");
                }
                output.getFD().sync();
            }
            return hex(digest.digest());
        }

        @Override public void close() {
            if (!sealed) {
                sealed = true;
                try { stream.close(); } catch (IOException ignored) { }
            }
            // The file only remains here if it was abandoned or installation failed.
            temp.delete();
        }
    }

    private final File objects;
    private final File staging;
    private final DirectorySync directorySync;
    private final AtomicReplace atomicReplace;

    HistoryVaultObjects(File directory, DirectorySync directorySync, AtomicReplace atomicReplace) throws IOException {
        this.directorySync = directorySync;
        this.atomicReplace = atomicReplace;
        ensureDirectory(directory);
        objects = new File(directory, "objects");
        staging = new File(directory, "staging");
        ensureDirectory(objects);
        ensureDirectory(staging);
    }

    private void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdir() && !directory.isDirectory()) {
            throw new IOException("Could not create private history storage");
        }
        // A previous attempt may have created the directory and failed before synchronizing it.
        directorySync.sync(directory.getParentFile());
    }

    static boolean validDigest(String digest) {
        return digest != null && digest.matches("[0-9a-f]{64}");
    }

    private File object(String digest) {
        if (!validDigest(digest)) throw new IllegalArgumentException("Invalid object digest");
        return new File(new File(objects, digest.substring(0, 2)), digest.substring(2));
    }

    Write open(long expected) throws IOException { return new Write(staging, expected); }

    String install(Write write, String expectedDigest, Validator validator) throws IOException {
        try (Write closed = write) {
            String digest = closed.seal();
            if (expectedDigest != null && !expectedDigest.equals(digest)) {
                throw new IntegrityFailure("History object changed during copy");
            }
            if (validator != null) validator.check(closed.temp);
            verify(closed.temp, closed.expected, digest);
            File target = object(digest);
            if (!verifyReusable(target, closed.expected, digest)) {
                ensureDirectory(target.getParentFile());
                // Replacing this hash can only repair the bytes expected by existing references.
                atomicReplace.move(closed.temp, target);
            }
            directorySync.sync(target.getParentFile());
            return digest;
        }
    }

    String copyFrom(File source, long size, String expectedDigest) throws IOException {
        String digest = digestOf(source, size);
        if (expectedDigest != null && !expectedDigest.equals(digest)) {
            throw new IntegrityFailure("Original does not match its expected digest");
        }
        if (contains(digest, size, true)) return digest;
        try (Write write = open(size)) {
            copy(source, write);
            return install(write, digest, null);
        }
    }

    boolean contains(String digest, long size, boolean verifyExisting) throws IOException {
        File file = object(digest);
        if (!verifyExisting) return file.isFile() && file.length() == size;
        if (!verifyReusable(file, size, digest)) return false;
        directorySync.sync(file.getParentFile());
        return true;
    }

    private static boolean verifyReusable(File file, long size, String digest) throws IOException {
        try {
            verify(file, size, digest);
            return true;
        } catch (IntegrityFailure failure) {
            return false;
        }
    }

    void verifyAvailable(String digest, long size) throws IOException { verify(object(digest), size, digest); }

    void requireAvailable(String digest, long size) throws IOException { requireSize(object(digest), size); }

    byte[] read(String digest, long size, long offset, int limit) throws IOException {
        if (offset < 0 || offset > size || limit < 1 || limit > CHUNK_BYTES) {
            throw new IllegalArgumentException("Invalid history object read range");
        }
        File file = object(digest);
        requireSize(file, size);
        byte[] bytes = new byte[(int) Math.min(size - offset, limit)];
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            input.seek(offset);
            input.readFully(bytes);
        }
        return bytes;
    }

    void restore(String digest, long size, File target) throws IOException {
        File source = object(digest);
        requireSize(source, size);
        if (target.exists()) {
            verify(target, size, digest);
            directorySync.sync(target.getParentFile());
            return;
        }
        ensureDirectory(target.getParentFile());
        try (Write write = new Write(target.getParentFile(), size)) {
            copy(source, write);
            if (!digest.equals(write.seal())) throw new IntegrityFailure("Stored history original is damaged");
            verify(write.temp, size, digest);
            if (target.exists() || !write.temp.renameTo(target)) {
                throw new IOException("Could not restore private history original");
            }
            directorySync.sync(target.getParentFile());
        }
    }

    void remove(String digest) throws IOException {
        File file = object(digest);
        if (file.exists() && !file.delete()) throw new IOException("Could not remove unused history object");
    }

    void discardStaging() throws IOException {
        for (File file : list(staging)) {
            if (file.isFile() && file.getName().endsWith(".part") && !file.delete()) {
                throw new IOException("Could not remove abandoned history write");
            }
        }
    }

    void collectOrphans(Predicate<String> used) throws IOException {
        for (File shard : list(objects)) {
            if (!shard.isDirectory() || !shard.getName().matches("[0-9a-f]{2}")) continue;
            for (File file : list(shard)) {
                String digest = shard.getName() + file.getName();
                if (validDigest(digest) && !used.test(digest)) remove(digest);
            }
        }
    }

    private static File[] list(File directory) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Could not read private history storage");
        return files;
    }

    private static void requireSize(File file, long size) throws IOException {
        if (!file.isFile() || file.length() != size) throw new IntegrityFailure("Stored history object is missing or incomplete");
    }

    private static void verify(File file, long size, String digest) throws IOException {
        if (!digest.equals(digestOf(file, size))) throw new IntegrityFailure("Stored history object checksum differs");
    }

    private static String digestOf(File source, long size) throws IOException {
        requireSize(source, size);
        MessageDigest digest = sha256();
        byte[] buffer = new byte[COPY_BYTES];
        long read = 0;
        try (FileInputStream input = new FileInputStream(source)) {
            for (int count; (count = input.read(buffer)) != -1;) {
                read += count;
                if (read > size) throw new IntegrityFailure("History object changed during reading");
                digest.update(buffer, 0, count);
            }
        }
        if (read != size) throw new IntegrityFailure("History object changed during reading");
        return hex(digest.digest());
    }

    private static void copy(File source, Write output) throws IOException {
        byte[] buffer = new byte[COPY_BYTES];
        try (FileInputStream input = new FileInputStream(source)) {
            for (int count; (count = input.read(buffer)) != -1;) output.append(buffer, count);
        }
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException failure) { throw new IllegalStateException(failure); }
    }

    private static String hex(byte[] bytes) {
        char[] hex = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            result[i * 2] = hex[(bytes[i] & 0xff) >>> 4];
            result[i * 2 + 1] = hex[bytes[i] & 0xf];
        }
        return new String(result);
    }
}
