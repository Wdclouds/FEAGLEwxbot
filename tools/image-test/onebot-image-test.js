// FEAGLEwxbot 图片链路测试：假 OneBot client 直连 AstrBot 6199
// 推一条私聊图片消息，验证 AstrBot 识图模型链路（不动 bridge / Agent / 任何配置）
const WebSocket = require('/app/node_modules/ws');

const IMG_URL = process.env.IMG_URL || 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg';
const SELF_ID = 'hermes-imgtest-' + Math.floor(Math.random() * 1e6);
const USER_ID = 'hermes_test_user_01';
const DEADLINE_MS = 120000;

const ws = new WebSocket('ws://127.0.0.1:6199/ws', {
  headers: { 'X-Self-ID': SELF_ID, 'X-Client-Role': 'Universal' },
});

let replyReceived = false;
const deadline = setTimeout(() => {
  console.log('TEST-TIMEOUT: 120s 内未收到 AstrBot 回复');
  process.exit(3);
}, DEADLINE_MS);

function sendReply(echo) {
  ws.send(JSON.stringify({
    status: 'ok', retcode: 0,
    data: { message_id: Math.floor(Math.random() * 1e9) },
    echo,
  }));
}

ws.on('open', () => {
  console.log('TEST-CONNECTED self=' + SELF_ID + ' url=' + IMG_URL);
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    time: now,
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: (now % 1000000),
    user_id: USER_ID,
    message: [{ type: 'image', data: { file: IMG_URL } }],
    raw_message: '[CQ:image,file=' + IMG_URL + ']',
    sender: { user_id: USER_ID, nickname: '识图测试' },
  };
  ws.send(JSON.stringify(msg));
  console.log('TEST-SENT 图片消息 (private, user=' + USER_ID + ')');
});

ws.on('message', (data) => {
  let d;
  try { d = JSON.parse(data.toString()); } catch (e) {
    console.log('RAW:', data.toString().slice(0, 300));
    return;
  }
  if (d.action) {
    if (d.action === 'send_msg') {
      const p = d.params || {};
      const parts = Array.isArray(p.message)
        ? p.message.map((m) => (m.type === 'text' ? m.data.text : '[' + m.type + ']')).join('')
        : String(p.message || '');
      console.log('TEST-REPLY-FROM-ASTRBOT >>> ' + parts);
      replyReceived = true;
      clearTimeout(deadline);
      process.exit(0);
    } else {
      console.log('TEST-ACTION: ' + d.action + ' ' + JSON.stringify(d.params || {}).slice(0, 250));
    }
    if (d.echo !== undefined) sendReply(d.echo);
  }
});

ws.on('error', (e) => {
  console.log('TEST-ERROR ' + e.message);
  clearTimeout(deadline);
  process.exit(1);
});
ws.on('close', () => {
  if (!replyReceived) {
    console.log('TEST-CLOSED 连接被关闭，未收到回复');
    clearTimeout(deadline);
    process.exit(2);
  }
});
