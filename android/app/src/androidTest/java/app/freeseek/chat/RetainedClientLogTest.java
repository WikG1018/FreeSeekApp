package app.freeseek.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.Test;

public class RetainedClientLogTest {
    private static JSONObject retained(String scope, String event, JSONObject details) throws Exception {
        long now = System.currentTimeMillis();
        JSONObject entry = new JSONObject()
            .put("id", "12345678-1234-1234-1234-123456789abc")
            .put("runId", "87654321-4321-4321-4321-abcdef123456")
            .put("timestamp", now)
            .put("level", "info")
            .put("scope", scope)
            .put("event", event)
            .put("details", details);
        Method sanitize = RetainedClientLog.class.getDeclaredMethod("sanitize", JSONObject.class, long.class);
        sanitize.setAccessible(true);
        JSONObject saved = (JSONObject) sanitize.invoke(null, entry, now);
        assertNotNull(saved);
        JSONObject reopened = (JSONObject) sanitize.invoke(null, new JSONObject(saved.toString()), now);
        assertNotNull(reopened);
        return reopened.getJSONObject("details");
    }

    @Test
    public void keepsOnlyKnownStartupRouteValues() throws Exception {
        String[] sources = { "native", "database", "legacy" };
        for (int index = 0; index < sources.length; index++) {
            String preferenceSource = sources[index];
            String selectionSource = sources[(index + 1) % sources.length];
            String page = index % 2 == 0 ? "last-chat" : "new-chat";
            JSONObject details = retained("app", "startup.chat-route", new JSONObject()
                .put("startupPreferenceSource", preferenceSource)
                .put("lastSelectionSource", selectionSource)
                .put("startupPage", page)
                .put("chatTitle", "synthetic private title"));
            assertEquals(preferenceSource, details.getString("startupPreferenceSource"));
            assertEquals(selectionSource, details.getString("lastSelectionSource"));
            assertEquals(page, details.getString("startupPage"));
            assertFalse(details.has("chatTitle"));
        }
        JSONObject rejected = retained("app", "startup.chat-route", new JSONObject()
            .put("startupPreferenceSource", "last-chat")
            .put("lastSelectionSource", "synthetic private path")
            .put("startupPage", "database"));
        assertEquals(0, rejected.length());
        JSONObject outOfScope = retained("app", "unhandled-rejection", new JSONObject()
            .put("startupPreferenceSource", "database")
            .put("startupPage", "last-chat"));
        assertEquals(0, outOfScope.length());
    }

    @Test
    public void keepsVerifiedHistoryCountsAndAllowedReasonsWithoutInferringDamage() throws Exception {
        String[] reasons = {
            "empty-after-known-history", "unreadable", "read-timeout", "checkpoint-timeout", "selection-uncertain"
        };
        for (String reason : reasons) {
            JSONObject details = retained("storage", "history.startup-read-failed", new JSONObject()
                .put("historyReason", reason)
                .put("name", "HistoryMissingError")
                .put("canStartFresh", false)
                .put("previousSessionCount", 8)
                .put("activeCount", 0)
                .put("alternateCount", 0)
                .put("indexCount", 0));
            assertEquals(reason, details.getString("historyReason"));
            assertEquals("HistoryMissingError", details.getString("name"));
            assertFalse(details.getBoolean("canStartFresh"));
            assertEquals(8, details.getInt("previousSessionCount"));
            assertEquals(0, details.getInt("activeCount"));
            assertEquals(0, details.getInt("alternateCount"));
            assertEquals(0, details.getInt("indexCount"));
        }
        JSONObject repair = retained("storage", "history.retry-repaired", new JSONObject()
            .put("state", "both-empty")
            .put("historyReason", "leveldb-checksum-mismatch"));
        assertEquals("both-empty", repair.getString("state"));
        assertFalse(repair.has("historyReason"));
        JSONObject outOfScope = retained("backup", "import.failed", new JSONObject()
            .put("historyReason", "unreadable")
            .put("state", "both-empty"));
        assertEquals(0, outOfScope.length());
    }
}
