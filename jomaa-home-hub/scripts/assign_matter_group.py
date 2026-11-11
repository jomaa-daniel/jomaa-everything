#!/usr/bin/env python3
"""Edit room definitions and configured light membership."""

import json
import sys
from pathlib import Path

from onboard_lights import HubError, locked_layout, register, save_layout, unique_id, validate_layout


def assign(config: Path, root: Path, node_id: int | None, endpoints: list[int], name: str, group_ids: list[str], target_ids: list[str]) -> dict:
    with locked_layout(config) as (path, previous, layout):
        if any(group_id not in {room["id"] for room in layout.get("rooms", [])} for group_id in group_ids):
            raise ValueError("selected group does not exist")
        devices = [device for device in layout.get("devices", [])
                   if (node_id is not None and device["driver"] == "matter" and device["nodeId"] == node_id)
                   or (node_id is None and device["id"] in target_ids)]
        if not devices and group_ids and node_id is not None:
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
            if candidate["id"] in group_ids:
                candidate["members"].extend(ids)
        validate_layout(root, layout)
        save_layout(path, previous, layout)
        return layout


def edit_group(config: Path, root: Path, action: str, group_id: str | None, name: str) -> dict:
    with locked_layout(config) as (path, previous, layout):
        if action != "group.delete" and any(room["id"] != group_id and room["name"].casefold() == name.casefold() for room in layout["rooms"]):
            raise ValueError("Group name already exists")
        if action == "group.create":
            layout["rooms"].append({"id": unique_id(name, layout), "name": name, "members": []})
        else:
            room = next((room for room in layout["rooms"] if room["id"] == group_id), None)
            if room is None:
                raise ValueError("Group not found")
            if action == "group.rename":
                room["name"] = name
            elif action == "group.delete":
                layout["rooms"] = [room for room in layout["rooms"] if room["id"] != group_id]
                for parent in layout["rooms"]:
                    parent["members"] = [member for member in parent["members"] if member != group_id]
            else:
                raise ValueError("Unknown group action")
        validate_layout(root, layout)
        save_layout(path, previous, layout)
        return layout


if __name__ == "__main__":
    try:
        body = json.load(sys.stdin)
        if body["action"] == "assign":
            result = assign(Path(sys.argv[1]), Path(sys.argv[2]), body["nodeId"], body["endpoints"],
                            body["name"], body["groupIds"], body["targetIds"])
        else:
            result = edit_group(Path(sys.argv[1]), Path(sys.argv[2]), body["action"], body["id"], body["name"])
        print(json.dumps(result))
    except (HubError, ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
