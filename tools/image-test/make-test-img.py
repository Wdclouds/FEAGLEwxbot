# 生成四色块测试 PNG + base64（纯标准库，无 Pillow）
import zlib, struct, base64, os

W = H = 200
Q = W // 2
rows = []
for y in range(H):
    row = bytearray([0])
    for x in range(W):
        if x < Q and y < Q:
            c = (255, 0, 0)
        elif x >= Q and y < Q:
            c = (0, 255, 0)
        elif x < Q and y >= Q:
            c = (0, 0, 255)
        else:
            c = (255, 255, 0)
        row += bytes(c)
    rows.append(bytes(row))

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
b64 = base64.b64encode(png).decode()

base = r'C:\Users\Administrator\FEAGLEwxbot\tools\image-test'
with open(os.path.join(base, 'test-quad.png'), 'wb') as f:
    f.write(png)
with open(os.path.join(base, 'test-quad.b64'), 'w') as f:
    f.write(b64)
print('PNG bytes:', len(png), '| base64 len:', len(b64))
print('b64 head:', b64[:60])
