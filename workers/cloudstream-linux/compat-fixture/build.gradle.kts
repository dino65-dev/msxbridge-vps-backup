plugins {
    kotlin("jvm")
}

dependencies {
    compileOnly(project(":library"))
}

tasks.jar {
    archiveFileName.set("controlled-fixture.cs3")
}
