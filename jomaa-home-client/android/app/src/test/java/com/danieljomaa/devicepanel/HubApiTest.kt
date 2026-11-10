package com.danieljomaa.devicepanel

import com.danieljomaa.devicepanel.data.ColorPreset
import com.danieljomaa.devicepanel.data.CommandRequest
import com.danieljomaa.devicepanel.data.DevicePanelException
import com.danieljomaa.devicepanel.data.Features
import com.danieljomaa.devicepanel.data.MatterSetupCode
import com.danieljomaa.devicepanel.data.OkHttpDevicePanelApi
import com.danieljomaa.devicepanel.data.RoomChanges
import com.danieljomaa.devicepanel.data.RoomState
import com.danieljomaa.devicepanel.data.SyncRequest
import com.danieljomaa.devicepanel.data.validateServerUrl
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HubApiTest {
    private lateinit var server: MockWebServer
    private lateinit var base: HttpUrl
    private val api = OkHttpDevicePanelApi()

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        base = server.url("/")
    }

    @After
    fun tearDown() = server.shutdown()

    private fun json(status: Int, body: String) = server.enqueue(
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body),
    )

    private fun body(): JsonObject = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun signInPostsPasswordAndReturnsToken() = runBlocking {
        json(200, """{"token":"abc123"}""")
        val session = api.signIn(base, "hunter2")
        val request = server.takeRequest()
        assertEquals("/api/login", request.path)
        assertEquals("""{"password":"hunter2"}""", request.body.readUtf8())
        assertEquals("abc123", session.token)
    }

    @Test
    fun wrongPasswordIsReported() {
        json(401, """{"error":"wrong password"}""")
        val error = runCatching { runBlocking { api.signIn(base, "nope") } }.exceptionOrNull()
        assertEquals(DevicePanelException.InvalidCredentials, error)
    }

    @Test
    fun targetsAndStateDecodeTheHubShape() = runBlocking {
        json(
            200,
            """{"targets":[{"id":"living-room","name":"Living Room","kind":"room","members":["lamp"],
               "features":{"brightness":true,"colorTemperature":true,"color":false}},
               {"id":"plug","name":"Plug","kind":"matter","features":{"brightness":false,"colorTemperature":false,"color":false}}]}""",
        )
        val targets = api.targets(base, "t")
        assertEquals("Bearer t", server.takeRequest().getHeader("Authorization"))
        assertTrue(targets[0].isRoom)
        assertEquals(Features.POWER_ONLY, targets[1].features)

        json(200, """{"state":{"on":true,"brightness":40,"colorTemperaturePct":10},"devices":{"lamp":{"on":true,"brightness":40,"colorTemperaturePct":10}},"failed":{}}""")
        val state = api.state(base, "t", "living-room")
        assertEquals("/api/targets/living-room/state", server.takeRequest().path)
        assertEquals(40, state.state?.brightness)

        json(200, """{"state":null,"devices":{},"failed":{"lamp":"offline"}}""")
        val silent = api.state(base, "t", "lamp")
        assertNull(silent.state)
        assertEquals(mapOf("lamp" to "offline"), silent.failed)
    }

    @Test
    fun responsesMissingFieldsTheHubAlwaysSendsAreRejected() {
        val missing = listOf<Pair<String, suspend () -> Unit>>(
            """{"targets":[{"id":"plug","name":"Plug","kind":"matter"}]}""" to { api.targets(base, "t") },
            """{"targets":[{"id":"plug","name":"Plug","kind":"matter","features":{"brightness":true}}]}""" to
                { api.targets(base, "t") },
            """{"state":{"on":true,"brightness":40,"colorTemperaturePct":10}}""" to { api.state(base, "t", "r") },
            """{"synchronized":true}""" to { api.sync(base, "t", "r", SyncRequest(clientId = "c", revision = 1, on = true)) },
            """{"node":{}}""" to { api.commission(base, "t", "34970112332", false) },
        )
        for ((body, call) in missing) {
            json(200, body)
            assertEquals(body, DevicePanelException.InvalidResponse, runCatching { runBlocking { call() } }.exceptionOrNull())
        }
    }

    @Test
    fun commandSendsOnlyChangedFieldsAndHexColor() = runBlocking {
        json(200, """{"ok":true}""")
        val changes = RoomChanges(color = ColorPreset.ORANGE)
        api.command(base, "t", "living-room", CommandRequest.from(changes, "phone", 7))
        val sent = body()
        assertEquals("#ff8000", sent["color"]!!.jsonPrimitive.content)
        assertEquals("phone", sent["clientId"]!!.jsonPrimitive.content)
        assertEquals(7, sent["revision"]!!.jsonPrimitive.int)
        assertEquals(setOf("color", "clientId", "revision"), sent.keys)
    }

    @Test
    fun partialFailureNamesTheDevices() {
        json(502, """{"ok":false,"failed":{"lamp-b":"timeout"}}""")
        val error = runCatching {
            runBlocking { api.command(base, "t", "living-room", CommandRequest.from(RoomChanges(on = true), "c", 1)) }
        }.exceptionOrNull()
        assertEquals(DevicePanelException.DevicesFailed(mapOf("lamp-b" to "timeout")), error)
    }

    @Test
    fun syncOmitsTemperatureWhenUnset() = runBlocking {
        json(200, """{"synchronized":true,"stale":false,"corrected":{},"failed":{},"observed":{}}""")
        val result = api.sync(base, "t", "r", SyncRequest(clientId = "c", revision = 3, on = true, brightness = 50))
        val sent = body()
        assertNull(sent["colorTemperaturePct"])
        assertTrue(sent["on"]!!.jsonPrimitive.boolean)
        assertTrue(result.synchronized)
    }

    @Test
    fun matterPairingAndNodes() = runBlocking {
        json(200, """{"node":{"node_id":7,"available":true,"is_bridge":false}}""")
        assertEquals(7uL, api.commission(base, "t", "MT:Y.K9042C00KA0648G00", true))
        val sent = body()
        assertEquals("MT:Y.K9042C00KA0648G00", sent["code"]!!.jsonPrimitive.content)
        assertTrue(sent["networkOnly"]!!.jsonPrimitive.boolean)

        json(200, """{"nodes":[{"nodeId":18446744065119617024,"available":false,"isBridge":false,"vendor":"Acme","product":"Bulb","label":null}]}""")
        val nodes = api.matterNodes(base, "t")
        assertEquals(18446744065119617024uL, nodes[0].nodeId)
        assertEquals("Acme Bulb", nodes[0].displayName)
    }

    @Test
    fun matterServerDownIsItsOwnError() {
        json(503, """{"error":"Matter controller is not running"}""")
        val error = runCatching { runBlocking { api.matterNodes(base, "t") } }.exceptionOrNull()
        assertEquals(DevicePanelException.MatterUnavailable, error)
    }

    @Test
    fun expiredSessionAndHtmlAreRejected() {
        json(401, """{"error":"sign in first"}""")
        assertEquals(
            DevicePanelException.AuthenticationRequired,
            runCatching { runBlocking { api.targets(base, "old") } }.exceptionOrNull(),
        )
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<html></html>"))
        assertEquals(
            DevicePanelException.InvalidResponse,
            runCatching { runBlocking { api.targets(base, "t") } }.exceptionOrNull(),
        )
    }

    @Test
    fun serverUrlAllowsHttpOnlyOnTheHomeNetwork() {
        for (ok in listOf("http://192.168.1.10:8080", "http://10.0.0.5", "http://hub.local:8080", "http://hub:8080",
            "http://127.0.0.1:8080", "https://hub.example.com")) {
            validateServerUrl(ok)
        }
        for (bad in listOf("http://hub.example.com", "http://8.8.8.8", "ftp://hub", "http://user:pw@hub.local",
            "http://hub.local/api", "http://hub.local?x=1", "http://fdroid.example.com")) {
            assertThrows(bad, DevicePanelException.InvalidServerUrl::class.java) { validateServerUrl(bad) }
        }
    }

    @Test
    fun loopbackOnlyClientRejectsExternalHostsBeforeNetwork() {
        val client = OkHttpDevicePanelApi(allowedHosts = setOf("localhost", "127.0.0.1", "::1"))
        val error = runCatching { runBlocking { client.targets("https://external.example".toHttpUrl(), "t") } }.exceptionOrNull()
        assertEquals(DevicePanelException.InvalidServerUrl, error)
    }

    @Test
    fun setupCodes() {
        assertEquals("34970112332", MatterSetupCode.normalize(" 3497-011-2332 "))
        assertEquals("MT:Y.K9042C00KA0648G00", MatterSetupCode.normalize("MT:Y.K9042C00KA0648G00"))
        assertNull(MatterSetupCode.normalize("1234"))
        assertNull(MatterSetupCode.normalize("MT:"))
    }

    @Test
    fun pickingAColorDropsTemperatureFromTheRoomState() {
        val white = RoomState(on = true, brightness = 50, colorTemperaturePct = 30)
        val red = white.applying(RoomChanges(color = ColorPreset.RED))
        assertEquals(ColorPreset.RED, red.color)
        assertNull(red.applying(RoomChanges(colorTemperaturePct = 60)).color)
        assertThrows(IllegalArgumentException::class.java) { RoomChanges(brightness = 0) }
    }

    @Test
    fun whiteIsOnlyKnownOnceItIsPickedHere() {
        val loaded = RoomState(on = true, brightness = 50, colorTemperaturePct = 30)
        assertFalse(loaded.white)
        assertFalse(loaded.applying(RoomChanges(brightness = 10)).white)
        val white = loaded.applying(RoomChanges(colorTemperaturePct = 60))
        assertTrue(white.white)
        assertTrue(white.applying(RoomChanges(on = false)).white)
        assertFalse(white.applying(RoomChanges(color = ColorPreset.ORANGE)).white)
    }
}
