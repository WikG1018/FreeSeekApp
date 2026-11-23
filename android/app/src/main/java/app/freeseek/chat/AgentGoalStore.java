package app.freeseek.chat;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Agent task checkpoints and artifacts stay separate from WebView chat history and Android backup. */
final class AgentGoalStore extends SQLiteOpenHelper {
    private static final int CHUNK_CHARS = 128 * 1024;
    private static final int MAX_STATE_CHARS = 12 * 1024 * 1024;
    static final int MAX_VIEW_CHARS = 240_000;
    static final int MAX_FILE_BYTES = 2 * 1024 * 1024;
    private static AgentGoalStore instance;
    private final File originals;

    static synchronized AgentGoalStore open(Context context) {
        if (instance == null) instance = new AgentGoalStore(context.getApplicationContext());
        return instance;
    }

    private AgentGoalStore(Context context) {
        super(context, new File(context.getNoBackupFilesDir(), "agent-goals.db").getPath(), null, 1);
        originals = new File(context.getNoBackupFilesDir(), "agent-goal-files");
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE checkpoint (run TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER NOT NULL,"
            + " data TEXT NOT NULL, PRIMARY KEY (run, kind, part))");
        db.execSQL("CREATE TABLE artifact (run TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,"
            + " mime TEXT NOT NULL, size INTEGER NOT NULL, sha TEXT NOT NULL, created INTEGER NOT NULL,"
            + " ready INTEGER NOT NULL, PRIMARY KEY (run, id))");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int previous, int next) {
        throw new IllegalStateException("Unsupported Agent checkpoint schema");
    }

    private void replaceParts(SQLiteDatabase db, String id, String kind, String data) {
        db.delete("checkpoint", "run = ? AND kind = ?", new String[] { id, kind });
        for (int start = 0, part = 0; start < data.length(); part++) {
            int end = Math.min(data.length(), start + CHUNK_CHARS);
            if (end < data.length() && Character.isHighSurrogate(data.charAt(end - 1))) end--;
            ContentValues row = new ContentValues();
            row.put("run", id);
            row.put("kind", kind);
            row.put("part", part);
            row.put("data", data.substring(start, end));
            db.insertOrThrow("checkpoint", null, row);
            start = end;
        }
    }

