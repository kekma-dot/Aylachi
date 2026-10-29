#!/usr/bin/env python3
"""Generate/check the deterministic 64x64 RGBA placeholder dev icon (stdlib only)."""
import hashlib
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(__file__).with_name("icon.png")

def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xffffffff)

def png() -> bytes:
    rows = []
    for y in range(64):
        row = bytearray([0])
        for x in range(64):
            dx, dy = max(16 - x, 0, x - 47), max(16 - y, 0, y - 47)
            bg = (24, 31, 48, 255) if dx * dx + dy * dy <= 12 * 12 else (0, 0, 0, 0)
            glyph = (23 <= x <= 27 and 23 <= y <= 43) or (37 <= x <= 41 and 23 <= y <= 43) or (27 <= x <= 37 and 31 <= y <= 35)
            row.extend((232, 169, 79, 255) if glyph else bg)
        rows.append(bytes(row))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 64, 64, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))

def main() -> None:
    expected = png()
    if "--check" in sys.argv:
        actual = OUT.read_bytes()
        if actual != expected:
            raise SystemExit("icon differs from deterministic generator")
    else:
        OUT.write_bytes(expected)
    print(hashlib.sha256(expected).hexdigest())

if __name__ == "__main__":
    main()
