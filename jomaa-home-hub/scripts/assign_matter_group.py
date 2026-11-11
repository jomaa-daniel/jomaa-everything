#!/usr/bin/env python3
"""Assign a paired Matter node's configured light endpoints to a room."""

import json
import sys
from pathlib import Path

from onboard_lights import HubError, locked_layout, register, save_layout, unique_id, validate_layout


def assign(config: Path, root: Path, node_id: int, endpoints: list[int], name: str, group_id: str | None) -> dict:
    with locked_layout(config) as (path, previous, layout):
        room = next((room for room in layout.get("rooms", []) if room["id"] == group_id), None)
        if group_id is not None and room is None:
            raise ValueError("selected group does not exist")
        devices = [device for device in layout.get("devices", [])
                   if device["driver"] == "matter" and device["nodeId"] == node_id]
        if not devices and group_id is not None:
            if not endpoints:
                raise ValueError("this device has no light or plug endpoints")
            for endpoint in endpoints:
                label = name if len(endpoints) == 1 else f"{name} {endpoint}"
                device = {"driver": "matter", "id": unique_id(label, layout), "name": label,
                          "nodeId": node_id, "endpoint": endpoint}
                layout = register(layout, device, None, None)
                devices.append(device)
        ids = [device["id"] for device in devices]
        for candidate in layout.get("rooms", []):
            candidate["members"] = [member for member in candidate["members"] if member not in ids]
            if candidate["id"] == group_id:
                candidate["members"].extend(ids)
        validate_layout(root, layout)
        save_layout(path, previous, layout)
        return layout


if __name__ == "__main__":
    try:
        body = json.load(sys.stdin)
        result = assign(Path(sys.argv[1]), Path(sys.argv[2]), body["nodeId"], body["endpoints"],
                        body["name"], body["groupId"])
        print(json.dumps(result))
    except (HubError, ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
