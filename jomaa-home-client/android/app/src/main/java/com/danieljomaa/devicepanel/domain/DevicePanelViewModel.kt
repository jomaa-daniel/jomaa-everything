package com.danieljomaa.devicepanel.domain

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.danieljomaa.devicepanel.data.CachedTarget
import com.danieljomaa.devicepanel.data.ColorPreset
import com.danieljomaa.devicepanel.data.CommandRequest
import com.danieljomaa.devicepanel.data.DevicePanelApi
import com.danieljomaa.devicepanel.data.DevicePanelException
import com.danieljomaa.devicepanel.data.Features
import com.danieljomaa.devicepanel.data.MatterNode
import com.danieljomaa.devicepanel.data.MatterSetupCode
import com.danieljomaa.devicepanel.data.RoomChanges
import com.danieljomaa.devicepanel.data.RoomState
import com.danieljomaa.devicepanel.data.Session
import com.danieljomaa.devicepanel.data.SessionStore
import com.danieljomaa.devicepanel.data.SharedStateStore
import com.danieljomaa.devicepanel.data.SyncRequest
import com.danieljomaa.devicepanel.data.Target
import com.danieljomaa.devicepanel.data.validateServerUrl
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl

sealed interface AuthenticationPhase {
    data object Checking : AuthenticationPhase
    data object SigningIn : AuthenticationPhase
    data object SignedOut : AuthenticationPhase
    data object SignedIn : AuthenticationPhase
}

enum class ConnectionPhase(val label: String) {
    IDLE("Not connected"),
    LOADING("Loading"),
    CONNECTED("Connected"),
    APPLYING("Applying"),
    STALE("Last known state"),
    FAILED("Command failed"),
}

data class MatterUiState(
    val nodes: List<MatterNode> = emptyList(),
    val loading: Boolean = false,
    val pairing: Boolean = false,
    val pairedNodeId: ULong? = null,
    val error: String? = null,
)

data class DevicePanelUiState(
    val authentication: AuthenticationPhase = AuthenticationPhase.Checking,
    val connection: ConnectionPhase = ConnectionPhase.IDLE,
    val targets: List<Target> = emptyList(),
    val selected: CachedTarget? = null,
    val room: RoomState? = null,
    val serverUrl: String = "",
    val powerBusy: Boolean = false,
    val error: String? = null,
    val canRetryCommand: Boolean = false,
    val matter: MatterUiState = MatterUiState(),
) {
    val features: Features get() = selected?.features ?: Features.POWER_ONLY
}

