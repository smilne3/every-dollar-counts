import 'server-only'
import crypto from 'node:crypto'

// AES-256-GCM encryption for the Plaid access_token at rest.
// TOKEN_ENCRYPTION_KEY must be 32 bytes as hex (openssl rand -hex 32).
function key() {
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, 'hex')
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':')
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(':')
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'))
  d.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8')
}
