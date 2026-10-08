import struct
import zlib

import pytest

from tools.pngdiff import PNGError, compare_png, read_png


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(
        ">I", zlib.crc32(kind + data) & 0xFFFFFFFF
    )


def _png(width, height, color_type, rows, filters=None):
    channels = 4 if color_type == 6 else 3
    filters = filters or [0] * height
    raw = b"".join(
        bytes([filters[index]]) + bytes(row)
        for index, row in enumerate(rows)
    )
    assert all(len(row) == width * channels for row in rows)
    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return signature + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw)) + _chunk(b"IEND", b"")


def _encoded_row(actual, previous, channels, filter_type):
    out = bytearray()
    for index, value in enumerate(actual):
        left = actual[index - channels] if index >= channels else 0
        up = previous[index] if previous else 0
        up_left = previous[index - channels] if previous and index >= channels else 0
        if filter_type == 0:
            predictor = 0
        elif filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        else:
            p = left + up - up_left
            distances = (abs(p - left), abs(p - up), abs(p - up_left))
            predictor = (left, up, up_left)[distances.index(min(distances))]
        out.append((value - predictor) & 0xFF)
    return out


@pytest.mark.parametrize("color_type,channels", [(2, 3), (6, 4)])
def test_reads_rgb_and_rgba_with_all_png_filters(tmp_path, color_type, channels):
    actual_rows = [
        bytearray((index * 17 + row * 11) % 256 for index in range(3 * channels))
        for row in range(5)
    ]
    encoded = []
    previous = None
    for filter_type, row in enumerate(actual_rows):
        encoded.append(_encoded_row(row, previous, channels, filter_type))
        previous = row
    path = tmp_path / "filters.png"
    path.write_bytes(_png(3, 5, color_type, encoded, list(range(5))))

    image = read_png(path)

    assert (image.width, image.height, image.channels) == (3, 5, channels)
    assert list(image.rows) == [bytes(row) for row in actual_rows]


def test_compare_counts_pixel_once_when_any_channel_delta_exceeds_threshold(tmp_path):
    baseline = tmp_path / "baseline.png"
    actual = tmp_path / "actual.png"
    baseline.write_bytes(_png(2, 1, 2, [[10, 20, 30, 40, 50, 60]]))
    actual.write_bytes(_png(2, 1, 2, [[26, 4, 46, 57, 50, 60]]))

    result = compare_png(baseline, actual, threshold=16)

    assert result == {
        "width": 2,
        "height": 1,
        "different": 1,
        "pixels": 2,
        "ratio": 0.5,
    }


def test_compare_rejects_dimension_mismatch(tmp_path):
    first = tmp_path / "first.png"
    second = tmp_path / "second.png"
    first.write_bytes(_png(1, 1, 2, [[0, 0, 0]]))
    second.write_bytes(_png(2, 1, 2, [[0, 0, 0, 0, 0, 0]]))

    with pytest.raises(PNGError, match="dimensions"):
        compare_png(first, second)


def test_reader_rejects_unsupported_png_format(tmp_path):
    path = tmp_path / "indexed.png"
    path.write_bytes(_png(1, 1, 3, [[0, 0, 0]]))

    with pytest.raises(PNGError, match="RGB/RGBA"):
        read_png(path)