class DevicePanelViewModel(
    private val api: DevicePanelApi,
    private val sessionStore: SessionStore,
    private val stateStore: SharedStateStore,
    private val resetOnStart: Boolean = false,
    private val reconcileDelaysMs: List<Long> = listOf(3_000, 6_000, 10_000, 15_000),
) : ViewModel() {
    private val mutableState = MutableStateFlow(DevicePanelUiState())
    val state: StateFlow<DevicePanelUiState> = mutableState.asStateFlow()

    private val commandMutex = Mutex()
    private var baseUrl: HttpUrl? = null
    private var session: Session? = null
    private var confirmedRoom: RoomState? = null
    private var latestRevision = 0L
    private var lastFailedChanges: RoomChanges? = null
    private var reconcileJob: Job? = null

    init {
        viewModelScope.launch { start() }
    }

    suspend fun start() {
        if (resetOnStart) {
            sessionStore.clear()
            stateStore.reset()
        }
        stateStore.selectedTarget()?.let { cached ->
            val room = cached.state?.let(RoomState::from)
            confirmedRoom = room
            mutableState.update { it.copy(selected = cached, room = room, connection = ConnectionPhase.STALE) }
        }
        val savedUrl = stateStore.serverUrl()
        mutableState.update { it.copy(serverUrl = savedUrl.orEmpty()) }
        val storedSession = sessionStore.load()
        if (savedUrl == null || storedSession == null) {
            mutableState.update { it.copy(authentication = AuthenticationPhase.SignedOut) }
            return
        }
        try {
            baseUrl = validateServerUrl(savedUrl)
            session = storedSession
            mutableState.update { it.copy(authentication = AuthenticationPhase.SignedIn) }
            refresh()
        } catch (error: Exception) {
            mutableState.update {
                it.copy(
                    authentication = AuthenticationPhase.SignedOut,
                    error = error.userMessage(),
                    connection = ConnectionPhase.FAILED,
                )
            }
        }
    }

    fun signIn(serverUrl: String, password: String) = viewModelScope.launch {
        if (mutableState.value.authentication == AuthenticationPhase.SigningIn) return@launch
        mutableState.update { it.copy(authentication = AuthenticationPhase.SigningIn, error = null) }
        try {
            val validated = validateServerUrl(serverUrl)
            val newSession = api.signIn(validated, password)
            sessionStore.save(newSession)
            val label = validated.toString().removeSuffix("/")
            stateStore.saveServerUrl(label)
            baseUrl = validated
            session = newSession
            mutableState.update { it.copy(authentication = AuthenticationPhase.SignedIn, serverUrl = label) }
            refresh()
        } catch (error: Exception) {
            mutableState.update {
                it.copy(
                    authentication = AuthenticationPhase.SignedOut,
                    connection = ConnectionPhase.FAILED,
                    error = error.userMessage(),
                )
            }
        }
    }

    /** Reloads the device list and the selected target's state. */
    suspend fun refresh() = commandMutex.withLock {
        val url = baseUrl ?: return@withLock
        val token = session?.token ?: return@withLock
        mutableState.update {
            it.copy(
                connection = if (it.room == null) ConnectionPhase.LOADING else ConnectionPhase.APPLYING,
                error = null,
            )
        }
        try {
            val targets = api.targets(url, token)
            val current = mutableState.value.selected?.id
            val chosen = targets.firstOrNull { it.id == current }
                ?: targets.firstOrNull(Target::isRoom)
                ?: targets.firstOrNull()
            mutableState.update { it.copy(targets = targets) }
            if (chosen == null) {
                mutableState.update { it.copy(selected = null, room = null, connection = ConnectionPhase.CONNECTED) }
                return@withLock
            }
            loadState(url, token, chosen)
        } catch (error: Exception) {
            handle(error)
        }
    }

    fun refreshFromUi() = viewModelScope.launch { refresh() }

    fun select(targetId: String) = viewModelScope.launch {
        commandMutex.withLock {
            val url = baseUrl ?: return@withLock
            val token = session?.token ?: return@withLock
            val target = mutableState.value.targets.firstOrNull { it.id == targetId } ?: return@withLock
            reconcileJob?.cancel()
            lastFailedChanges = null
            mutableState.update { it.copy(connection = ConnectionPhase.LOADING, error = null, canRetryCommand = false) }
            try {
                loadState(url, token, target)
            } catch (error: Exception) {
                handle(error)
            }
        }
    }

    private suspend fun loadState(url: HttpUrl, token: String, target: Target) {
        val response = api.state(url, token, target.id)
        val light = response.state ?: throw DevicePanelException.DevicesFailed(response.failed)
        // Keep the color or white picked here, which the hub doesn't report.
        val previous = mutableState.value.room.takeIf { mutableState.value.selected?.id == target.id }
        val room = RoomState.from(light).copy(color = previous?.color, white = previous?.white ?: false)
        val cached = CachedTarget(target.id, target.name, target.features, light)
        confirmedRoom = room
        stateStore.saveSelectedTarget(cached)
        mutableState.update {
            it.copy(
                selected = cached,
                room = room,
                connection = if (response.failed.isEmpty()) ConnectionPhase.CONNECTED else ConnectionPhase.STALE,
                error = response.failed.takeIf { f -> f.isNotEmpty() }
                    ?.let { f -> DevicePanelException.DevicesFailed(f).message },
            )
        }
    }

    fun setPower(on: Boolean) = viewModelScope.launch {
        mutableState.update { it.copy(powerBusy = true) }
        apply(RoomChanges(on = on))
        mutableState.update { it.copy(powerBusy = false) }
    }

    fun setBrightness(value: Int) = viewModelScope.launch { apply(RoomChanges(brightness = value)) }

    fun setColor(color: ColorPreset) = viewModelScope.launch { apply(RoomChanges(color = color)) }

    fun setTemperature(value: Int) = viewModelScope.launch { apply(RoomChanges(colorTemperaturePct = value)) }

    fun retryLastCommand() = viewModelScope.launch {
        val changes = lastFailedChanges
        if (changes != null) apply(changes) else refresh()
    }

    fun clearError() {
        mutableState.update {
            it.copy(error = null, connection = if (it.room == null) ConnectionPhase.IDLE else ConnectionPhase.STALE)
        }
    }

    fun signOut() = viewModelScope.launch {
        reconcileJob?.cancel()
        val url = baseUrl
        val token = session?.token
        if (url != null && token != null) runCatching { api.signOut(url, token) }
        sessionStore.clear()
        session = null
        baseUrl = null
        confirmedRoom = null
        lastFailedChanges = null
        mutableState.value = DevicePanelUiState(
            authentication = AuthenticationPhase.SignedOut,
            serverUrl = stateStore.serverUrl().orEmpty(),
        )
    }

    fun loadMatterNodes() = viewModelScope.launch {
        val url = baseUrl ?: return@launch
        val token = session?.token ?: return@launch
        mutableState.update { it.copy(matter = it.matter.copy(loading = true, error = null)) }
        try {
            val nodes = api.matterNodes(url, token)
            mutableState.update { it.copy(matter = it.matter.copy(nodes = nodes, loading = false)) }
        } catch (error: Exception) {
            mutableState.update { it.copy(matter = it.matter.copy(loading = false, error = error.userMessage())) }
            if (error is DevicePanelException.AuthenticationRequired) handle(error)
        }
    }

    /** Pairs a Matter device through the hub, using its QR payload or manual code. */
    fun pair(code: String, networkOnly: Boolean) = viewModelScope.launch {
        val url = baseUrl ?: return@launch
        val token = session?.token ?: return@launch
        val normalized = MatterSetupCode.normalize(code)
        if (normalized == null) {
            mutableState.update {
                it.copy(matter = it.matter.copy(error = "Enter the 11-digit setup code or the MT: code from the QR label."))
            }
            return@launch
        }
        mutableState.update { it.copy(matter = it.matter.copy(pairing = true, pairedNodeId = null, error = null)) }
        try {
            val nodeId = api.commission(url, token, normalized, networkOnly)
            mutableState.update { it.copy(matter = it.matter.copy(pairing = false, pairedNodeId = nodeId)) }
            loadMatterNodes()
        } catch (error: Exception) {
            mutableState.update { it.copy(matter = it.matter.copy(pairing = false, error = error.userMessage())) }
            if (error is DevicePanelException.AuthenticationRequired) handle(error)
        }
    }

    fun clearPairingResult() {
        mutableState.update { it.copy(matter = it.matter.copy(pairedNodeId = null, error = null)) }
    }

    private suspend fun apply(changes: RoomChanges) = commandMutex.withLock {
        val url = baseUrl ?: return@withLock handle(DevicePanelException.AuthenticationRequired)
        val token = session?.token ?: return@withLock handle(DevicePanelException.AuthenticationRequired)
        val target = mutableState.value.selected ?: return@withLock
        val before = mutableState.value.room ?: return@withLock
        val optimistic = before.applying(changes)
        val revision = stateStore.nextRevision()
        latestRevision = revision
        mutableState.update {
            it.copy(room = optimistic, connection = ConnectionPhase.APPLYING, error = null, canRetryCommand = false)
        }
        lastFailedChanges = null

        try {
            api.command(url, token, target.id, CommandRequest.from(changes, stateStore.clientId(), revision))
            confirmedRoom = optimistic
            stateStore.saveSelectedTarget(target.copy(state = optimistic.toLightState()))
            mutableState.update { it.copy(connection = ConnectionPhase.CONNECTED) }
            startReconciliation(target.id, target.features, revision)
        } catch (error: Exception) {
            lastFailedChanges = changes
            mutableState.update { it.copy(room = confirmedRoom ?: before, canRetryCommand = true) }
            handle(error)
        }
    }

    private fun startReconciliation(targetId: String, features: Features, revision: Long) {
        reconcileJob?.cancel()
        if (reconcileDelaysMs.isEmpty()) return
        reconcileJob = viewModelScope.launch {
            for (wait in reconcileDelaysMs) {
                delay(wait)
                if (revision != latestRevision) return@launch
                val room = mutableState.value.room ?: return@launch
                val url = baseUrl ?: return@launch
                val token = session?.token ?: return@launch
                try {
                    val response = api.sync(
                        url,
                        token,
                        targetId,
                        SyncRequest(
                            clientId = stateStore.clientId(),
                            revision = revision,
                            on = room.on,
                            brightness = room.brightness.takeIf { room.on && features.brightness && it > 0 },
                            // Only check white if white was picked here; otherwise
                            // this would undo a color.
                            colorTemperaturePct = room.colorTemperaturePct.takeIf {
                                room.on && room.white && features.colorTemperature
                            },
                        ),
                    )
                    if (response.stale || revision != latestRevision) return@launch
                    if (response.synchronized) {
                        mutableState.update { it.copy(connection = ConnectionPhase.CONNECTED) }
                        return@launch
                    }
                } catch (error: Exception) {
                    if (error is DevicePanelException.AuthenticationRequired) {
                        handle(error)
                        return@launch
                    }
                    mutableState.update { it.copy(connection = ConnectionPhase.STALE, error = error.userMessage()) }
                }
            }
            if (revision == latestRevision) {
                mutableState.update { it.copy(connection = ConnectionPhase.STALE) }
            }
        }
    }

    private suspend fun handle(error: Exception) {
        Log.e("DevicePanel", "Hub request failed", error)
        if (error is DevicePanelException.AuthenticationRequired) {
            sessionStore.clear()
            session = null
            mutableState.update { it.copy(authentication = AuthenticationPhase.SignedOut) }
        }
        mutableState.update {
            it.copy(
                connection = if (error is DevicePanelException.Offline) ConnectionPhase.STALE else ConnectionPhase.FAILED,
                error = error.userMessage(),
            )
        }
    }
}

internal fun RoomState.toLightState() =
    com.danieljomaa.devicepanel.data.LightState(on, brightness, colorTemperaturePct)

internal fun Exception.userMessage(): String =
    (this as? DevicePanelException)?.message ?: "The hub couldn't complete the request."
