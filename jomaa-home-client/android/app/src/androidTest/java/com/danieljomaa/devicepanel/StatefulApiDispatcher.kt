package com.danieljomaa.devicepanel

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject

/** An in-process stand-in for the hub's HTTP API: one room and one Matter plug. */
class StatefulApiDispatcher : Dispatcher() {
    data class Snapshot(
        val on: Boolean = false,
        val brightness: Int = 50,
        val colorTemperaturePct: Int = 50,
        val color: String? = null,
        val plugOn: Boolean = false,
        val pairedCodes: List<String> = emptyList(),
    )

    private val lock = Any()
    private var room = Snapshot()
    private var failNextCommand = false
    private var expireNextRequest = false
    private val paths = mutableListOf<String>()

    fun snapshot(): Snapshot = synchronized(lock) { room }

    fun paths(): List<String> = synchronized(lock) { paths.toList() }

    fun failNextCommand() = synchronized(lock) { failNextCommand = true }

    fun expireNextRequest() = synchronized(lock) { expireNextRequest = true }

    fun updateRoom(update: (Snapshot) -> Snapshot) = synchronized(lock) {
        room = update(room)
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.path.orEmpty().substringBefore('?')
        synchronized(lock) { paths += path }

        if (request.method == "POST" && path == "/api/login") {
            val password = JSONObject(request.body.readUtf8()).optString("password")
            return if (password == "test-pass") json(200, """{"token":"android-test-token"}""")
            else json(401, """{"error":"wrong password"}""")
        }
        if (request.getHeader("Authorization") != "Bearer android-test-token") {
            return json(401, """{"error":"sign in first"}""")
        }
        val expire = synchronized(lock) { expireNextRequest.also { expireNextRequest = false } }
        if (expire) return json(401, """{"error":"sign in first"}""")

        return when (request.method to path) {
            "GET" to "/api/targets" -> json(200, TARGETS)
            "GET" to "/api/targets/living-room/state" -> json(200, stateJson(roomLight()))
            "GET" to "/api/targets/desk-plug/state" -> json(200, stateJson(plugLight()))
            "POST" to "/api/targets/living-room/command" -> command(request) { body ->
                room = room.copy(
                    on = if (body.has("on")) body.getBoolean("on") else room.on,
                    brightness = if (body.has("brightness")) body.getInt("brightness") else room.brightness,
                    colorTemperaturePct = if (body.has("colorTemperaturePct")) body.getInt("colorTemperaturePct") else room.colorTemperaturePct,
                    color = when {
                        body.has("color") -> body.getString("color")
                        body.has("colorTemperaturePct") -> null
                        else -> room.color
                    },
                )
            }
            "POST" to "/api/targets/desk-plug/command" -> command(request) { body ->
                if (body.has("on")) room = room.copy(plugOn = body.getBoolean("on"))
            }
            "POST" to "/api/targets/living-room/sync",
            "POST" to "/api/targets/desk-plug/sync",
            -> json(200, """{"synchronized":true,"stale":false,"corrected":{},"failed":{},"observed":{}}""")
            "GET" to "/api/matter/nodes" -> json(
                200,
                """{"nodes":[{"nodeId":2,"available":true,"isBridge":false,"vendor":"Acme","product":"Plug","label":null}]}""",
            )
            "POST" to "/api/matter/commission" -> {
                val code = JSONObject(request.body.readUtf8()).getString("code")
                synchronized(lock) { room = room.copy(pairedCodes = room.pairedCodes + code) }
                json(200, """{"node":{"node_id":7,"available":true,"is_bridge":false}}""")
            }
            "POST" to "/api/logout" -> json(200, """{"ok":true}""")
            else -> json(404, """{"error":"not found"}""")
        }
    }

    private fun command(request: RecordedRequest, apply: (JSONObject) -> Unit): MockResponse {
        val fail = synchronized(lock) { failNextCommand.also { failNextCommand = false } }
        if (fail) return json(502, """{"ok":false,"failed":{"lamp-b":"device did not respond"}}""")
        val body = JSONObject(request.body.readUtf8())
        synchronized(lock) { apply(body) }
        return json(200, """{"ok":true}""")
    }

    private fun roomLight(): String {
        val value = snapshot()
        return """{"on":${value.on},"brightness":${value.brightness},"colorTemperaturePct":${value.colorTemperaturePct}}"""
    }

    private fun plugLight() = """{"on":${snapshot().plugOn},"brightness":0,"colorTemperaturePct":0}"""

    private fun stateJson(light: String) = """{"state":$light,"devices":{},"failed":{}}"""

    private fun json(status: Int, body: String) = MockResponse()
        .setResponseCode(status)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private companion object {
        const val TARGETS = """{"targets":[
            {"id":"desk-plug","name":"Desk Plug","kind":"matter","features":{"brightness":false,"colorTemperature":false,"color":false}},
            {"id":"living-room","name":"Living Room","kind":"room","members":["desk-plug"],
             "features":{"brightness":true,"colorTemperature":true,"color":true}}]}"""
    }
}
