# 压缩 cat_generated.png → 512 JPEG → base64（供 WS 内嵌测试）
import base64, os
from PIL import Image

src = r'C:\Users\Administrator\cat_generated.png'
base = r'C:\Users\Administrator\FEAGLEwxbot\tools\image-test'

img = Image.open(src).convert('RGB')
img = img.resize((512, 512), Image.LANCZOS)
out_jpg = os.path.join(base, 'cat-512.jpg')
img.save(out_jpg, 'JPEG', quality=85)

b64 = base64.b64encode(open(out_jpg, 'rb').read()).decode()
with open(os.path.join(base, 'cat-512.b64'), 'w') as f:
    f.write(b64)
print('JPEG bytes:', os.path.getsize(out_jpg), '| base64 len:', len(b64))
print('head:', b64[:50])
