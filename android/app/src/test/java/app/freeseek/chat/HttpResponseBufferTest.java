package app.freeseek.chat;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HttpResponseBufferTest {
    @Rule public TemporaryFolder cache = new TemporaryFolder();

    @Test public void stalledReaderResumesWithTheWholeReplyAndItsEndMarker() throws Exception {
        HttpResponseBuffer response = new HttpResponseBuffer(cache.getRoot());
        byte[] source = new byte[HttpResponseBuffer.CHUNK_BYTES];
        ByteArrayOutputStream expected = new ByteArrayOutputStream();
        for (int i = 0; i < 24; i++) {
            Arrays.fill(source, (byte) i);
            int count = source.length - i;
            response.write(source, count);
            expected.write(source, 0, count);
        }
        assertEquals(expected.size(), response.pendingBytes());
        assertTrue(response.spooledBytes() > 0);
        response.finish(null);

        ByteArrayOutputStream actual = new ByteArrayOutputStream();
        while (actual.size() < expected.size()) {
            assertTrue(response.read((bytes, count, code) -> {
                assertNull(code);
                assertTrue(count > 0);
                actual.write(bytes, 0, count);
            }));
        }
        assertArrayEquals(expected.toByteArray(), actual.toByteArray());
        assertEquals(0, response.pendingBytes());
        assertTrue(response.read((bytes, count, code) -> {
            assertNull(bytes);
            assertNull(code);
        }));
        assertEquals(0, cache.getRoot().list().length);
    }

    @Test public void bufferedDataIsDeliveredBeforeAConnectionFailure() throws Exception {
        HttpResponseBuffer response = new HttpResponseBuffer(cache.getRoot());
        response.write(new byte[] {42}, 1);
        response.finish("NETWORK_ERROR");
        assertTrue(response.read((bytes, count, code) -> {
            assertArrayEquals(new byte[] {42}, bytes);
            assertNull(code);
        }));
        assertTrue(response.read((bytes, count, code) -> {
            assertNull(bytes);
            assertEquals("NETWORK_ERROR", code);
        }));
    }

    @Test public void cancellationReleasesWaitingReadersAndBufferedFiles() throws Exception {
        HttpResponseBuffer response = new HttpResponseBuffer(cache.getRoot());
        AtomicReference<String> terminal = new AtomicReference<>();
        assertTrue(response.read((bytes, count, code) -> terminal.set(code)));
        assertFalse(response.read((bytes, count, code) -> fail("A second pending read was accepted")));
        response.cancel();
        assertEquals("CANCELLED", terminal.get());

        HttpResponseBuffer backlogged = new HttpResponseBuffer(cache.getRoot());
        byte[] chunk = new byte[HttpResponseBuffer.CHUNK_BYTES];
        for (int i = 0; i < 8; i++) backlogged.write(chunk, chunk.length);
        assertTrue(backlogged.spooledBytes() > 0);
        backlogged.cancel();
        assertEquals(0, backlogged.pendingBytes());
        assertEquals(0, cache.getRoot().list().length);
    }
}
