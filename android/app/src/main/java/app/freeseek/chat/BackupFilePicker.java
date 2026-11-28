package app.freeseek.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Process;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.JSObject;
import java.util.List;
import java.util.Locale;

/** ZIP imports use a native picker and pass the selected URI back to the existing WebView import. */
final class BackupFilePicker extends BridgeWebChromeClient {
    private static final String ZIP = "application/zip";
    private static final String ZIP_ALTERNATE = "application/x-zip-compressed";

    private final Activity activity;
    private final ActivityResultLauncher<Intent> launcher;
    private ValueCallback<Uri[]> pending;
    private boolean documentsFallback;

    BackupFilePicker(Bridge bridge) {
        super(bridge);
        activity = bridge.getActivity();
        launcher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), this::picked);
    }

    static boolean isBackupInput(int mode, boolean capture, String[] types) {
        if (mode != FileChooserParams.MODE_OPEN || capture || types == null || types.length == 0) return false;
        for (String type : types) {
            String filter = type.trim().toLowerCase(Locale.ROOT);
            if (!filter.equals(".zip") && !filter.equals(ZIP) && !filter.equals(ZIP_ALTERNATE)) return false;
        }
        return true;
    }

    private static Intent backupRequest(String action) {
        // Some file managers and document providers report ZIPs as generic binary files.
        return new Intent(action).addCategory(Intent.CATEGORY_OPENABLE).setType("application/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{ ZIP, ZIP_ALTERNATE, "application/octet-stream" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    private Intent preferredManager(Intent request) {
        PackageManager packages = activity.getPackageManager();
        ResolveInfo documents = packages.resolveActivity(
            backupRequest(Intent.ACTION_OPEN_DOCUMENT), PackageManager.MATCH_DEFAULT_ONLY);
        String documentsPackage = documents == null || documents.activityInfo == null
            ? "" : documents.activityInfo.packageName;

        Intent files = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_FILES);
        for (ResolveInfo manager : packages.queryIntentActivities(files, PackageManager.MATCH_SYSTEM_ONLY)) {
            if (manager.activityInfo == null) continue;
            String name = manager.activityInfo.packageName;
            if (name.equals(documentsPackage) || name.equals(activity.getPackageName())) continue;
            Intent picker = new Intent(request).setType("*/*").setPackage(name);
            if (picker.resolveActivity(packages) != null) return picker;
        }
        return null;
    }

    @Override public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (!isBackupInput(params.getMode(), params.isCaptureEnabled(), params.getAcceptTypes())) {
            return super.onShowFileChooser(webView, callback, params);
        }
        if (pending != null) {
            callback.onReceiveValue(null);
            return true;
        }
        pending = callback;
        documentsFallback = false;
        Intent request = backupRequest(Intent.ACTION_GET_CONTENT);
        Intent preferred = preferredManager(request);
        if (preferred != null && launch(preferred, "device-manager")) return true;
        List<ResolveInfo> choices = activity.getPackageManager()
            .queryIntentActivities(request, PackageManager.MATCH_DEFAULT_ONLY);
        if (choices.size() == 1 && launch(request, "default-picker")) return true;
        if (choices.size() > 1 && launch(Intent.createChooser(request, null), "app-chooser")) {
            return true;
        }
        openDocumentsFallback();
        return true;
    }

    private boolean launch(Intent intent, String source) {
        JSObject details = new JSObject().put("source", source);
        try {
            launcher.launch(intent);
            DiagnosticsLog.record(activity, "backup", "import.picker-opened", details);
            return true;
        } catch (ActivityNotFoundException | SecurityException unavailable) {
            DiagnosticsLog.warn(activity, "backup", "import.picker-unavailable",
                details.put("errorName", unavailable.getClass().getSimpleName()));
            return false;
        }
    }

    private void picked(ActivityResult result) {
        if (pending == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            DiagnosticsLog.record(activity, "backup", "import.picker-cancelled", new JSObject());
            finish(null);
            return;
        }
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null && data != null && data.getClipData() != null && data.getClipData().getItemCount() == 1) {
            uri = data.getClipData().getItemAt(0).getUri();
        }
        if (readGrant(uri)) {
            finish(uri);
        } else {
            DiagnosticsLog.warn(activity, "backup", "import.picker-unreadable",
                new JSObject().put("fallback", documentsFallback));
            openDocumentsFallback();
        }
    }

    private boolean readGrant(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) return false;
        String packageName = activity.getPackageName();
        String authority = uri.getAuthority();
        return !authority.equals(packageName) && !authority.startsWith(packageName + ".") &&
            activity.checkUriPermission(uri, Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    private void openDocumentsFallback() {
        if (!documentsFallback) {
            documentsFallback = true;
            if (launch(backupRequest(Intent.ACTION_OPEN_DOCUMENT), "documents")) return;
        }
        finish(null);
    }

    private void finish(Uri uri) {
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        callback.onReceiveValue(uri == null ? null : new Uri[]{ uri });
    }
}
