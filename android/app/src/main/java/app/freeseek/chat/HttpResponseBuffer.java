package app.freeseek.chat;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayDeque;
import java.util.Arrays;

/** Delivers native HTTP bytes in order even when the WebView temporarily stops reading. */
final class HttpResponseBuffer {
    static final int CHUNK_BYTES = 16 * 1024;
    private static final int MEMORY_CHUNKS = 4;

    interface Reader {
        void receive(byte[] bytes, int count, String errorCode);
    }

    private final File cache;
    private final ArrayDeque<byte[]> pending = new ArrayDeque<>();
    private Reader waiting;
    private RandomAccessFile spool;
    private File spoolPath;
    private long readOffset;
    private long writeOffset;
    private long pendingBytes;
    private long spooledBytes;
    private boolean finished;
    private String errorCode;

    HttpResponseBuffer(File cache) {
        this.cache = cache;
    }

    synchronized void write(byte[] bytes, int count) throws IOException {
        if (finished) return;
        if (waiting != null) {
            Reader reader = waiting;
            waiting = null;
            reader.receive(bytes, count, null);
            return;
        }
        if (spool == null && pending.size() < MEMORY_CHUNKS) {
            pending.addLast(Arrays.copyOf(bytes, count));
        } else {
            if (spool == null) openSpool();
            spool.seek(writeOffset);
            spool.write(bytes, 0, count);
            writeOffset += count;
            spooledBytes += count;
        }
        pendingBytes += count;
    }

    synchronized boolean read(Reader reader) throws IOException {
        if (waiting != null) return false;
        byte[] bytes = pending.pollFirst();
        if (bytes == null && spool != null) {
            bytes = new byte[(int) Math.min(CHUNK_BYTES, writeOffset - readOffset)];
            spool.seek(readOffset);
            spool.readFully(bytes);
            readOffset += bytes.length;
            if (readOffset == writeOffset) closeSpool();
        }
        if (bytes != null) {
            pendingBytes -= bytes.length;
            reader.receive(bytes, bytes.length, null);
        } else if (finished) {
            reader.receive(null, 0, errorCode);
        } else {
            waiting = reader;
        }
        return true;
    }

    synchronized void finish(String code) {
        if (finished) return;
        finished = true;
        errorCode = code;
        if (waiting != null) {
            Reader reader = waiting;
            waiting = null;
            reader.receive(null, 0, code);
        }
    }

    synchronized void cancel() {
        pending.clear();
        pendingBytes = 0;
        closeSpool();
        finish("CANCELLED");
    }

    synchronized long pendingBytes() { return pendingBytes; }

    synchronized long spooledBytes() { return spooledBytes; }

    private void openSpool() throws IOException {
        File file = File.createTempFile("freeseek-http-", ".buffer", cache);
        try {
            spool = new RandomAccessFile(file, "rw");
            // Android can unlink the open file so a killed process leaves no reply on disk.
            if (!file.delete()) spoolPath = file;
        } catch (IOException failure) {
            file.delete();
            throw failure;
        }
    }

    private void closeSpool() {
        if (spool == null) return;
        try { spool.close(); }
        catch (IOException ignored) {}
        if (spoolPath != null) spoolPath.delete();
        spool = null;
        spoolPath = null;
        readOffset = 0;
        writeOffset = 0;
    }
}
