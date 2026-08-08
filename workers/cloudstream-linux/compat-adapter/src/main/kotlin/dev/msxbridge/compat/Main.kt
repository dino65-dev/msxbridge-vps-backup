package dev.msxbridge.compat

import com.lagradost.cloudstream3.APIHolder
import com.lagradost.cloudstream3.LoadResponse
import com.lagradost.cloudstream3.MainAPI
import com.lagradost.cloudstream3.MainPageRequest
import com.lagradost.cloudstream3.MovieLoadResponse
import com.lagradost.cloudstream3.MovieSearchResponse
import com.lagradost.cloudstream3.SearchResponse
import com.lagradost.cloudstream3.SubtitleFile
import com.lagradost.cloudstream3.TvSeriesLoadResponse
import com.lagradost.cloudstream3.TvSeriesSearchResponse
import com.lagradost.cloudstream3.utils.ExtractorLink
import com.lagradost.runtime.loader.ExtensionLoader
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import java.io.File
import java.nio.file.Path
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipFile
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable

private const val maxPluginBytes = 32L * 1024L * 1024L
private const val maxArchiveBytes = 64L * 1024L * 1024L
private const val providerTimeoutMs = 20_000L
private val executionPool = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "plugin-execution").apply { isDaemon = true } }

@Serializable private data class ExecuteRequest(val fileName: String)
@Serializable private data class ProviderRequest(val providerId: String)
@Serializable private data class CatalogRequest(val providerId: String, val page: Int = 1)
@Serializable private data class SearchRequest(val providerId: String, val query: String, val page: Int = 1)
@Serializable private data class RefRequest(val providerId: String, val ref: String)
@Serializable private data class PluginInspection(val fileName: String, val sha256: String, val pluginClassName: String, val status: String)
@Serializable private data class ErrorResponse(val error: String)

@Serializable private data class WireItem(
    val ref: String, val title: String, val kind: String, val overview: String? = null,
    val year: Int? = null, val season: Int? = null, val episode: Int? = null,
    val durationSeconds: Int? = null, val posterUrl: String? = null, val backdropUrl: String? = null,
    val logoUrl: String? = null, val tags: List<String>? = null, val rating: Double? = null,
)
@Serializable private data class CatalogPage(val title: String, val items: List<WireItem>, val hasNext: Boolean)
@Serializable private data class CatalogResponse(val provider: String, val pages: List<CatalogPage>)
@Serializable private data class SearchResponseDto(val provider: String, val items: List<WireItem>, val hasNext: Boolean)
@Serializable private data class DetailsDto(val provider: String, val item: WireItem, val episodes: List<WireItem>, val seasons: List<Int>)
@Serializable private data class SubtitleDto(val id: String, val language: String, val url: String, val format: String)
@Serializable private data class LinkDto(
    val id: String, val url: String, val protocol: String, val container: String,
    val videoCodec: String, val audioCodec: String, val height: Int? = null,
    val headers: Map<String, String> = emptyMap(), val subtitles: List<SubtitleDto> = emptyList(),
)
@Serializable private data class LinksDto(val provider: String, val links: List<LinkDto>)

private class PluginGate(private val pluginDirectory: File, private val fixtureDirectory: File, allowlist: String) {
    private val allowedHashes = allowlist.split(',').map { it.trim().lowercase() }.filter { it.matches(Regex("[0-9a-f]{64}")) }.toSet()
    fun plugin(fileName: String): File = resolve(pluginDirectory, fileName)
    fun fixture(): File = File(fixtureDirectory, "controlled-fixture.cs3").also { require(it.isFile) { "controlled fixture is missing" } }
    fun inspect(file: File): PluginInspection {
        require(file.length() in 1..maxPluginBytes) { "plugin must be between 1 byte and 32 MiB" }
        var className: String? = null
        var unpacked = 0L
        ZipFile(file).use { archive ->
            archive.entries().asSequence().forEach { entry ->
                require(!entry.name.startsWith('/') && !entry.name.contains("..") && !entry.name.contains('\\')) { "archive has an unsafe path" }
                if (!entry.isDirectory) { unpacked += entry.size.coerceAtLeast(0); require(unpacked <= maxArchiveBytes) { "archive expands beyond 64 MiB" } }
            }
            val manifest = archive.getEntry("manifest.json") ?: error("manifest.json is required")
            val text = archive.getInputStream(manifest).bufferedReader().use { it.readText() }
            className = Regex("\\\"pluginClassName\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").find(text)?.groupValues?.get(1)
        }
        require(!className.isNullOrBlank()) { "manifest.json must contain pluginClassName" }
        return PluginInspection(file.name, sha256(file), className!!, "accepted")
    }
    fun allowed(inspection: PluginInspection): Boolean = inspection.sha256 in allowedHashes
    private fun resolve(root: File, fileName: String): File {
        require(Path.of(fileName).fileName.toString() == fileName) { "fileName must not include a path" }
        val candidate = File(root, fileName).canonicalFile
        require(candidate.parentFile == root.canonicalFile && candidate.isFile) { "plugin does not exist" }
        return candidate
    }
}

private fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }

private fun loadPluginWithTimeout(plugin: File, timeoutMs: Long = 15_000): Long {
    val startedAt = System.nanoTime()
    val task = executionPool.submit(Callable { ExtensionLoader.loadAndInit(plugin) })
    try { task.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (error: TimeoutException) { task.cancel(true); throw TimeoutException("plugin load exceeded ${timeoutMs}ms; sidecar restart required") }
    return (System.nanoTime() - startedAt) / 1_000_000
}

private fun kind(type: Any?): String = if (type?.toString()?.contains("Series", ignoreCase = true) == true) "series" else "movie"
@Suppress("DEPRECATION_ERROR")
private fun wire(response: SearchResponse): WireItem = WireItem(
    ref = response.url, title = response.name, kind = kind(response.type), posterUrl = response.posterUrl,
    year = when (response) { is MovieSearchResponse -> response.year; is TvSeriesSearchResponse -> response.year; else -> null },
)
@Suppress("DEPRECATION_ERROR")
private fun wire(response: LoadResponse, ref: String = response.url): WireItem = WireItem(
    ref = ref, title = response.name, kind = kind(response.type), overview = response.plot, year = response.year,
    durationSeconds = response.duration?.times(60), posterUrl = response.posterUrl, backdropUrl = response.backgroundPosterUrl,
    logoUrl = response.logoUrl, tags = response.tags?.take(12),
)
@Suppress("DEPRECATION_ERROR")
private fun wireEpisode(episode: com.lagradost.cloudstream3.Episode, fallbackPoster: String?): WireItem = WireItem(
    ref = episode.data, title = episode.name ?: "Episode ${episode.episode ?: ""}", kind = "episode",
    season = episode.season, episode = episode.episode, durationSeconds = episode.runTime,
    posterUrl = episode.posterUrl ?: fallbackPoster, overview = episode.description,
)

private class ProviderRuntime(private val gate: PluginGate, private val fileName: String, private val workDirectory: File) {
    private var loadedHash: String? = null
    private var loadedPath: String? = null
    private var provider: MainAPI? = null
    private var providerName: String? = null

    @Synchronized private fun provider(requestedId: String): MainAPI {
        require(requestedId in setOf("MovieBoxProvider", "MovieBox")) { "only MovieBoxProvider is enabled" }
        val plugin = gate.plugin(fileName)
        val inspection = gate.inspect(plugin)
        require(gate.allowed(inspection)) { "plugin SHA-256 is not allowlisted" }
        if (provider == null || loadedHash != inspection.sha256) {
            loadedPath?.let { ExtensionLoader.unloadPlugin(it) }
            // ExtensionLoader creates a .dex and a converted -jvm.jar beside the
            // archive. The verified plugin volume is intentionally read-only, so
            // stage the exact verified bytes into this sidecar's writable tmpfs.
            workDirectory.mkdirs()
            val staged = File(workDirectory, "${inspection.sha256}.cs3")
            Files.copy(plugin.toPath(), staged.toPath(), StandardCopyOption.REPLACE_EXISTING)
            File(workDirectory, "${inspection.sha256}.dex").delete()
            File(workDirectory, "${inspection.sha256}-jvm.jar").delete()
            loadPluginWithTimeout(staged)
            provider = APIHolder.apis.firstOrNull { it.sourcePlugin == staged.absolutePath }
                ?: error("plugin loaded but did not register a MainAPI")
            providerName = provider!!.name
            loadedHash = inspection.sha256
            loadedPath = staged.absolutePath
        }
        return provider!!
    }

    fun name(requestedId: String): String = provider(requestedId).name
    fun load(requestedFileName: String) {
        require(requestedFileName == fileName) { "only the configured MovieBox plugin can execute" }
        // Use the same verified tmpfs staging path as catalog/search/links.
        // ExtensionLoader writes converted artifacts beside the archive.
        provider("MovieBoxProvider")
    }
    fun catalog(request: CatalogRequest): CatalogResponse = runBlocking {
        val api = provider(request.providerId)
        withTimeout(providerTimeoutMs) {
            val pages = api.mainPage.map { pageData ->
                val response = api.getMainPage(request.page.coerceAtLeast(1), MainPageRequest(pageData.name, pageData.data, pageData.horizontalImages))
                CatalogPage(pageData.name, response?.items?.flatMap { it.list }?.map(::wire) ?: emptyList(), response?.hasNext == true)
            }
            CatalogResponse(api.name, pages)
        }
    }
    fun search(request: SearchRequest): SearchResponseDto = runBlocking {
        require(request.query.isNotBlank() && request.query.length <= 120) { "valid query is required" }
        val api = provider(request.providerId)
        withTimeout(providerTimeoutMs) { api.search(request.query, request.page.coerceAtLeast(1)).let { SearchResponseDto(api.name, it?.items?.map(::wire) ?: emptyList(), it?.hasNext == true) } }
    }
    fun details(request: RefRequest): DetailsDto = runBlocking {
        val api = provider(request.providerId)
        withTimeout(providerTimeoutMs) {
            val loaded = api.load(request.ref) ?: error("provider returned no details")
            val episodes = (loaded as? TvSeriesLoadResponse)?.episodes?.map { wireEpisode(it, loaded.posterUrl) } ?: emptyList()
            DetailsDto(api.name, wire(loaded), episodes, episodes.mapNotNull { it.season }.distinct().sorted())
        }
    }
    fun links(request: RefRequest): LinksDto = runBlocking {
        val api = provider(request.providerId)
        withTimeout(providerTimeoutMs) {
            val links = mutableListOf<ExtractorLink>(); val subtitles = mutableListOf<SubtitleFile>()
            api.loadLinks(request.ref, false, { subtitles.add(it) }, { links.add(it) })
            val subtitleDtos = subtitles.distinctBy { it.url }.mapIndexed { index, sub -> SubtitleDto("sub-$index", sub.lang, sub.url, when { sub.url.contains(".vtt", true) -> "vtt"; sub.url.contains(".ass", true) -> "ass"; else -> "srt" }) }
            LinksDto(api.name, links.distinctBy { it.url }.mapIndexed { index, link ->
                val hls = link.isM3u8
                LinkDto("link-$index", link.url, if (hls) "hls" else "mp4", if (hls) "mpegts" else "mp4", "unknown", "unknown", if (link.quality > 0) link.quality else null, link.getAllHeaders(), subtitleDtos)
            })
        }
    }
}

fun main() {
    val pluginDirectory = File(System.getenv("PLUGIN_DIR") ?: "/var/lib/msxbridge/plugins")
    val fixtureDirectory = File(System.getenv("FIXTURE_DIR") ?: "/opt/msxbridge-fixtures")
    val gate = PluginGate(pluginDirectory, fixtureDirectory, System.getenv("PLUGIN_ALLOWLIST_SHA256") ?: "")
    val runtime = ProviderRuntime(gate, System.getenv("MOVIEBOX_PLUGIN_FILE") ?: "MovieBoxProvider.cs3", File(System.getenv("PLUGIN_WORK_DIR") ?: "/tmp/plugin-runtime"))
    val port = (System.getenv("PORT") ?: "8082").toInt()
    embeddedServer(Netty, port = port, host = "0.0.0.0") {
        install(ContentNegotiation) { json() }
        routing {
            get("/v1/health") { call.respond(mapOf("status" to "ok", "runtime" to "phisher98-compat-sidecar", "upstreamCommit" to "5fdb86da1f1b0de982547947bf69ff7edf0d1056", "provider" to "MovieBoxProvider", "arbitraryExecution" to "allowlist-only")) }
            post("/v1/plugins/inspect") { try { val plugin = gate.plugin(call.receive<ExecuteRequest>().fileName); call.respond(gate.inspect(plugin)) } catch (error: Exception) { call.respond(HttpStatusCode.BadRequest, ErrorResponse(error.message ?: "invalid plugin")) } }
            post("/v1/plugins/execute") { try { val request = call.receive<ExecuteRequest>(); val plugin = gate.plugin(request.fileName); val inspection = gate.inspect(plugin); if (!gate.allowed(inspection)) { call.respond(HttpStatusCode.Forbidden, ErrorResponse("plugin SHA-256 is not allowlisted")); return@post }; runtime.load(request.fileName); call.respond(inspection.copy(status = "loaded")) } catch (error: TimeoutException) { call.respond(HttpStatusCode.GatewayTimeout, ErrorResponse(error.message ?: "plugin timed out")) } catch (error: Exception) { call.respond(HttpStatusCode.BadRequest, ErrorResponse(error.message ?: "plugin failed")) } }
            post("/v1/catalog") { try { call.respond(runtime.catalog(call.receive<CatalogRequest>())) } catch (error: Exception) { error.printStackTrace(); call.respond(HttpStatusCode.BadGateway, ErrorResponse(error.message ?: "catalog failed")) } }
            post("/v1/search") { try { call.respond(runtime.search(call.receive<SearchRequest>())) } catch (error: Exception) { error.printStackTrace(); call.respond(HttpStatusCode.BadGateway, ErrorResponse(error.message ?: "search failed")) } }
            post("/v1/details") { try { call.respond(runtime.details(call.receive<RefRequest>())) } catch (error: Exception) { error.printStackTrace(); call.respond(HttpStatusCode.BadGateway, ErrorResponse(error.message ?: "details failed")) } }
            post("/v1/links") { try { call.respond(runtime.links(call.receive<RefRequest>())) } catch (error: Exception) { error.printStackTrace(); call.respond(HttpStatusCode.BadGateway, ErrorResponse(error.message ?: "links failed")) } }
            post("/v1/fixtures/execute") { try { val fixture = gate.fixture(); val inspection = gate.inspect(fixture); loadPluginWithTimeout(fixture); call.respond(inspection.copy(status = "loaded-controlled-fixture")) } catch (error: Exception) { call.respond(HttpStatusCode.InternalServerError, ErrorResponse(error.message ?: "fixture failed")) } }
        }
    }.start(wait = true)
}
