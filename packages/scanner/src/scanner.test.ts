import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, encodingLength, concatUI8, craftInt64BE, craftUInt16BE } from './protocol/varint.js';
import { craftHandshake, craftEmptyPacket, craftPingPacket } from './protocol/generator.js';
import { withRetry, calculateRetryDelay } from './retry.js';
import { isValidUUIDFormatSync, detectServerModeSync } from './uuid.js';
import { getJsonDepth } from './scanner.js';

describe('VarInt', () => {
  it('should encode and decode all values correctly (roundtrip)', () => {
    const values = [0, 1, 127, 128, 255, 300, 25565, 769, 65535];
    for (const v of values) {
      assert.equal(decode(encode(v)), v, `roundtrip failed for ${v}`);
    }
  });

  it('should encode 128 as two-byte varint', () => {
    const r = encode(128);
    assert.equal(r.length, 2);
    assert.equal(r[0], 0x80);
    assert.equal(r[1], 0x01);
  });

  it('should calculate encoding length at byte boundaries', () => {
    assert.equal(encodingLength(0), 1);
    assert.equal(encodingLength(127), 1);
    assert.equal(encodingLength(128), 2);
    assert.equal(encodingLength(16383), 2);
    assert.equal(encodingLength(16384), 3);
  });
});

describe('concatUI8', () => {
  it('should concatenate Uint8Arrays and number arrays', () => {
    assert.equal(concatUI8([]).length, 0);
    assert.deepEqual(Array.from(concatUI8([new Uint8Array([1, 2]), new Uint8Array([3])])), [1, 2, 3]);
    assert.deepEqual(Array.from(concatUI8([[1], [2, 3]])), [1, 2, 3]);
  });

  it('should skip empty arrays in concatenation', () => {
    const r = concatUI8([new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2])]);
    assert.deepEqual(Array.from(r), [1, 2]);
  });
});

describe('craftInt64BE / craftUInt16BE', () => {
  it('should produce 8-byte big-endian Int64', () => {
    const r = craftInt64BE(BigInt(1));
    assert.equal(r.length, 8);
    assert.equal(r[7], 1);
    assert.equal(r[0], 0);
  });

  it('should produce 2-byte big-endian UInt16', () => {
    const r = craftUInt16BE(25565);
    assert.equal(r.length, 2);
    assert.equal(new DataView(r.buffer, r.byteOffset, 2).getUint16(0, false), 25565);
  });
});

describe('Packet generator', () => {
  it('should craft handshake, status, and ping packets', async () => {
    const hs = await craftHandshake('localhost', 25565, 769);
    const st = await craftEmptyPacket(0);
    const pg = await craftPingPacket();
    assert.ok(hs.length > 0 && st.length > 0 && pg.length > 0);
  });

  it('should produce different handshakes for different hosts/ports', async () => {
    const a = await craftHandshake('server1.com', 25565, 769);
    const b = await craftHandshake('server2.com', 25566, 769);
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });
});

describe('Retry logic', () => {
  it('should apply exponential backoff and cap at 30s', () => {
    assert.equal(calculateRetryDelay(0, 1000, true), 1000);
    assert.equal(calculateRetryDelay(1, 1000, true), 2000);
    assert.equal(calculateRetryDelay(2, 1000, true), 4000);
    assert.ok(calculateRetryDelay(20, 1000, true) <= 30000);
  });

  it('should return flat delay when exponential is false', () => {
    assert.equal(calculateRetryDelay(0, 1000, false), 1000);
    assert.equal(calculateRetryDelay(5, 1000, false), 1000);
  });

  it('should retry on failure then succeed', async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    }, { retries: 5, retryDelay: 10 });
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('should throw after exhausting retries', async () => {
    await assert.rejects(
      () => withRetry(async () => { throw new Error('always fails'); }, { retries: 2, retryDelay: 10 }),
      { message: 'always fails' }
    );
  });
});

describe('getJsonDepth', () => {
  it('should return 0 for primitives', () => {
    for (const v of [null, undefined, 42, 'str', true]) {
      assert.equal(getJsonDepth(v), 0);
    }
  });

  it('should measure nesting depth correctly', () => {
    assert.equal(getJsonDepth({}), 1);
    assert.equal(getJsonDepth([]), 1);
    assert.equal(getJsonDepth({ a: { b: 1 } }), 2);
    assert.equal(getJsonDepth({ a: { b: { c: 1 } } }), 3);
    assert.equal(getJsonDepth({ a: [{ b: 1 }] }), 3);
  });

  it('should cap at MAX_JSON_DEPTH to prevent stack overflow', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 50; i++) deep = { n: deep };
    assert.ok(getJsonDepth(deep) <= 33);
  });
});

describe('UUID / server mode detection (sync)', () => {
  it('should validate UUID format', () => {
    assert.equal(isValidUUIDFormatSync('069a79f4-44e9-4726-a5be-fca90e38aaf5'), true);
    assert.equal(isValidUUIDFormatSync('069a79f444e94726a5befca90e38aaf5'), false);
    assert.equal(isValidUUIDFormatSync(''), false);
    assert.equal(isValidUUIDFormatSync('not-a-uuid'), false);
  });

  it('should detect server mode from player UUIDs', () => {
    assert.equal(detectServerModeSync([]), 'unknown');
    assert.equal(detectServerModeSync([{ id: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' }]), 'online');
    assert.equal(detectServerModeSync([{ id: 'badid', name: 'P' }]), 'unknown');
    assert.equal(detectServerModeSync([
      { id: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' },
      { id: 'badid', name: 'Fake' },
    ]), 'unknown');
  });
});
