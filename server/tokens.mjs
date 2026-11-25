/**
 * token 估算：不引依赖，也不假装精确。
 *
 * 单一系数（原来的 ceil(len/3)）对中文低估约 3 倍——中文 1 字 ≈ 1 token，
 * 所以按字符类型分段计权，误差通常能压到 25% 以内，够做预算决策。
 * 有 provider usage 时以 usage 为准，这里只用于「没有 usage」的估算路径。
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x80) ascii++;
    else if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + ascii / 3.6 + other / 2);
}
