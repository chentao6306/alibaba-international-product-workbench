import fs from 'node:fs';
import { constants } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

// The writer stores top-level arrays one item at a time. Read the same format
// without ever assembling the complete workspace into a V8 string. JSON.parse
// still validates each value, including nested structures and escaped strings.
export function readWorkspace(file, { chunkBytes = 1024 * 1024 } = {}) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new StringDecoder('utf8');
  let text = '', position = 0, ended = false;
  const invalid = () => new SyntaxError('工作区 JSON 不完整或格式错误');
  function available() {
    while (position >= text.length && !ended) {
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      ended = size === 0;
      text = ended ? decoder.end() : decoder.write(buffer.subarray(0, size));
      position = 0;
    }
    return position < text.length;
  }
  function peek() {
    while (available()) {
      const match = /[^\x20\t\r\n]/g;
      match.lastIndex = position;
      const next = match.exec(text);
      if (next) { position = next.index; return text[position]; }
      position = text.length;
    }
    return '';
  }
  function expect(value) {
    if (peek() !== value) throw invalid();
    position++;
  }
  function value() {
    const first = peek();
    if (!first || /[,}\]:]/.test(first)) throw invalid();
    const compound = first === '{' || first === '[';
    const quoted = first === '"';
    let depth = 0, inString = false, escaped = false, started = false, length = 0;
    const parts = [];
    function append(part) {
      length += part.length;
      if (length > constants.MAX_STRING_LENGTH) {
        throw Object.assign(new Error('单条商品资料过大，无法读取；原数据已保留，请联系支持处理'), { code: 'WORKSPACE_ENTRY_TOO_LARGE' });
      }
      parts.push(part);
    }
    while (available()) {
      const start = position;
      let complete = false;
      while (position < text.length) {
        const char = text[position];
        if (!compound && !quoted && /[,}\]\x20\t\r\n]/.test(char)) { complete = true; break; }
        position++;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') { inString = false; if (quoted) complete = true; }
        } else if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { depth--; if (depth === 0) complete = true; }
        started = true;
        if (complete) break;
      }
      append(text.slice(start, position));
      if (complete) return JSON.parse(parts.join(''));
    }
    if (started && !compound && !quoted) return JSON.parse(parts.join(''));
    throw invalid();
  }
  try {
    // Accept a UTF-8 BOM from a manually restored JSON file as well.
    if (available() && text[position] === '\uFEFF') position++;
    expect('{');
    const state = {};
    if (peek() !== '}') {
      for (;;) {
        if (peek() !== '"') throw invalid();
        const key = value();
        expect(':');
        let entry;
        if (peek() === '[') {
          position++;
          entry = [];
          if (peek() !== ']') {
            for (;;) {
              entry.push(value());
              if (peek() === ']') break;
              expect(',');
            }
          }
          expect(']');
        } else entry = value();
        // Match JSON.parse for duplicate keys and __proto__ without invoking a
        // prototype setter or changing the resulting object's prototype.
        Object.defineProperty(state, key, { value: entry, writable: true, configurable: true, enumerable: true });
        if (peek() === '}') break;
        expect(',');
      }
    }
    expect('}');
    if (peek()) throw invalid();
    return state;
  } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(new Error('本地商品数据文件不完整或格式错误，原文件已保留；请勿清空数据，请联系支持检查', { cause: error }), { code: 'WORKSPACE_READ_INVALID' });
    throw error;
  } finally { fs.closeSync(descriptor); }
}
