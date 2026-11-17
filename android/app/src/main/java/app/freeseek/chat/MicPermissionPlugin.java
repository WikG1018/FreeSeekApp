package app.freeseek.chat;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 麦克风权限：WebView 的 getUserMedia 要求 RECORD_AUDIO 已授权。
 * Capacitor 的 WebChromeClient 在收到 AUDIO_CAPTURE 请求时会同时申请
 * RECORD_AUDIO 与 MODIFY_AUDIO_SETTINGS，两者只要有一个被拒就会整体 deny，
 * 所以这里提供显式申请入口，被拒时还能跳系统设置页让用户手动开启。
 */
@CapacitorPlugin(
    name = "MicPermission",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class MicPermissionPlugin extends Plugin {

    @PluginMethod
    public void check(PluginCall call) {
        PermissionState state = getPermissionState("microphone");
        JSObject result = new JSObject();
        result.put("granted", state == PermissionState.GRANTED);
        result.put("state", state.toString());
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        DiagnosticsLog.record(getContext(), "speech", "microphone.requested", new JSObject());
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            respond(call, true);
            return;
        }
        requestPermissionForAlias("microphone", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        respond(call, getPermissionState("microphone") == PermissionState.GRANTED);
    }

    /** 打开本应用的系统权限页，用户可手动开启麦克风 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private void respond(PluginCall call, boolean granted) {
        JSObject meta = new JSObject(); meta.put("granted", granted);
        DiagnosticsLog.record(getContext(), "speech", "microphone.result", meta);
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }
}
