#!/usr/bin/env python3
"""Exercise the pinned Frigate image with a synthetic RTSP camera and retained motion."""
import copy
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import run
import container


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    command = run.CONFIG["container"]["command"]
    if not shutil.which(command[0]):
        if os.environ.get("CI"):
            raise RuntimeError("The Frigate integration check requires an OCI runtime")
        print("Frigate container check requires the configured OCI runtime; native unit checks remain available.")
        return
    config = copy.deepcopy(run.CONFIG["container"])
    config["name"] = "frigate-fixture-" + uuid.uuid4().hex
    config["ports"]["api"]["origin"] = f"http://127.0.0.1:{port()}"
    container.prepare(config)
    camera_config = run.cameras_config()
    rtsp, metrics = port(), port()
    origin = config["ports"]["api"]["origin"]
    children = []
    with tempfile.TemporaryDirectory(prefix="frigate-check-") as directory:
        folder = Path(directory)
        log = open(folder / "fixture.log", "w+")
        try:
            subprocess.run([sys.executable, str(run.ROOT / "jomaa-cameras/build.py"), "--server"], check=True)
            native = copy.deepcopy(camera_config["server"])
            native.update(rtsp=True, rtspAddress=f"0.0.0.0:{rtsp}", rtspTransports=["tcp"],
                          hls=False, metrics=True, metricsAddress=f"127.0.0.1:{metrics}",
                          authInternalUsers=[{"user": "any", "permissions": [{"action": "publish"}, {"action": "read"}, {"action": "metrics"}]}],
                          paths={"camera1": {"source": "publisher"}}, pathDefaults={"sourceOnDemand": False})
            mtx_file = folder / "mediamtx.json"
            mtx_file.write_text(json.dumps(native))
            children.append(subprocess.Popen([str(run.ROOT / camera_config["mediaMtx"]["binaryFile"]), str(mtx_file)],
                                             cwd=folder, stdout=log, stderr=log))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path):
                with opener.open(origin + path, timeout=10) as response:
                    return response.read(), response.headers

            def wait_for(check, timeout=120):
                deadline = time.monotonic() + timeout
                while True:
                    try:
                        value = check()
                        if value:
                            return value
                    except (OSError, urllib.error.URLError, ValueError):
                        pass
                    if any(child.poll() is not None for child in children):
                        raise RuntimeError("A Frigate fixture process exited")
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Frigate fixture readiness timed out")
                    time.sleep(1)

            wait_for(lambda: opener.open(f"http://127.0.0.1:{metrics}/metrics", timeout=2).close() or True)
            children.append(subprocess.Popen([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10",
                "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-tune", "zerolatency",
                "-g", "10", "-f", "rtsp", "-rtsp_transport", "tcp", f"rtsp://127.0.0.1:{rtsp}/camera1"], stdout=log, stderr=log))
            runtime, secrets = run.runtime_config(run.CONFIG, camera_config,
                {camera_config["cameras"][0]["sourceEnv"]: f"rtsp://host.docker.internal:{rtsp}/camera1"})
            config_dir, media_dir = folder / "config", folder / "media"
            config_dir.mkdir()
            media_dir.mkdir()
            run.private_write(config_dir / run.CONFIG_NAME, json.dumps(runtime))
            env_file = folder / "container.env"
            run.private_write(env_file, "".join(f"{key}={value}\n" for key, value in secrets.items()))
            args = container.arguments(config, {run.CONFIG_MOUNT: config_dir, run.MEDIA_MOUNT: media_dir}, env_file)
            args[-1:-1] = ["--add-host", "host.docker.internal:host-gateway"]
            children.append(subprocess.Popen(args, stdout=log, stderr=log))
            version = wait_for(lambda: request("/api/version")[0])
            expected = config["image"].split("@")[0].rsplit(":", 1)[1]
            assert expected.encode() in version, "The pinned image must answer with its configured version"
            wait_for(lambda: json.loads(request("/api/stats")[0]).get("detectors", {}).get("cpu", {}).get("inference_speed", 0) > 0)
            after = time.time() - 180
            recordings = wait_for(lambda: json.loads(request(f"/api/camera1/recordings?after={after}&before={time.time()}")[0]))
            activity = wait_for(lambda: [item for item in json.loads(request(
                f"/api/review/activity/motion?cameras=camera1&after={after}&before={time.time()}&scale=60")[0]) if item["motion"] > 0])
            assert activity[0]["camera"] == "camera1"
            recording = recordings[-1]
            start, end = recording["start_time"], recording["end_time"]
            clip, headers = request(f"/api/camera1/start/{start}/end/{end}/clip.mp4")
            assert headers.get_content_type() == "video/mp4" and b"ftyp" in clip[:32]
            snapshot, headers = request(f"/api/camera1/recordings/{(start+end)/2}/snapshot.jpg")
            assert headers.get_content_type() == "image/jpeg" and snapshot.startswith(b"\xff\xd8")
            assert isinstance(json.loads(request("/api/events?cameras=camera1")[0]), list)
            print("Pinned Frigate image: inference, motion activity, recording playback and snapshot checks passed.")
        except Exception:
            log.flush()
            log.seek(0)
            print(log.read()[-16000:])
            raise
        finally:
            container.stop(config)
            for child in reversed(children):
                child.terminate()
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            log.close()
            subprocess.run([*config["command"], "run", "--rm", "--network=none", "--entrypoint=/bin/sh",
                            "--mount", f"type=bind,source={folder},target=/fixture", config["image"],
                            "-c", "rm -rf /fixture/config /fixture/media"], check=True, timeout=30)


if __name__ == "__main__":
    main()
