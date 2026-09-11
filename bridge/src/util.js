/**
 * 小而通用的工具：零依赖，供 config 与 weixin 客户端共用。
 */

/**
 * 把「逗号 / 顿号 / 分号 / 空白分隔」的 ID 串或数组，规范成去重后的字符串数组。
 * 例：parseIdList('a, b，c、d;e f') -> ['a','b','c','d','e','f']
 */
export function parseIdList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[,，、;；\s]+/);
  const out = [];
  for (const part of parts) {
    const id = String(part).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 发送者白名单判定。
 * 白名单为空表示「不限制」——这是默认值，方便 M-1 阶段调试，
 * 但只要拿到自己的 ilink_user_id，就应该填进 WEIXIN_ALLOWED_USER_IDS。
 */
export function isSenderAllowed(allowedUserIds, senderId) {
  const allow = parseIdList(allowedUserIds);
  if (allow.length === 0) return true;
  return allow.includes(String(senderId ?? ''));
}