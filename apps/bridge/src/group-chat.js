export const GROUP_CHAT_MODES = Object.freeze({
  OFF: 'OFF',
  OBSERVE: 'OBSERVE',
  MENTION_ONLY: 'MENTION_ONLY',
});

const VALID_MODES = new Set(Object.values(GROUP_CHAT_MODES));

export function normalizeGroupChatMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  return VALID_MODES.has(mode) ? mode : GROUP_CHAT_MODES.OFF;
}

export function normalizeGroupAllowlist(value) {
  const candidates = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return Array.from(new Set(candidates
    .map((item) => String(item || '').trim())
    .filter((item) => /^\d+$/.test(item))));
}

export function isWechatGroupMessage(message) {
  return String(message?.FromUserName || '').startsWith('@@');
}

function decodeWechatText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<br\s*\/?>/gi, '\n');
}

function displayName(contact, fallback = '') {
  return String(
    contact?.DisplayName
    || contact?.RemarkName
    || contact?.NickName
    || fallback,
  ).trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(name) {
  return new RegExp(`@${escapeRegex(name)}(?:[\\u2005\\u2009\\u00a0\\s]|$)`, 'u');
}

export function parseWechatGroupText({
  message,
  group,
  selfUserName = '',
  selfNickName = '',
}) {
  if (!isWechatGroupMessage(message)) return null;

  const original = String(message.OriginalContent || '');
  const originalMatch = /^(@[^:]+):<br\s*\/?>([\s\S]*)$/i.exec(original);
  const senderProtocolId = String(
    message.ActualUserName
    || originalMatch?.[1]
    || '',
  );
  if (!senderProtocolId) return null;

  const members = Array.isArray(group?.MemberList) ? group.MemberList : [];
  const sender = members.find((member) => member?.UserName === senderProtocolId) || {};
  const selfMember = members.find((member) => member?.UserName === selfUserName) || {};

  let text;
  if (originalMatch) {
    const normalizedContent = String(message.Content || '');
    const firstNewline = normalizedContent.indexOf('\n');
    text = firstNewline >= 0
      ? normalizedContent.slice(firstNewline + 1)
      : decodeWechatText(originalMatch[2]);
  } else {
    text = decodeWechatText(message.Content || '');
  }
  text = String(text || '').trim();

  const mentionNames = Array.from(new Set([
    displayName(selfMember),
    String(selfMember?.DisplayName || '').trim(),
    String(selfMember?.NickName || '').trim(),
    String(selfNickName || '').trim(),
  ].filter(Boolean)));
  const matchedMention = mentionNames.find((name) => mentionPattern(name).test(text)) || '';
  const mentioned = Boolean(message.isAt || matchedMention);
  const cleanText = matchedMention
    ? text.replace(mentionPattern(matchedMention), '').trim()
    : text;

  return {
    groupProtocolId: String(message.FromUserName),
    groupName: displayName(group, '微信群'),
    memberCount: Number(group?.MemberCount || members.length || 0),
    senderProtocolId,
    senderStableKey: String(sender?.Alias || ''),
    senderNickname: displayName(sender, '群成员'),
    isSelf: senderProtocolId === selfUserName,
    mentioned,
    text: cleanText,
    rawText: text,
  };
}
