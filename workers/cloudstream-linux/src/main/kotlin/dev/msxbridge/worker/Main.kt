package dev.msxbridge.worker

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipFile

@Serializable data class Health(val status: String, val runtime: String, val pluginDirectory: String)
@Serializable data class InspectRequest(val fileName: String)
@Serializable data class InspectResponse(
    val fileName: String,
    val validArchive: Boolean,
    val hasManifest: Boolean,
    val hasDex: Boolean,
    val pluginClassName: String? = null,
    val archiveBytes: Long = 0,
    val nextStep: String
)
@Serializable data class ResolveRequest(val pluginId: String, val mediaType: String, val mediaId: String, val season: Int? = null, val episode: Int? = null)
@Serializable data class ResolveResponse(val sources: List<ResolvedSource>, val status: String)
@Serializable data class ResolvedSource(val sourceId: String, val provider: String, val url: String, val protocol: String, val container: String, val videoCodec: String, val audioCodec: String)

private val pluginDirectory = Path.of(System.getenv("PLUGIN_DIR") ?: "/var/lib/msxbridge/plugins").toAbsolutePath().normalize()

private fun inspect(fileName: String): InspectResponse {
    val candidate = pluginDirectory.resolve(fileName).normalize()
    require(candidate.startsWith(pluginDirectory)) { "Plugin path escapes plugin directory" }
    require(Files.isRegularFile(candidate)) { "Plugin file not found" }
    require(Files.size(candidate) <= 32L * 1024 * 1024) { "Plugin archive exceeds 32 MiB limit" }
    ZipFile(candidate.toFile()).use { zip ->
        val manifest = zip.getEntry("manifest.json")
        val dex = zip.getEntry("classes.dex")
        val pluginClass = manifest?.let { entry ->
            zip.getInputStream(entry).bufferedReader().use { reader ->
                Regex("\\\"pluginClassName\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").find(reader.readText())?.groupValues?.get(1)
            }
        }
        return InspectResponse(
            fileName = fileName,
            validArchive = true,
            hasManifest = manifest != null,
            hasDex = dex != null,
            pluginClassName = pluginClass,
            archiveBytes = Files.size(candidate),
            nextStep = if (manifest != null && dex != null && pluginClass != null) "ready_for_dex_conversion" else "invalid_cloudstream_plugin"
        )
    }
}

fun Application.module() {
    install(ContentNegotiation) { json() }
    routing {
        get("/v1/health") { call.respond(Health("ok", "kotlin-jvm21-laboratory", pluginDirectory.toString())) }
        post("/v1/plugins/inspect") {
            try {
                call.respond(inspect(call.receive<InspectRequest>().fileName))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to (error.message ?: "invalid_request")))
            } catch (error: Exception) {
                call.respond(HttpStatusCode.UnprocessableEntity, mapOf("error" to "plugin_inspection_failed"))
            }
        }
        post("/v1/resolve") {
            call.receive<ResolveRequest>()
            call.respond(ResolveResponse(emptyList(), "laboratory_runtime_not_enabled"))
        }
    }
}

fun main() {
    Files.createDirectories(pluginDirectory)
    val port = (System.getenv("PORT") ?: "8081").toInt()
    embeddedServer(Netty, host = "0.0.0.0", port = port, module = Application::module).start(wait = true)
}
