plugins {
    kotlin("jvm") version "2.1.20"
    application
    kotlin("plugin.serialization") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    implementation("io.ktor:ktor-server-core-jvm:3.1.2")
    implementation("io.ktor:ktor-server-netty-jvm:3.1.2")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:3.1.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:3.1.2")
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(21) }
application { mainClass.set("dev.msxbridge.worker.MainKt") }
