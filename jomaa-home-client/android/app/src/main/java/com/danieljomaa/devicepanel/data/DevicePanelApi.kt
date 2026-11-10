package com.danieljomaa.devicepanel.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The hub's HTTP API. Every device looks the same here, whatever brand it is:
 * the hub speaks Matter (and anything else) on the app's behalf.
 */
interface DevicePanelApi {
    suspend fun signIn(baseUrl: HttpUrl, password: String): Session
    suspend fun signOut(baseUrl: HttpUrl, token: String)
    suspend fun targets(baseUrl: HttpUrl, token: String): List<Target>
    suspend fun state(baseUrl: HttpUrl, token: String, targetId: String): StateResponse
    suspend fun command(baseUrl: HttpUrl, token: String, targetId: String, request: CommandRequest)
    suspend fun sync(baseUrl: HttpUrl, token: String, targetId: String, request: SyncRequest): SyncResponse
    suspend fun matterNodes(baseUrl: HttpUrl, token: String): List<MatterNode>
    suspend fun commission(baseUrl: HttpUrl, token: String, code: String, networkOnly: Boolean): ULong
}

class OkHttpDevicePanelApi(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build(),
    allowedHosts: Set<String>? = null,
) : DevicePanelApi {
    private val allowedHosts = allowedHosts?.map(String::lowercase)?.toSet()
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = false
    }
    private val mediaType = "application/json; charset=utf-8".toMediaType()

    // Pairing a Matter device can take a few minutes; the hub allows five.
    private val pairingClient by lazy {
        client.newBuilder().readTimeout(6, TimeUnit.MINUTES).callTimeout(6, TimeUnit.MINUTES).build()
    }

    override suspend fun signIn(baseUrl: HttpUrl, password: String): Session {
        val response: LoginResponse = execute(
            baseUrl,
            listOf("api", "login"),
            "POST",
            body = json.encodeToString(LoginRequest(password)),
            unauthorizedError = DevicePanelException.InvalidCredentials,
        )
        return Session(response.token)
    }

    override suspend fun signOut(baseUrl: HttpUrl, token: String) {
        execute<Map<String, Boolean>>(baseUrl, listOf("api", "logout"), "POST", token)
    }

    override suspend fun targets(baseUrl: HttpUrl, token: String): List<Target> =
        execute<TargetList>(baseUrl, listOf("api", "targets"), "GET", token).targets

    override suspend fun state(baseUrl: HttpUrl, token: String, targetId: String): StateResponse =
        execute(baseUrl, listOf("api", "targets", targetId, "state"), "GET", token)

    override suspend fun command(baseUrl: HttpUrl, token: String, targetId: String, request: CommandRequest) {
        execute<Map<String, Boolean>>(
            baseUrl,
            listOf("api", "targets", targetId, "command"),
            "POST",
            token,
            json.encodeToString(request),
        )
    }

    override suspend fun sync(baseUrl: HttpUrl, token: String, targetId: String, request: SyncRequest): SyncResponse =
        execute(baseUrl, listOf("api", "targets", targetId, "sync"), "POST", token, json.encodeToString(request))

    override suspend fun matterNodes(baseUrl: HttpUrl, token: String): List<MatterNode> =
        execute<MatterNodeList>(baseUrl, listOf("api", "matter", "nodes"), "GET", token).nodes

    override suspend fun commission(baseUrl: HttpUrl, token: String, code: String, networkOnly: Boolean): ULong {
        val response: CommissionResponse = execute(
            baseUrl,
            listOf("api", "matter", "commission"),
            "POST",
            token,
            json.encodeToString(CommissionRequest(code, networkOnly)),
            httpClient = pairingClient,
        )
        return response.node.nodeId
    }

    private suspend inline fun <reified T> execute(
        baseUrl: HttpUrl,
        path: List<String>,
        method: String,
        token: String? = null,
        body: String? = null,
        unauthorizedError: DevicePanelException = DevicePanelException.AuthenticationRequired,
        httpClient: OkHttpClient = client,
    ): T = withContext(Dispatchers.IO) {
        perform(httpClient, baseUrl, path, method, token, body).use {
            validate(it, unauthorizedError)
            val value = it.body?.string() ?: throw DevicePanelException.InvalidResponse
            try {
                json.decodeFromString<T>(value)
            } catch (error: Exception) {
                throw DevicePanelException.InvalidResponse
            }
        }
    }

    private suspend fun perform(
        httpClient: OkHttpClient,
        baseUrl: HttpUrl,
        path: List<String>,
        method: String,
        token: String?,
        body: String?,
    ): Response {
        if (allowedHosts != null && baseUrl.host.lowercase() !in allowedHosts) {
            throw DevicePanelException.InvalidServerUrl
        }
        val url = baseUrl.newBuilder().apply { path.forEach(::addPathSegment) }.build()
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        token?.let { builder.header("Authorization", "Bearer $it") }
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post((body ?: "{}").toRequestBody(mediaType))
            else -> error("Unsupported HTTP method")
        }
        return try {
            httpClient.newCall(builder.build()).await()
        } catch (error: SocketTimeoutException) {
            throw DevicePanelException.TimedOut
        } catch (error: IOException) {
            throw DevicePanelException.Offline
        }
    }

    private fun validate(response: Response, unauthorizedError: DevicePanelException) {
        if (response.isSuccessful) {
            val type = response.header("Content-Type").orEmpty().lowercase()
            if (!type.contains("application/json")) throw DevicePanelException.InvalidResponse
            return
        }
        val payload = response.body?.string()?.let {
            runCatching { json.decodeFromString<ApiErrorPayload>(it) }.getOrNull()
        }
        throw when {
            response.code == 401 -> unauthorizedError
            response.code == 502 && !payload?.failed.isNullOrEmpty() -> DevicePanelException.DevicesFailed(payload!!.failed!!)
            response.code == 503 -> DevicePanelException.MatterUnavailable
            else -> DevicePanelException.Server(response.code, payload?.error)
        }
    }
}

/**
 * Accepts https anywhere, and plain http only for addresses on the home
 * network: loopback, private IPv4 ranges, link-local, ".local" names and
 * single-label host names. The hub normally runs on the LAN without TLS.
 */
fun validateServerUrl(value: String): HttpUrl {
    val url = value.trim().toHttpUrlOrNull() ?: throw DevicePanelException.InvalidServerUrl
    if (!url.isHttps && !isLocalHost(url.host)) throw DevicePanelException.InvalidServerUrl
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null) {
        throw DevicePanelException.InvalidServerUrl
    }
    if (url.pathSegments.any { it.isNotEmpty() }) throw DevicePanelException.InvalidServerUrl
    return url
}

internal fun isLocalHost(host: String): Boolean {
    val h = host.lowercase().removePrefix("[").removeSuffix("]")
    if (h == "localhost" || h.endsWith(".local")) return true
    if (h.contains(':')) return h == "::1" || h.startsWith("fe80:") || h.startsWith("fd") || h.startsWith("fc")
    val octets = h.split(".").map { it.toIntOrNull() ?: return !h.contains('.') && !h.contains(':') }
    if (octets.size != 4 || octets.any { it !in 0..255 }) return false
    val (a, b) = octets
    return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }

        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) continuation.resume(response)
        }
    })
}
