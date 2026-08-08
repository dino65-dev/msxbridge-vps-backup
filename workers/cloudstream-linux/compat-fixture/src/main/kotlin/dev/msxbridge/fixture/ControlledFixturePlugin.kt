package dev.msxbridge.fixture

import com.lagradost.cloudstream3.plugins.BasePlugin

/** A non-networked fixture used only to prove the compatibility loader lifecycle. */
class ControlledFixturePlugin : BasePlugin() {
    override fun load() {
        println("MSXBridge controlled CloudStream compatibility fixture loaded")
    }
}
