import fs from 'node:fs';
import path from 'node:path';

export class SecureSettings {
  constructor(directory, encryption = globalThis.__KUA_YIPU_SECURE_STORAGE) {
    this.file = path.join(directory, 'integrations.bin');
    this.encryption = encryption;
  }

  read() {
    if (!fs.existsSync(this.file)) return {};
    if (!this.encryption) throw new Error('请使用桌面客户端读取已保存的 API 密钥');
    try { return JSON.parse(this.encryption.decrypt(fs.readFileSync(this.file))); }
    catch { throw new Error('无法解密 API 密钥，请在设置中重新保存'); }
  }

  key() { return this.read().deepseekApiKey || process.env.DEEPSEEK_API_KEY || ''; }
  configured() { try { return Boolean(this.key()); } catch { return false; } }

  saveKey(value) {
    const key = String(value || '').trim();
    if (!key) { fs.rmSync(this.file, { force: true }); return; }
    if (key.length > 512 || /\s/.test(key)) throw new Error('API 密钥格式不正确');
    if (!this.encryption) throw new Error('请在桌面客户端保存 API 密钥；开发服务可使用 DEEPSEEK_API_KEY');
    const encrypted = this.encryption.encrypt(JSON.stringify({ deepseekApiKey: key }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, encrypted, { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
