package app.freeseek.chat;

import static android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN;
import static android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BackupFilePickerTest {
    @Test public void recognizesZipExtensionsAndMimeTypesFromDifferentWebViews() {
        assertTrue(BackupFilePicker.isBackupInput(MODE_OPEN, false, new String[]{".zip"}));
        assertTrue(BackupFilePicker.isBackupInput(MODE_OPEN, false,
            new String[]{".zip", "application/zip", "application/x-zip-compressed"}));
        assertTrue(BackupFilePicker.isBackupInput(MODE_OPEN, false, new String[]{" APPLICATION/ZIP "}));
    }

    @Test public void leavesPhotosAttachmentsAndMultiTypeImportsWithCapacitor() {
        assertFalse(BackupFilePicker.isBackupInput(MODE_OPEN, false, new String[]{"image/*"}));
        assertFalse(BackupFilePicker.isBackupInput(MODE_OPEN, false, new String[]{".zip", ".json"}));
        assertFalse(BackupFilePicker.isBackupInput(MODE_OPEN, false, new String[0]));
        assertFalse(BackupFilePicker.isBackupInput(MODE_OPEN, true, new String[]{".zip"}));
        assertFalse(BackupFilePicker.isBackupInput(MODE_OPEN_MULTIPLE, false, new String[]{".zip"}));
    }
}
