plugins {
    kotlin("jvm")
    kotlin("plugin.serialization") version "2.3.20"
    application
}

dependencies {
    implementation(project(":plugin-runtime"))
    // The upstream runtime's public load API returns BasePlugin, but the
    // upstream module keeps :library implementation-only. Depend explicitly
    // so this adapter has the API it invokes at compile and runtime.
    implementation(project(":library"))
    implementation(project(":android-stubs"))
    implementation(project(":common"))
    implementation("io.ktor:ktor-server-core-jvm:3.1.2")
    implementation("io.ktor:ktor-server-netty-jvm:3.1.2")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:3.1.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:3.1.2")
    implementation("ch.qos.logback:logback-classic:1.5.18")
}

application {
    mainClass.set("dev.msxbridge.compat.MainKt")
}
