"""Обрезка PNG по фактическому краю содержимого.

Высота кадра считалась из числа строк и размера шрифта — и раз за разом
не сходилась с тем, что рисовал браузер. Считать вместо браузера бесполезно:
он один знает, где на самом деле кончается текст. Поэтому снимаем с запасом
и режем по последнему непустому ряду пикселей.

Без зависимостей: PNG здесь — RGB без интерлейса, ровно то, что отдаёт
Chromium.
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    width, height = struct.unpack('>II', data[16:24])
    depth, color = data[24], data[25]
    if depth != 8 or color not in (2, 6):
        raise SystemExit(f'ожидался 8-битный RGB(A), получено depth={depth} color={color}')
    channels = 3 if color == 2 else 4

    idat = b''
    i = 8
    while i < len(data):
        length = struct.unpack('>I', data[i:i + 4])[0]
        if data[i + 4:i + 8] == b'IDAT':
            idat += data[i + 8:i + 8 + length]
        i += 12 + length

    raw = zlib.decompress(idat)
    stride = width * channels + 1
    rows = []
    prev = bytearray(width * channels)
    for y in range(height):
        line = bytearray(raw[y * stride + 1:(y + 1) * stride])
        filt = raw[y * stride]
        for x in range(len(line)):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            if filt == 1:
                line[x] = (line[x] + a) & 255
            elif filt == 2:
                line[x] = (line[x] + b) & 255
            elif filt == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif filt == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 255
        rows.append(bytes(line))
        prev = line
    return width, height, channels, rows


def write_png(path, width, height, channels, rows):
    color = 2 if channels == 3 else 6
    head = struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, 0)
    body = b''.join(b'\x00' + row for row in rows)

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', head)
        + chunk(b'IDAT', zlib.compress(body, 9))
        + chunk(b'IEND', b''))


def main(path, pad, tolerance=12):
    width, height, channels, rows = read_png(path)
    # Фон — цвет первого пикселя: рамка залита им целиком.
    bg = rows[0][:channels]
    last = 0
    for y, row in enumerate(rows):
        for x in range(0, width * channels, channels):
            if any(abs(row[x + c] - bg[c]) > tolerance for c in range(3)):
                last = y
                break
    cut = min(height, last + 1 + pad)
    write_png(path, width, cut, channels, rows[:cut])
    print(f'{width}x{cut}')


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 36)
