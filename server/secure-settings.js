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

  key(provider = 'deepseek') {
    if (!['deepseek', 'openai'].includes(provider)) throw new Error('不支持的 AI 服务');
    return this.read()[`${provider}ApiKey`] || process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  }
  configured(provider = 'deepseek') { try { return Boolean(this.key(provider)); } catch { return false; } }

  saveKey(value, provider = 'deepseek') {
    if (!['deepseek', 'openai'].includes(provider)) throw new Error('不支持的 AI 服务');
    const key = String(value || '').trim();
    if (key.length > 512 || /\s/.test(key)) throw new Error('API 密钥格式不正确');
    const values = this.read();
    if (key) values[`${provider}ApiKey`] = key;
    else delete values[`${provider}ApiKey`];
    if (!Object.keys(values).length) { fs.rmSync(this.file, { force: true }); return; }
    if (!this.encryption) throw new Error('请在桌面客户端保存 API 密钥；开发服务可使用 DEEPSEEK_API_KEY');
    const encrypted = this.encryption.encrypt(JSON.stringify(values));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, encrypted, { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
