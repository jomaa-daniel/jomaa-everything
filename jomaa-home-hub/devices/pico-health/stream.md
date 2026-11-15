# Raw I²C capture settings

`stream.json` configures active reads of attached I²C devices. Sampling runs on the Pico's second core while the first core sends captures and health reports over verified HTTPS. Each bus has a bounded pending buffer. A full buffer counts discarded samples in `dropped`; empty intervals need no data buffer. Uploads reuse their sequence until acknowledged.
Health and capture uploads share one verified TLS connection. Each response is fully consumed before the next request; errors close the connection and trigger a retry.

| Setting                   | Meaning                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buses`                   | I²C controllers sampled by this Pico.                                                                                                                |
| `buses[].id`              | Hardware I²C controller identifier.                                                                                                                  |
| `buses[].sda`             | GPIO used for SDA.                                                                                                                                   |
| `buses[].scl`             | GPIO used for SCL.                                                                                                                                   |
| `buses[].registers`       | Map from hexadecimal device address to starting register for a register read. Devices without an entry receive a direct raw read.                    |
| `frequencyHz`             | I²C clock frequency.                                                                                                                                 |
| `timeoutUs`               | I²C transaction timeout in microseconds.                                                                                                             |
| `sampleMilliseconds`      | Delay between sampling passes.                                                                                                                       |
| `scanMilliseconds`        | Interval between address scans on each configured bus.                                                                                               |
| `readBytes`               | Bytes requested from each responding address per sampling pass. The sensor's protocol determines whether it needs a register or measurement command. |
| `uploadMilliseconds`      | Minimum delay between capture uploads; networking can make it longer.                                                                                |
| `idleMilliseconds`        | Main loop delay while waiting for a report deadline.                                                                                                 |
| `retrySeconds`            | Initial delay after a failed network report.                                                                                                         |
| `retryMaxSeconds`         | Maximum delay after consecutive network failures.                                                                                                    |
| `joinTimeoutMilliseconds` | Native Wi-Fi connection deadline.                                                                                                                    |
| `joinPollMilliseconds`    | Native Wi-Fi connection check interval.                                                                                                              |
| `lowHeapBytes`            | Free heap threshold that marks a health report degraded.                                                                                             |
| `socketTimeoutSeconds`    | Native socket request timeout.                                                                                                                       |
| `requestTimeoutSeconds`   | Deadline for each request on the external radio TCP stream, including the initial TLS handshake.                                                     |
| `maxResponseBytes`        | Maximum response body and HTTP headers accepted by the Pico.                                                                                         |
| `maxStatusLineBytes`      | Maximum HTTP status line accepted by the Pico.                                                                                                       |

Provisioning reads `i2c.maxDataBytes` from the hub's committed `settings.json` and includes it as `maxDataBytes` in the installed stream settings. This bounds each pending bus buffer and matches the receiver's request contract.

Each successful read contributes its address byte, a two-byte big-endian data length, and the unmodified sensor bytes to the capture. The reserved length `0xffff` is followed by an error code: read failure or scan failure. These records indicate failed capture, and increment `dropped`. A capture with no responding addresses has an empty data string. The live device view shows the complete hexadecimal capture; `i2c_logs` retains a lossless compressed representation.
