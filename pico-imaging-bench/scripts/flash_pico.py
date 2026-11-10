#!/usr/bin/env python3
"""Validate and copy a trusted UF2 onto an explicitly selected BOOTSEL volume."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import struct
import sys

from common import BenchError

FAMILIES = {"rp2040": 0xE48BFF56, "rp2350": 0xE48BFF59}


def validate_uf2(source: Path, digest: str, chip: str):
    if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise BenchError("provide the trusted firmware SHA-256 digest")
    payload = source.read_bytes()
    if hashlib.sha256(payload).hexdigest() != digest.lower():
        raise BenchError("firmware SHA-256 does not match")
    if not payload or len(payload) % 512:
        raise BenchError("invalid UF2 length")
    count = len(payload) // 512
    addresses = []
    blocks = set()
    for offset in range(0, len(payload), 512):
        magic0, magic1, flags, address, size, number, total, family = struct.unpack_from("<8I", payload, offset)
        end = struct.unpack_from("<I", payload, offset + 508)[0]
        if (magic0, magic1, end) != (0x0A324655, 0x9E5D5157, 0x0AB16F30):
            raise BenchError("invalid UF2 magic")
        if flags != 0x2000 or family != FAMILIES[chip]:
            raise BenchError("UF2 is not ordinary flash firmware for the selected chip")
        if not 0 < size <= 476 or total != count or number >= count or number in blocks:
            raise BenchError("invalid UF2 block layout")
        if address < 0x10000000 or address + size > 0x11000000:
            raise BenchError("UF2 flash address is outside the supported Pico flash range")
        blocks.add(number)
        addresses.append((address, address + size))
    addresses.sort()
    if any(a[1] > b[0] for a, b in zip(addresses, addresses[1:])):
        raise BenchError("overlapping UF2 flash blocks")
    return {"sha256": digest.lower(), "chip": chip, "bytes": len(payload), "blocks": count}


def validate_volume(volume: Path, chip: str):
    info = volume / "INFO_UF2.TXT"
    if not volume.is_dir() or not info.is_file() or info.is_symlink():
        raise BenchError("selected directory is not a BOOTSEL volume with INFO_UF2.TXT")
    text = info.read_text().upper()
    expected = "RPI-RP2" in text and "RP2350" not in text if chip == "rp2040" else "RP2350" in text
    if not expected:
        raise BenchError("BOOTSEL volume does not match the selected chip")


def flash(source: Path, digest: str, volume: Path, chip: str):
    # Validate immediately before writing as well as during the plan stage.
    result = validate_uf2(source, digest, chip)
    validate_volume(volume, chip)
    destination = volume / "firmware.uf2"
    if destination.is_symlink():
        raise BenchError("UF2 destination must not be a symlink")
    with source.open("rb") as firmware, destination.open("wb") as output:
        while True:
            chunk = firmware.read(65536)
            if not chunk:
                break
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uf2", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--bootsel-volume", type=Path, required=True)
    parser.add_argument("--chip", choices=FAMILIES, default="rp2040")
    parser.add_argument("--execute", action="store_true", help="copy UF2 and restart the board")
    args = parser.parse_args(argv)
    try:
        result = validate_uf2(args.uf2, args.sha256, args.chip)
        validate_volume(args.bootsel_volume, args.chip)
        if args.execute:
            flash(args.uf2, args.sha256, args.bootsel_volume, args.chip)
            print("UF2 copied; verify the returning serial port before provisioning.")
        else:
            print("Validated %d firmware blocks. Add --execute to flash the selected volume." % result["blocks"])
        return 0
    except (BenchError, OSError) as error:
        print("Flash failed: " + (str(error) if isinstance(error, BenchError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
