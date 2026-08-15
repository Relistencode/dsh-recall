// Minimal BERT WordPiece tokenizer for bge-small-zh-v1.5, derived from the
// model's tokenizer.json (BAAI/bge-small-zh-v1.5, MIT). Implemented to match
// transformers.js behavior exactly (verified by unit tests against its
// output): BertNormalizer (clean_text + handle_chinese_chars, lowercase off)
// → BertPreTokenizer (each \p{P} punctuation token separate, \p{S} symbols
// grouped) → WordPiece (longest match, whole word → [UNK] on any failure) →
// [CLS] + tokens + [SEP].
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const SPECIAL = { '[PAD]': 0, '[UNK]': 100, '[CLS]': 101, '[SEP]': 102, '[MASK]': 103 }

// BertPreTokenizer pattern (transformers.js): non-space non-punctuation runs
// (letters, digits, \p{S} symbols) plus each punctuation char separately.
const PUNCTUATION_REGEX = '\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E'
const PRE_TOKENIZE = new RegExp(`[^\\s${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]`, 'gu')

// is_chinese_char ranges from transformers.js (HF tokenizers).
function isChineseChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

function isControl(ch) {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false
  const cp = ch.charCodeAt(0)
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)
}

export class BertTokenizer {
  /**
   * @param path - tokenizer.json path (defaults to lib/vendor/tokenizer.json)
   */
  static load(path = join(here, 'vendor', 'tokenizer.json')) {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return new BertTokenizer(data)
  }

  constructor(data) {
    this.vocab = data.model.vocab // token -> id
    this.unkId = this.vocab[data.model.unk_token] ?? 100
    this.maxInputCharsPerWord = data.model.max_input_chars_per_word ?? 100
  }

  /** BertNormalizer: clean_text + tokenize_chinese_chars (lowercase disabled). */
  normalize(text) {
    let out = ''
    for (const ch of String(text)) {
      const cp = ch.charCodeAt(0)
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue
      if (/\s$/.test(ch)) {
        out += ' '
        continue
      }
      if (isChineseChar(ch.codePointAt(0))) {
        if (out.length > 0 && out[out.length - 1] !== ' ') out += ' '
        out += ch
        out += ' '
        continue
      }
      out += ch
    }
    return out
  }

  /**
   * BertPreTokenizer + WordPiece. Returns token strings (without [CLS]/[SEP]).
   */
  tokenize(text) {
    const normalized = this.normalize(text)
    const words = normalized.trim().match(PRE_TOKENIZE) || []
    const tokens = []
    for (const word of words) {
      if (SPECIAL[word] !== undefined) {
        tokens.push(word)
        continue
      }
      tokens.push(...this.wordpiece(word))
    }
    return tokens
  }

  /**
   * Classic BERT WordPiece (transformers.js semantics): longest match with ##
   * continuation; ANY failure turns the whole word into [UNK].
   */
  wordpiece(word) {
    const chars = Array.from(word)
    if (chars.length > this.maxInputCharsPerWord) return ['[UNK]']
    const sub = []
    let start = 0
    while (start < chars.length) {
      let end = chars.length
      let current = null
      while (start < end) {
        let substr = chars.slice(start, end).join('')
        if (start > 0) substr = '##' + substr
        if (Object.prototype.hasOwnProperty.call(this.vocab, substr)) {
          current = substr
          break
        }
        end -= 1
      }
      if (current === null) return ['[UNK]']
      sub.push(current)
      start = end
    }
    return sub
  }

  /**
   * Encode one text into input tensors for the bge model.
   * @returns {{ids: number[], mask: number[], typeIds: number[]}}
   */
  encode(text, { maxLen = 512 } = {}) {
    const tokens = this.tokenize(text)
    const clipped = tokens.slice(0, maxLen - 2)
    const ids = [SPECIAL['[CLS]'], ...clipped.map((t) => this.vocab[t] ?? this.unkId), SPECIAL['[SEP]']]
    const mask = ids.map(() => 1)
    const typeIds = ids.map(() => 0)
    return { ids, mask, typeIds }
  }
}