    void checkpoint(String id, String state, String view, int first, JSONArray blocks, String readyFile) throws Exception {
        if (state.length() > MAX_STATE_CHARS || view.length() > MAX_VIEW_CHARS) {
            throw new IllegalStateException("Agent checkpoint exceeded local limits");
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; blocks != null && i < blocks.length(); i++) {
                int index = first + i;
                String content = blocks.getJSONObject(i).toString();
                ContentValues block = new ContentValues();
                block.put("run", id);
                block.put("kind", "text");
                block.put("part", index);
                block.put("data", content);
                if (db.insertWithOnConflict("checkpoint", null, block, SQLiteDatabase.CONFLICT_IGNORE) == -1) {
                    try (Cursor row = db.query("checkpoint", new String[] { "data" },
                        "run = ? AND kind = 'text' AND part = ?", new String[] { id, Integer.toString(index) },
                        null, null, null)) {
                        if (!row.moveToFirst() || !content.equals(row.getString(0))) {
                            throw new IllegalStateException("Agent transcript sequence changed");
                        }
                    }
                }
            }
            replaceParts(db, id, "state", state);
            replaceParts(db, id, "view", view);
            if (readyFile != null) {
                ContentValues ready = new ContentValues();
                ready.put("ready", 1);
                if (db.update("artifact", ready, "run = ? AND id = ?", new String[] { id, readyFile }) != 1) {
                    throw new IllegalStateException("Agent artifact checkpoint did not commit");
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private String parts(String id, String kind, int limit) {
        StringBuilder output = new StringBuilder();
        try (Cursor rows = getReadableDatabase().query(
            "checkpoint", new String[] { "data" }, "run = ? AND kind = ?",
            new String[] { id, kind }, null, null, "part ASC"
        )) {
            while (rows.moveToNext()) {
                String data = rows.getString(0);
                if (output.length() + data.length() > limit) {
                    throw new IllegalStateException("Agent checkpoint exceeded local limits");
                }
                output.append(data);
            }
        }
        return output.length() == 0 ? null : output.toString();
    }

    String state(String id) { return parts(id, "state", MAX_STATE_CHARS); }

    String view(String id) { return parts(id, "view", MAX_VIEW_CHARS); }

    JSONObject transcriptPage(String id, JSONObject view, int offset) throws Exception {
        if (!view.has("blockCount")) return view;
        int count = view.optInt("blockCount");
        int first = Math.max(0, Math.min(offset, count));
        JSONArray blocks = new JSONArray();
        int chars = 0;
        try (Cursor rows = getReadableDatabase().query("checkpoint", new String[] { "part", "data" },
            "run = ? AND kind = 'text' AND part >= ? AND part < ?",
            new String[] { id, Integer.toString(first), Integer.toString(count) }, null, null, "part ASC", "6")) {
            while (rows.moveToNext()) {
                String data = rows.getString(1);
                if (rows.getInt(0) != first + blocks.length()) break;
                if (blocks.length() > 0 && chars + data.length() > 96_000) break;
                blocks.put(new JSONObject(data));
                chars += data.length();
            }
        }
        if (first < count && blocks.length() == 0) {
            throw new IllegalStateException("Agent transcript page missing");
        }
        return view.put("blockOffset", first).put("blocks", blocks);
    }

    private File original(String id) {
        if (!id.matches("[a-zA-Z0-9_-]{1,120}")) throw new IllegalArgumentException("Invalid artifact ID");
        return new File(originals, id + ".bin");
    }

    private File temporary(String id) {
        return new File(originals, id + ".part");
    }

    private static String digest(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder(hash.length * 2);
        for (byte value : hash) {
            result.append(Character.forDigit((value >> 4) & 15, 16));
            result.append(Character.forDigit(value & 15, 16));
        }
        return result.toString();
    }

    void stageArtifact(String run, String id, String name, String mime, byte[] bytes) throws Exception {
        if (bytes.length > MAX_FILE_BYTES || (!originals.isDirectory() && !originals.mkdirs())) {
            throw new IOException("Agent artifact storage unavailable");
        }
        File file = original(id);
        ContentValues row = new ContentValues();
        row.put("run", run);
        row.put("id", id);
        row.put("name", name);
        row.put("mime", mime);
        row.put("size", bytes.length);
        row.put("sha", digest(bytes));
        row.put("created", System.currentTimeMillis());
        row.put("ready", 0);
        getWritableDatabase().insertOrThrow("artifact", null, row);
        File staging = temporary(id);
        if (!staging.createNewFile()) throw new IOException("Agent artifact staging unavailable");
        try {
            try (FileOutputStream out = new FileOutputStream(staging)) {
                out.write(bytes);
                out.getFD().sync();
            }
            if (file.exists() || !staging.renameTo(file)) throw new IOException("Agent artifact commit failed");
        } finally {
            if (staging.exists()) staging.delete();
        }
    }

    void discardStage(String run, String id) {
        if (getWritableDatabase().delete("artifact", "run = ? AND id = ? AND ready = 0",
            new String[] { run, id }) == 1) {
            original(id).delete();
            temporary(id).delete();
        }
    }

    boolean forget(String run) throws IOException {
        String owned = run == null
            ? "[A-Za-z0-9_-]{1,100}-file-[0-9]{1,12}"
            : Pattern.quote(run) + "-file-[0-9]{1,12}";
        Pattern files = Pattern.compile(owned + "\\.(?:bin|part)");
        SQLiteDatabase db = getWritableDatabase();
        String where = run == null ? null : "run = ?";
        String[] arguments = run == null ? null : new String[] { run };
        db.beginTransaction();
        try {
            if (originals.isDirectory()) {
                File[] retired = originals.listFiles((parent, name) -> files.matcher(name).matches());
                if (retired == null) throw new IOException("Cannot list Agent artifacts");
                for (File file : retired) {
                    if (file.isDirectory() || (!file.delete() && file.exists())) {
                        throw new IOException("Cannot retire an Agent artifact");
                    }
                }
            }
            db.delete("artifact", where, arguments);
            db.delete("checkpoint", where, arguments);
            db.setTransactionSuccessful();
            return true;
        } finally {
            db.endTransaction();
        }
    }

    record Artifact(File file, String id, String name, String mime, long size, String sha, long created) {
        JSONObject result() throws Exception {
            return new JSONObject()
                .put("id", id)
                .put("name", name)
                .put("mimeType", mime)
                .put("size", size)
                .put("sha256", sha)
                .put("createdAt", created)
                .put("serverId", JSONObject.NULL)
                .put("isImage", false);
        }

        boolean hasVerifiedBytes() throws Exception {
            if (!file.isFile() || file.length() != size || size > MAX_FILE_BYTES) return false;
            try (FileInputStream stream = new FileInputStream(file)) {
                MessageDigest checksum = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[8192];
                for (int count; (count = stream.read(buffer)) != -1; ) checksum.update(buffer, 0, count);
                byte[] bytes = checksum.digest();
                StringBuilder result = new StringBuilder(bytes.length * 2);
                for (byte value : bytes) {
                    result.append(Character.forDigit((value >> 4) & 15, 16));
                    result.append(Character.forDigit(value & 15, 16));
                }
                return sha.contentEquals(result);
            }
        }
    }

    Artifact artifact(String run, String id, boolean ready) {
        try (Cursor row = getReadableDatabase().query(
            "artifact", new String[] { "name", "mime", "size", "sha", "created" },
            "run = ? AND id = ? AND ready = ?", new String[] { run, id, ready ? "1" : "0" },
            null, null, null
        )) {
            if (!row.moveToFirst()) return null;
            return new Artifact(original(id), id, row.getString(0), row.getString(1),
                row.getLong(2), row.getString(3), row.getLong(4));
        }
    }
}
