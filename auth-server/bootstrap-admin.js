import crypto from 'node:crypto';
import pg from 'pg';

const username = String(process.env.KUA_YIPU_ADMIN_USERNAME || '').trim();
const password = String(process.env.KUA_YIPU_ADMIN_PASSWORD || '');
if (!process.env.DATABASE_URL || !username || password.length < 12) throw new Error('需要 DATABASE_URL、KUA_YIPU_ADMIN_USERNAME，以及至少 12 位 KUA_YIPU_ADMIN_PASSWORD');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query('INSERT INTO admin_users (id,username,password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash', [crypto.randomUUID(), username, `scrypt$${salt}$${hash}`]);
await pool.end();
console.log(`admin account ready: ${username}`);
