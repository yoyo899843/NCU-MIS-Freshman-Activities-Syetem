// 玩家代號／學派名稱的字元規則。
//
// 只允許：各國文字（\p{L}，含中日韓）、阿拉伯數字（\p{Nd}）、emoji。
// 也就是把所有標點與符號擋在外面——包含 < > " ' & 這些會讓名字在畫面上被當成
// HTML 解析的字元。名字會出現在地圖 tooltip、後台表格等地方，其中 Leaflet 的
// bindTooltip 收到字串是直接當 HTML 塞進 innerHTML 的，所以「名字裡不會有角括號」
// 這件事本身就是一層防線（輸出端該跳脫的還是要跳脫，這裡是輸入端先收斂）。
//
// emoji 要允許，但 emoji 不是單一個 code point 就能表示：
//   \p{Extended_Pictographic}  絕大多數 emoji 本體
//   \p{Emoji_Modifier}         膚色（👍🏽）
//   \p{Regional_Indicator}     國旗（🇹🇼 是兩個 RI 組成，不屬於 Extended_Pictographic）
//   \u200D                    ZWJ，組合字用（家庭類的組合 emoji）
//   \uFE0F                    variation selector，指定用 emoji 樣式呈現
//   \u20E3                    enclosing keycap（數字鍵帽那種）
const NAME_PATTERN =
  /^[\p{L}\p{Nd}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\u20E3]+$/u;

const NAME_RULE_MESSAGE = '只能使用中英文字、數字與 emoji，不能有空白或標點符號';

// maxChars 用 Array.from 算，不用 .length——emoji 在 UTF-16 裡佔兩個以上的
// code unit，用 .length 會把一個 emoji 算成好幾個字。
function validateName(raw, { maxChars } = {}) {
  if (typeof raw !== 'string') return { error: '名稱必須是文字' };
  const name = raw.trim();
  if (!name) return { error: '名稱不可為空' };
  if (maxChars && Array.from(name).length > maxChars) {
    return { error: `名稱最多 ${maxChars} 個字` };
  }
  if (!NAME_PATTERN.test(name)) return { error: NAME_RULE_MESSAGE };
  return { name };
}

module.exports = { NAME_PATTERN, NAME_RULE_MESSAGE, validateName };
