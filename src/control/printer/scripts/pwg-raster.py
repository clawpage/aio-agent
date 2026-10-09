"""Turn one workspace PDF or picture into a PWG raster stream for an IPP printer.

Runs inside the account's sandbox (python3 -), with fixed argv from the control
plane: source, output, color space (srgb|sgray), sides, page width/height in
pixels at 300 dpi, the PWG media name, and the PDF pages to print ("" = all).
Prints one JSON line: {"ok": true, "pages": n} or {"ok": false, "message": ...}.

PWG raster (PWG 5102.4): "RaS2", then per page a 1796-byte big-endian header and
the lines, each as a repeat count and PackBits-like pixel runs.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

DPI = 300
MAX_PAGES = 50
IMAGE_MARGIN = DPI // 4  # pictures keep a quarter inch clear of the edge


def done(**result):
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)


try:
    import numpy as np
    from PIL import Image, ImageOps
except ImportError:
    done(ok=False, message="沙箱缺少 numpy 或 Pillow，无法转换打印文件")

Image.MAX_IMAGE_PIXELS = 300_000_000


def pdf_pages(src, wanted):
    """The PDF pages to print, checked against the document."""
    info = subprocess.run(["pdfinfo", src], capture_output=True, text=True, timeout=60)
    if info.returncode != 0:
        done(ok=False, message="读不了这个 PDF（可能损坏或加了密码）：" + info.stderr.strip()[:200])
    total = next((int(line.split(":")[1]) for line in info.stdout.splitlines() if line.startswith("Pages:")), 0)
    pages = wanted or list(range(1, total + 1))
    if not pages:
        done(ok=False, message="PDF 没有页面")
    if pages[-1] > total:
        done(ok=False, message=f"PDF 只有 {total} 页")
    if len(pages) > MAX_PAGES:
        done(ok=False, message=f"一次最多打印 {MAX_PAGES} 页，这份有 {len(pages)} 页，用 pages 分批打印")
    return pages


def rendered(src, pages, gray, tmp):
    for n in pages:
        stem = os.path.join(tmp, f"p{n}")
        args = ["pdftoppm", "-r", str(DPI), "-f", str(n), "-l", str(n), "-singlefile"] + (["-gray"] if gray else []) + [src, stem]
        run = subprocess.run(args, capture_output=True, text=True, timeout=180)
        if run.returncode != 0:
            done(ok=False, message=f"第 {n} 页渲染失败：" + run.stderr.strip()[:200])
        path = stem + (".pgm" if gray else ".ppm")
        yield Image.open(path), False
        os.unlink(path)


def picture(src):
    try:
        im = Image.open(src)
        im.load()
    except Exception as err:  # noqa: BLE001 - any decoding failure is the same answer
        done(ok=False, message=f"打不开这张图片：{err}")
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        white = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(white, im)
    yield im, True


def place(im, width, height, gray, fit):
    """The page as a white sheet of exactly width x height with the content centred."""
    im = im.convert("L" if gray else "RGB")
    if (im.width > im.height) != (width > height) and im.width != im.height:
        im = im.rotate(90, expand=True)
    room_w, room_h = (width - 2 * IMAGE_MARGIN, height - 2 * IMAGE_MARGIN) if fit else (width, height)
    scale = min(room_w / im.width, room_h / im.height)
    # A rendered PDF page keeps its size unless it is larger than the paper; a picture fills the page.
    if fit or scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    sheet = Image.new(im.mode, (width, height), 255 if gray else (255, 255, 255))
    sheet.paste(im, ((width - im.width) // 2, (height - im.height) // 2))
    return np.asarray(sheet, dtype=np.uint8).reshape(height, width, 1 if gray else 3)


def encode_line(row, bpp):
    """One line of pixels as PWG runs: n-1 then a pixel for repeats, 257-n then n pixels for literals."""
    if bpp == 3:
        keys = (row[:, 0].astype(np.uint32) << 16) | (row[:, 1].astype(np.uint32) << 8) | row[:, 2]
    else:
        keys = row[:, 0]
    data = row.tobytes()
    width = len(keys)
    change = np.flatnonzero(keys[1:] != keys[:-1]) + 1
    starts = np.concatenate(([0], change))
    lengths = np.diff(np.concatenate((starts, [width])))
    single = lengths == 1
    # Consecutive one-pixel runs join into one literal group; every longer run is its own group.
    first = np.ones(len(starts), dtype=bool)
    first[1:] = ~(single[1:] & single[:-1])
    heads = np.flatnonzero(first)
    out = bytearray()
    for start, length, literal in zip(starts[heads].tolist(), np.add.reduceat(lengths, heads).tolist(), single[heads].tolist()):
        while length > 0:
            count = min(length, 128)
            if literal and count > 1:
                out.append(257 - count)
                out += data[start * bpp:(start + count) * bpp]
            else:
                out.append(count - 1)
                out += data[start * bpp:(start + 1) * bpp]
            start += count
            length -= count
    return bytes(out)


def header(width, height, gray, sides, back, total, media):
    h = bytearray(1796)

    def put(offset, value, fmt=">I"):
        struct.pack_into(fmt, h, offset, value)

    h[0:9] = b"PwgRaster"
    duplex = sides != "one-sided"
    tumble = sides == "two-sided-short-edge"
    put(272, int(duplex))
    put(276, DPI)
    put(280, DPI)
    put(352, round(width * 72 / DPI))
    put(356, round(height * 72 / DPI))
    put(368, int(tumble))
    put(372, width)
    put(376, height)
    put(384, 8)                   # cupsBitsPerColor
    put(388, 8 if gray else 24)   # cupsBitsPerPixel
    put(392, width * (1 if gray else 3))
    put(400, 18 if gray else 19)  # sGray / sRGB
    put(420, 1 if gray else 3)    # cupsNumColors
    put(452, total)               # TotalPageCount
    if back:
        put(456, -1, ">i")        # CrossFeedTransform
        put(460, -1, ">i")        # FeedTransform
    name = media.encode()[:63]
    h[1732:1732 + len(name)] = name
    return bytes(h)


def write_page(out, pixels, gray, sides, back, total, media):
    height, width, bpp = pixels.shape
    out.write(header(width, height, gray, sides, back, total, media))
    y = 0
    while y < height:
        repeat = 0
        while repeat < 255 and y + repeat + 1 < height and np.array_equal(pixels[y + repeat + 1], pixels[y]):
            repeat += 1
        out.write(bytes([repeat]))
        out.write(encode_line(pixels[y], bpp))
        y += repeat + 1


def main():
    src, dest, space, sides, width, height, media, pages = sys.argv[1:9]
    gray = space == "sgray"
    width, height = int(width), int(height)
    wanted = [int(p) for p in pages.split(",") if p]
    tmp = tempfile.mkdtemp(prefix="aio-print-")
    try:
        if src.lower().endswith(".pdf"):
            pages = pdf_pages(src, wanted)
            source, total = rendered(src, pages, gray, tmp), len(pages)
        else:
            source, total = picture(src), 1
        # One page in memory at a time: a 300 dpi colour sheet is about 25 MB.
        with open(dest, "wb") as out:
            out.write(b"RaS2")
            for index, (im, fit) in enumerate(source):
                pixels = place(im, width, height, gray, fit)
                # This printer's back side is rotated: on a long-edge flip, every back page is drawn upside down.
                back = sides == "two-sided-long-edge" and index % 2 == 1
                if back:
                    pixels = pixels[::-1, ::-1]
                write_page(out, pixels, gray, sides, back, total, media)
        done(ok=True, pages=total)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


main()
