package app.freeseek.chat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FontScalePlugin.class);
        registerPlugin(MicPermissionPlugin.class);
        registerPlugin(DonatePlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
