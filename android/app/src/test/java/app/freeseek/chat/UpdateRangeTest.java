package app.freeseek.chat;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpdateRangeTest {
    @Test public void acceptsOnlyTheRemainingBytesOfThePublishedPackage() {
        assertTrue(UpdatePlugin.validRange("bytes 400-999/1000", 600, 400, 999, 1000));
        assertTrue(UpdatePlugin.validRange("bytes 400-999/1000", -1, 400, 999, 1000));
        assertFalse(UpdatePlugin.validRange("bytes 399-999/1000", 601, 400, 999, 1000));
        assertFalse(UpdatePlugin.validRange("bytes 400-999/1001", 600, 400, 999, 1000));
        assertFalse(UpdatePlugin.validRange("bytes 400-999/1000", 599, 400, 999, 1000));
        assertFalse(UpdatePlugin.validRange("bytes 400-899/1000", 500, 400, 999, 1000));
        assertFalse(UpdatePlugin.validRange(null, 600, 400, 999, 1000));
    }

    @Test public void acceptsABoundedSampleOrAResponseThatContinuesToTheEnd() {
        assertTrue(UpdatePlugin.validRange("bytes 400-499/1000", 100, 400, 499, 1000));
        assertTrue(UpdatePlugin.validRange("bytes 400-999/1000", 600, 400, 499, 1000));
        assertFalse(UpdatePlugin.validRange("bytes 400-398/1000", -1, 400, 499, 1000));
    }
}
