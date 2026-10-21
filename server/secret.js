import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, '.secret.key');
const PREFIX = 'enc:v1:';

// Key comes from AUTH_ENCRYPTION_KEY when provided (any passphrase, hashed to 32 bytes),
// otherwise from a generated key file that only root can read.
const loadKey = () => {
  const fromEnv = process.env.AUTH_ENCRYPTION_KEY;
  if (fromEnv) {
    if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) return Buffer.from(fromEnv, 'hex');
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.log('Generated local encryption key at data/.secret.key');
  }
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('data/.secret.key is not a valid 32-byte hex key');
  }
  return Buffer.from(raw, 'hex');
};

const key = loadKey();

export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

export const encryptSecret = (plain) => {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((part) => part.toString('base64')).join(':');
};

export const decryptSecret = (value) => {
  if (!isEncrypted(value)) return value;
  try {
    const [ivPart, tagPart, dataPart] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    console.error('Failed to decrypt stored secret; treating it as empty:', err.message);
    return '';
  }
};
