import { describe, it, expect, beforeAll } from 'vitest'
import { encrypt, decrypt } from '@/lib/crypto'

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = '0'.repeat(64) // 32 bytes as hex
})

describe('crypto', () => {
  it('round-trips a value', () => {
    const secret = 'access-sandbox-abc123'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('x')).not.toBe(encrypt('x'))
  })

  it('fails to decrypt if the ciphertext is tampered', () => {
    const enc = encrypt('sensitive')
    const [iv, tag, data] = enc.split(':')
    const tampered = [iv, tag, data.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))].join(':')
    expect(() => decrypt(tampered)).toThrow()
  })
})
