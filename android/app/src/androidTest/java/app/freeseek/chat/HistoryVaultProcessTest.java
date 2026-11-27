package app.freeseek.chat;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import android.os.Bundle;
import android.os.Process;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit two-process harness. Normal instrumentation runs skip this destructive synthetic probe. */
@RunWith(AndroidJUnit4.class)
public class HistoryVaultProcessTest {
    @Test public void interruptedProcess() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String phase = args.getString("vaultPhase", "");
        assumeTrue(phase.matches("stage-(prepared|unprepared)|recover-(prepared|unprepared)"));
        String nonce = args.getString("vaultNonce", "");
        assertTrue(nonce.matches("[a-z0-9]{8,32}"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = new File(context.getNoBackupFilesDir(), "vault-process-test-" + nonce);
        if (phase.startsWith("stage-")) {
            assertFalse(root.exists());
            HistoryVault store = new HistoryVault(root, failure -> {});
            String committed = store.begin("replace", 0L, this);
            add(store, committed, "before-exit");
            assertEquals(1, store.commit(committed).generation);
            String next = store.begin("replace", 1L, this);
            add(store, next, "after-exit");
            if ("stage-prepared".equals(phase)) assertEquals(next, store.prepare(next).pendingId);
            Process.killProcess(Process.myPid());
            throw new AssertionError("Process termination did not happen");
        }
        try (HistoryVault store = new HistoryVault(root, failure -> {})) {
            HistoryVault.Status current = store.status();
            assertEquals(1, current.generation);
            assertEquals("before-exit", store.list(true, 1, null, 2).items.get(0).id);
            if ("recover-prepared".equals(phase)) {
                assertNotNull(current.pendingId);
                assertEquals(2, store.commit(current.pendingId).generation);
                assertEquals("after-exit", store.list(true, 2, null, 2).items.get(0).id);
            } else {
                assertNull(current.pendingId);
                assertEquals(1, current.sessions);
            }
        }
    }

    private static void add(HistoryVault store, String batch, String id) throws Exception {
        byte[] bytes = ("{\"id\":\"" + id + "\",\"messages\":[]}").getBytes(StandardCharsets.UTF_8);
        store.putSession(batch, id, bytes.length, "r1", Collections.emptyList(), Collections.emptyList());
        store.append(batch, bytes);
        store.finishEntry(batch);
    }
}
