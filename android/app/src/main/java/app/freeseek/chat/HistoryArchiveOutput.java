package app.freeseek.chat;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Writes a history archive to its final destination with bounded buffers. */
final class HistoryArchiveOutput {
    private static final int DISK_CHUNK_BYTES = 1024 * 1024;
    private static final long FIXED_TIME = 315619200000L;
    private final ZipOutputStream zip;
    private final long expectedBytes;
    private final int expectedEntries;
    private long entryRemaining = -1;
    private long writtenBytes;
    private int entries;

    static final class OriginalReadError extends IOException {
        OriginalReadError(IOException cause) {
            super("Unable to read the stored history original", cause);
        }
    }

    static long backupSize(Object value) {
        if (!(value instanceof Number)) {
            return -1;
        }
        double size = ((Number) value).doubleValue();
        return Double.isFinite(size) && size >= 0 && size <= 0xffffffffL && size == Math.floor(size)
            ? (long) size : -1;
    }

    HistoryArchiveOutput(OutputStream destination, long expectedBytes, int expectedEntries) {
        this.expectedBytes = expectedBytes;
        this.expectedEntries = expectedEntries;
        zip = new ZipOutputStream(new BufferedOutputStream(destination, 128 * 1024));
        zip.setLevel(Deflater.NO_COMPRESSION);
    }

    private ZipEntry next(String name, long size) throws IOException {
        if (entryRemaining >= 0 || entries >= expectedEntries || size < 0 || size > expectedBytes - writtenBytes) {
            throw new IOException("Invalid archive entry order or size");
        }
        String safe = name == null ? "" : Normalizer.normalize(name, Normalizer.Form.NFC);
        if (safe.isEmpty() || safe.indexOf('\\') >= 0 || safe.indexOf(0) >= 0
                || safe.matches("^[A-Za-z]:.*") || safe.getBytes(StandardCharsets.UTF_8).length > 0xffff) {
            throw new IOException("Invalid archive path");
        }
        for (String component : safe.split("/", -1)) {
            if (component.isEmpty() || ".".equals(component) || "..".equals(component)) {
                throw new IOException("Invalid archive path");
            }
        }
        ZipEntry entry = new ZipEntry(safe);
        entry.setTime(FIXED_TIME);
        return entry;
    }

    private void start(ZipEntry entry, long size) throws IOException {
        zip.putNextEntry(entry);
        entryRemaining = size;
        completeEntryIfReady();
    }

    void begin(String name, long size) throws IOException {
        ZipEntry entry = next(name, size);
        entry.setMethod(ZipEntry.DEFLATED);
        start(entry, size);
    }

    void append(byte[] data, int length) throws IOException {
        if (length < 1 || length > entryRemaining) {
            throw new IOException("Invalid archive data length");
        }
        zip.write(data, 0, length);
        writtenBytes += length;
        entryRemaining -= length;
        completeEntryIfReady();
    }

    private void completeEntryIfReady() throws IOException {
        if (entryRemaining == 0) {
            zip.closeEntry();
            entryRemaining = -1;
            entries += 1;
        }
    }

    private static FileInputStream openOriginal(File file, long size) throws OriginalReadError {
        try {
            if (!file.isFile() || file.length() != size) {
                throw new IOException("The original size has changed");
            }
            return new FileInputStream(file);
        } catch (IOException failure) {
            throw new OriginalReadError(failure);
        }
    }

    private static int readOriginal(FileInputStream input, byte[] buffer) throws OriginalReadError {
        try {
            return input.read(buffer);
        } catch (IOException failure) {
            throw new OriginalReadError(failure);
        }
    }

    /** Stored native originals stay cheap to re-import. A CRC pass avoids bridging file bytes to JavaScript. */
    void copyOriginal(String name, long size, File file) throws IOException {
        ZipEntry entry = next(name, size);
        try (FileInputStream input = openOriginal(file, size)) {
            byte[] buffer = new byte[DISK_CHUNK_BYTES];
            CRC32 crc = new CRC32();
            long scanned = 0;
            for (int read; (read = readOriginal(input, buffer)) != -1; ) {
                scanned += read;
                if (scanned > size) {
                    throw new OriginalReadError(new IOException("The original grew while reading"));
                }
                crc.update(buffer, 0, read);
            }
            if (scanned != size) {
                throw new OriginalReadError(new IOException("The original was truncated while reading"));
            }
            try {
                input.getChannel().position(0);
            } catch (IOException failure) {
                throw new OriginalReadError(failure);
            }
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(size);
            entry.setCompressedSize(size);
            entry.setCrc(crc.getValue());
            start(entry, size);
            for (int read; (read = readOriginal(input, buffer)) != -1; ) {
                append(buffer, read);
            }
            if (entryRemaining >= 0) {
                throw new OriginalReadError(new IOException("The original was truncated while saving"));
            }
        }
    }

    long finish() throws IOException {
        if (entryRemaining >= 0 || entries != expectedEntries || writtenBytes != expectedBytes) {
            throw new IOException("The history archive is incomplete");
        }
        zip.finish();
        zip.close();
        return writtenBytes;
    }

    void discard() {
        try {
            zip.close();
        } catch (IOException ignored) {
            // A partial archive may fail finalization. The caller closes and removes its document.
        }
    }
}
