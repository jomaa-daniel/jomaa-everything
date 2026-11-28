# Frigate configuration

[config.json](config.json) contains installation settings. Secrets stay in the
hub environment named by deployment settings. The shared camera definitions
come from the hub settings pointer; no camera source is repeated here.

- `hubSettingsFile`: Hub settings file relative to the release root; its cameraConfigFile supplies the shared camera list.
- `enabled`: Enables monitoring globally. A camera also needs its own monitoring.enabled and a configured source.
- `container`: OCI runtime, image, published ports, resources and lifecycle limits, used by the generic container helper.
- `container.command`: Runtime executable and leading arguments as a list; Docker and Podman are supported.
- `container.image`: Official Frigate image reference pinned by its multi-platform manifest digest.
- `container.name`: Unique container name on the installation.
- `container.ports`: Named private HTTP port mappings; every host origin must be loopback.
- `container.ports.api`: Frigate integration API port mapping.
- `container.ports.api.origin`: Loopback HTTP origin read by both the runtime and the hub proxy.
- `container.ports.api.containerPort`: Internal container API port.
- `container.sharedMemory`: Runtime shared-memory size, including frame buffers and Nginx caches.
- `container.tmpfs`: Container mount targets mapped to byte limits for temporary memory storage.
- `container.tmpfs./tmp/cache`: Bounded recording-segment cache; this is a native Frigate container path.
- `container.devices`: Explicit device mappings for configured accelerators; no devices are granted by default.
- `container.cpus`: Maximum container CPU allocation.
- `container.memory`: Maximum container memory allocation.
- `container.stopTimeoutSeconds`: Graceful container stop limit in seconds.
- `container.pullTimeoutSeconds`: Image preparation command timeout in seconds.
- `configDirectory`: Persistent Frigate configuration and database directory, absolute or with user-home expansion; it is created by the service outside release cleanup.
- `mediaDirectory`: Persistent recordings and snapshot directory, absolute or with user-home expansion; it is created by the service outside release cleanup.
- `environmentFile`: Private generated runtime environment file relative to the release root; source values are never committed.
- `health`: Monitoring supervisor health settings.
- `health.pollSeconds`: Interval for checking whether the foreground container process has exited.
- `health.requestTimeoutSeconds`: Timeout for a private API readiness request.
- `history`: Hub history query and media limits.
- `history.lookbackHours`: Length of each activity-query window in hours.
- `history.limit`: Maximum items returned in one activity page.
- `history.motionBucketSeconds`: Motion aggregation window in seconds; must fit a clip and an hour.
- `history.maxClipSeconds`: Maximum requested recording length and object-clip preview length in seconds.
- `history.maxMediaBytes`: Maximum bytes in a clip or snapshot response, including remote node forwarding.
- `history.requestTimeoutSeconds`: Private history and media request deadline in seconds.
- `engine`: Native Frigate configuration, combined with generated cameras. Added native settings must be documented here.
- `engine.mqtt`: Native MQTT configuration; this integration uses the HTTP API.
- `engine.mqtt.enabled`: Whether Frigate connects to MQTT.
- `engine.auth`: Native Frigate authentication configuration; the integration API is private and hub requests require Cameras access.
- `engine.auth.enabled`: Whether the unpublished Frigate authenticated UI requires its own login.
- `engine.detectors`: Native detector definitions; configure a supported backend for the installation hardware.
- `engine.detectors.cpu`: The named starter detector.
- `engine.detectors.cpu.type`: Native detector backend; the starter CPU backend needs no accelerator.
- `engine.detectors.cpu.num_threads`: CPU inference thread count.
- `engine.detect`: Native detection defaults, overridable per camera.
- `engine.detect.enabled`: Enables tracked-object detection.
- `engine.detect.width`: Detection frame width in pixels.
- `engine.detect.height`: Detection frame height in pixels.
- `engine.detect.fps`: Frames per second sent to motion and object processing.
- `engine.objects`: Native tracked-object configuration.
- `engine.objects.track`: Labels to track from the selected detector model’s label map.
- `engine.record`: Native recording policy; retention is time based and must fit available storage.
- `engine.record.enabled`: Enables recording.
- `engine.record.continuous`: Continuous recording retention.
- `engine.record.continuous.days`: Days of footage retained irrespective of motion.
- `engine.record.motion`: Motion recording retention.
- `engine.record.motion.days`: Days to retain footage containing motion.
- `engine.record.alerts`: Recording retention for native alert review items; no outbound alerts are configured.
- `engine.record.alerts.retain`: Alert recording retention policy.
- `engine.record.alerts.retain.days`: Days to retain matching alert footage.
- `engine.record.alerts.retain.mode`: Native retention mode selecting all, motion or active-object footage.
- `engine.record.detections`: Recording retention for native detection review items.
- `engine.record.detections.retain`: Detection recording retention policy.
- `engine.record.detections.retain.days`: Days to retain matching detection footage.
- `engine.record.detections.retain.mode`: Native retention mode for detection footage.
- `engine.snapshots`: Native snapshot policy.
- `engine.snapshots.enabled`: Saves object snapshots.
- `engine.snapshots.timestamp`: Draws capture time on snapshots.
- `engine.snapshots.bounding_box`: Draws the detected object bounding box.
- `engine.snapshots.retain`: Snapshot retention policy.
- `engine.snapshots.retain.default`: Default number of days to retain object snapshots.

The generated native camera inputs use Frigate environment substitution. Source
credentials are written only to the private runtime environment file. Configure
camera-specific native settings under the camera component’s monitoring.config
and document added settings in that component’s config.md.

The service declaration in [deploy.json](deploy.json) owns the service
health endpoint and deployment commands; its standard fields are documented in
[deployment configuration](../jomaa-deploy/config.md). It publishes no routes.
