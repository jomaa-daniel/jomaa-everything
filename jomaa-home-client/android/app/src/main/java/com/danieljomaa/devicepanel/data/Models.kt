package com.danieljomaa.devicepanel.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.Locale

/**
 * What a device or room can change. Matter devices report this from the
 * clusters they expose; a plug, for example, has none of these.
 */
@Serializable
data class Features(
    val brightness: Boolean,
    val colorTemperature: Boolean,
    val color: Boolean,
) {
    companion object {
        /** Power only: nothing else can change. */
        val POWER_ONLY = Features(brightness = false, colorTemperature = false, color = false)
    }
}

/**
 * A device or room the hub controls. kind is "room" or the driver behind it.
 */
@Serializable
data class Target(
    val id: String,
    val name: String,
    val kind: String,
    val features: Features,
) {
    val isRoom: Boolean get() = kind == "room"
}

@Serializable
data class TargetList(val targets: List<Target>)

/** Brightness and colorTemperaturePct are 0-100; 0 means warmest white. */
@Serializable
data class LightState(
    val on: Boolean,
    val brightness: Int,
    val colorTemperaturePct: Int,
) {
    init {
        require(brightness in 0..100) { "brightness must be from 0 to 100" }
        require(colorTemperaturePct in 0..100) { "colorTemperaturePct must be from 0 to 100" }
    }
}

/**
 * A target's summary state plus each device's own. state is null when no
 * device under the target answered.
 */
@Serializable
data class StateResponse(
    val state: LightState?,
    val devices: Map<String, LightState>,
    val failed: Map<String, String>,
)

/** A color, sent to the hub as "#rrggbb". */
enum class ColorPreset(val label: String, val rgb: Int) {
    RED("Red", 0xFF0000),
    ORANGE("Orange", 0xFF8000),
    ;

    val hex: String get() = String.format(Locale.US, "#%06x", rgb)
}

/**
 * What the room should look like right now, as this app last set it. The hub
 * doesn't report color, so color and white are only known once picked here.
 */
data class RoomState(
    val on: Boolean,
    val brightness: Int,
    val colorTemperaturePct: Int,
    val color: ColorPreset? = null,
    val white: Boolean = false,
) {
    fun applying(changes: RoomChanges): RoomState = copy(
        on = changes.on ?: on,
        brightness = changes.brightness ?: brightness,
        colorTemperaturePct = changes.colorTemperaturePct ?: colorTemperaturePct,
        color = when {
            changes.color != null -> changes.color
            changes.colorTemperaturePct != null -> null
            else -> color
        },
        white = when {
            changes.colorTemperaturePct != null -> true
            changes.color != null -> false
            else -> white
        },
    )

    companion object {
        fun from(state: LightState) = RoomState(state.on, state.brightness, state.colorTemperaturePct)
    }
}

data class RoomChanges(
    val on: Boolean? = null,
    val brightness: Int? = null,
    val colorTemperaturePct: Int? = null,
    val color: ColorPreset? = null,
) {
    init {
        require(on != null || brightness != null || colorTemperaturePct != null || color != null) {
            "A command must contain a change"
        }
        brightness?.let { require(it in 1..100) }
        colorTemperaturePct?.let { require(it in 0..100) }
        require(color == null || colorTemperaturePct == null) {
            "Color and temperature cannot change together"
        }
    }
}

@Serializable
data class LoginRequest(val password: String)

@Serializable
data class LoginResponse(val token: String)

@Serializable
data class CommandRequest(
    val on: Boolean? = null,
    val brightness: Int? = null,
    val colorTemperaturePct: Int? = null,
    val color: String? = null,
    val clientId: String,
    val revision: Long,
) {
    companion object {
        fun from(changes: RoomChanges, clientId: String, revision: Long) = CommandRequest(
            on = changes.on,
            brightness = changes.brightness,
            colorTemperaturePct = changes.colorTemperaturePct,
            color = changes.color?.hex,
            clientId = clientId,
            revision = revision,
        )
    }
}

@Serializable
data class SyncRequest(
    val clientId: String,
    val revision: Long,
    val on: Boolean,
    val brightness: Int? = null,
    val colorTemperaturePct: Int? = null,
)

@Serializable
data class SyncResponse(
    val synchronized: Boolean,
    val stale: Boolean,
    val corrected: Map<String, List<String>>,
    val failed: Map<String, String>,
)

@Serializable
data class MatterNode(
    val nodeId: ULong,
    val available: Boolean,
    val isBridge: Boolean,
    val vendor: String?,
    val product: String?,
    val label: String?,
) {
    val displayName: String
        get() = listOfNotNull(vendor, product, label).joinToString(" ").ifBlank { "Matter device" }
}

@Serializable
data class MatterNodeList(val nodes: List<MatterNode>)

@Serializable
data class CommissionRequest(val code: String, val networkOnly: Boolean)

@Serializable
data class CommissionedNode(@SerialName("node_id") val nodeId: ULong)

@Serializable
data class CommissionResponse(val node: CommissionedNode)

@Serializable
data class ApiErrorPayload(
    val error: String?,
)

/** The devices that didn't take a command, keyed by device id. */
@Serializable
data class CommandResponse(val failed: Map<String, String>)

/** Checks a Matter setup code before it goes to the hub. */
object MatterSetupCode {
    private val manual = Regex("""^\d{11}$|^\d{21}$""")

    /** Returns the cleaned code, or null if it isn't a QR payload or manual code. */
    fun normalize(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.startsWith("MT:") && trimmed.length > 3) return trimmed
        val digits = trimmed.replace("-", "").replace(" ", "")
        return digits.takeIf { manual.matches(it) }
    }
}

sealed class DevicePanelException(message: String) : Exception(message) {
    data object InvalidServerUrl : DevicePanelException("Enter a valid hub address, like http://192.168.1.10:8080.")
    data object InvalidCredentials : DevicePanelException("Incorrect password.")
    data object AuthenticationRequired : DevicePanelException("Your session has ended. Sign in again.")
    data object Offline : DevicePanelException("Can't reach the hub. Check that you're on your home network.")
    data object TimedOut : DevicePanelException("The hub took too long to respond.")
    data object MatterUnavailable : DevicePanelException("The hub isn't connected to its Matter server.")
    data class DevicesFailed(val failed: Map<String, String>) :
        DevicePanelException("${failed.size} device(s) didn't respond: ${failed.keys.sorted().joinToString()}")
    data class Server(val status: Int, override val message: String?) :
        DevicePanelException(message ?: "The hub couldn't complete the request (HTTP $status).")
    data object InvalidResponse : DevicePanelException("The hub returned an unexpected response.")
    data object SecureStorage : DevicePanelException("Secure storage is unavailable.")
}
