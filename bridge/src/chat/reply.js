/**
 * 回复的最后一道加工。
 *
 * 微信不渲染 markdown，模型却总忍不住写 `**粗体**`、`- 列表`、`### 标题`，
 * 直接发过去就是一串符号。这里把这些壳剥掉——但不是删内容，只去掉记号。
 */

export const ATTACHMENT_REPLY =
  '我这边只看得见文字和语音——图片、文件里的内容我看不到，你直接说给我听？';

/** 语音会被 iLink 转写成文字，所以「只有附件」指的就是图片/文件/视频那几种 */
export function isAttachmentOnly(text, attachments = []) {
  if (!attachments?.length) return false;
  const stripped = String(text ?? '').replace(/（收到[^）]*）/g, '').trim();
  return stripped === '';
}

/**
 * @param {string} text 模型原话
 * @param {{name?: string}} [opts] 人设名：模型偶尔会写「小满：…」，把它摘掉
 */
export function sanitizeReply(text, { name = '' } = {}) {
  let out = String(text ?? '');
  if (!out.trim()) return '';

  // 代码围栏：整段包着就当没包
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(out);
  if (fenced) out = fenced[1];

  out = out
    .replace(/```[a-zA-Z]*\n?/g, '')       // 残留的行内围栏
    .replace(/\*\*(.+?)\*\*/g, '$1')        // **粗体**
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1')   // ### 标题
    .replace(/(^|\n)\s{0,3}[-*+]\s+/g, '$1')    // - 列表
    .replace(/(^|\n)\s{0,3}\d+[.、)]\s+/g, '$1') // 1. 列表
    .replace(/`([^`\n]+)`/g, '$1')          // 行内代码
    .replace(/[ \t]+$/gm, '')               // 行尾空格
    .replace(/\n{3,}/g, '\n\n');

  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^\\s*${escaped}\\s*[：:]\\s*`), '');
  }

  return out.trim();
}