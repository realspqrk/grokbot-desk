#!/usr/bin/env python3
"""Small PNG reader and pixel-difference checker for visual regression tests."""
from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PNGError(ValueError):
    """Raised when an image is malformed or outside the supported PNG subset."""


@dataclass(frozen=True)
class PNGImage:
    width: int
    height: int
    channels: int
    rows: tuple[bytes, ...]


def _paeth(left: int, up: int, up_left: int) -> int:
    estimate = left + up - up_left
    distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
    return (left, up, up_left)[distances.index(min(distances))]


def _unfilter(scanline: bytes, previous: bytes | None, channels: int, filter_type: int) -> bytes:
    if filter_type not in range(5):
        raise PNGError(f"unsupported PNG filter {filter_type}")
    result = bytearray(len(scanline))
    for index, encoded in enumerate(scanline):
        left = result[index - channels] if index >= channels else 0
        up = previous[index] if previous is not None else 0
        up_left = previous[index - channels] if previous is not None and index >= channels else 0
        if filter_type == 0:
            predictor = 0
        elif filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        else:
            predictor = _paeth(left, up, up_left)
        result[index] = (encoded + predictor) & 0xFF
    return bytes(result)


def read_png(path: str | Path) -> PNGImage:
    data = Path(path).read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise PNGError("invalid PNG signature")
    position = len(PNG_SIGNATURE)
    width = height = color_type = None
    compressed = bytearray()
    saw_end = False
    while position + 12 <= len(data):
        length = struct.unpack_from(">I", data, position)[0]
        position += 4
        kind = data[position : position + 4]
        position += 4
        payload = data[position : position + length]
        position += length
        if position + 4 > len(data):
            raise PNGError("truncated PNG chunk")
        expected_crc = struct.unpack_from(">I", data, position)[0]
        position += 4
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            raise PNGError(f"invalid {kind.decode('ascii', 'replace')} CRC")
        if kind == b"IHDR":
            if len(payload) != 13 or width is not None:
                raise PNGError("invalid IHDR")
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if width < 1 or height < 1:
                raise PNGError("invalid PNG dimensions")
            if depth != 8 or color_type not in (2, 6):
                raise PNGError("only 8-bit RGB/RGBA PNG files are supported")
            if compression or filtering or interlace:
                raise PNGError("compressed/interlaced PNG variant is unsupported")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            saw_end = True
            break
    if width is None or not compressed or not saw_end:
        raise PNGError("PNG is missing required chunks")
    channels = 3 if color_type == 2 else 4
    stride = width * channels
    try:
        raw = zlib.decompress(bytes(compressed))
    except zlib.error as error:
        raise PNGError(f"invalid PNG image data: {error}") from error
    if len(raw) != height * (stride + 1):
        raise PNGError("PNG scanline size does not match dimensions")
    rows = []
    previous = None
    position = 0
    for _ in range(height):
        filter_type = raw[position]
        position += 1
        row = _unfilter(raw[position : position + stride], previous, channels, filter_type)
        position += stride
        rows.append(row)
        previous = row
    return PNGImage(width, height, channels, tuple(rows))


def _rgba_pixels(image: PNGImage):
    for row in image.rows:
        for offset in range(0, len(row), image.channels):
            if image.channels == 3:
                yield (*row[offset : offset + 3], 255)
            else:
                yield tuple(row[offset : offset + 4])


def compare_png(baseline: str | Path, actual: str | Path, threshold: int = 16) -> dict:
    if not 0 <= threshold <= 255:
        raise ValueError("threshold must be between 0 and 255")
    expected = read_png(baseline)
    observed = read_png(actual)
    if (expected.width, expected.height) != (observed.width, observed.height):
        raise PNGError(
            "PNG dimensions differ: "
            f"{expected.width}x{expected.height} != {observed.width}x{observed.height}"
        )
    different = sum(
        any(abs(left - right) > threshold for left, right in zip(expected_pixel, actual_pixel))
        for expected_pixel, actual_pixel in zip(_rgba_pixels(expected), _rgba_pixels(observed))
    )
    pixels = expected.width * expected.height
    return {
        "width": expected.width,
        "height": expected.height,
        "different": different,
        "pixels": pixels,
        "ratio": different / pixels,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline")
    parser.add_argument("actual")
    parser.add_argument("--threshold", type=int, default=16)
    parser.add_argument("--max-ratio", type=float, default=0.01)
    args = parser.parse_args(argv)
    try:
        result = compare_png(args.baseline, args.actual, args.threshold)
        result["max_ratio"] = args.max_ratio
        result["pass"] = result["ratio"] <= args.max_ratio
    except (OSError, PNGError, ValueError) as error:
        print(json.dumps({"pass": False, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
