package io.github.saifutdinov.thread

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateTest {
    @Test
    fun versionsCompareByNumber() {
        assertTrue(Update.newer("0.24.0", "0.23.3"))
        assertTrue(Update.newer("0.23.10", "0.23.9"))
        assertFalse(Update.newer("0.23.3", "0.23.3"))
        assertFalse(Update.newer("0.23.2", "0.23.3"))
        assertFalse(Update.newer("1.0.0", "dev"))
        assertFalse(Update.newer("1.0", "0.9.0"))
    }
}
