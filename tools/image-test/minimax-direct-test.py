# 直连 MiniMax M3 识图测试（绕过 AstrBot，最小请求）
import json, base64, sys
from openai import OpenAI

cfg = json.load(open('/app/data/cmd_config.json', encoding='utf-8-sig'))
src = [s for s in cfg['provider_sources'] if s.get('id') == 'minimax'][0]
key = src['key'][0] if isinstance(src['key'], list) else src['key']
base = src['api_base']
print('API_BASE:', base)

b64 = open('/tmp/cat-512.b64').read().strip()
print('IMG_B64_LEN:', len(b64))

client = OpenAI(api_key=key, base_url=base, timeout=60)
try:
    resp = client.chat.completions.create(
        model='MiniMax-M3',
        messages=[{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': '请用中文描述这张图片里有什么。'},
                {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + b64}},
            ],
        }],
        max_tokens=300,
    )
    print('DIRECT-MINIMAX-REPLY >>>', resp.choices[0].message.content)
except Exception as e:
    print('DIRECT-MINIMAX-ERROR:', type(e).__name__, str(e)[:500])
    sys.exit(1)
