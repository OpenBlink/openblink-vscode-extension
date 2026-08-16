/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as assert from 'assert';
import { crc16_reflect, sendFirmware, sendReset, sendReload } from '../../protocol';
import { BLE_CONSTANTS, NobleCharacteristic } from '../../types';

/**
 * @brief Create a mock BLE characteristic that records every write.
 *
 * @param properties  Characteristic properties (e.g. ['writeWithoutResponse']).
 * @returns The mock characteristic and the array of recorded writes.
 */
function createMockCharacteristic(properties: string[] = []): {
  characteristic: NobleCharacteristic;
  writes: { data: Buffer; withoutResponse: boolean | undefined }[];
} {
  const writes: { data: Buffer; withoutResponse: boolean | undefined }[] = [];
  const characteristic = {
    properties,
    writeAsync: async (data: Buffer | ArrayBuffer, withoutResponse?: boolean) => {
      writes.push({ data: Buffer.from(data as Buffer), withoutResponse });
    },
  } as unknown as NobleCharacteristic;
  return { characteristic, writes };
}

/**
 * @brief Unit tests for the BLE protocol module.
 *
 * Validates the {@link crc16_reflect} function with edge cases (empty data,
 * single byte, large data), determinism, and collision resistance, and
 * golden-tests the wire format produced by {@link sendFirmware},
 * {@link sendReset}, and {@link sendReload}.
 */
/** @brief Golden CRC-16 (poly 0xd175, seed 0xffff) value for [0x00]. */
const CRC_GOLDEN_00 = 0xefe9;
/** @brief Golden CRC-16 (poly 0xd175, seed 0xffff) value for [0x01, 0x02, 0x03, 0x04]. */
const CRC_GOLDEN_01020304 = 0x0121;

suite('Protocol Test Suite', () => {
  suite('crc16_reflect', () => {
    test('should return 0xFFFF for empty data', () => {
      const data = new Uint8Array([]);
      // CRC16 with empty data should return the seed
      const result = crc16_reflect(0xd175, 0xffff, data);
      assert.strictEqual(result, 0xffff);
    });

    test('should compute CRC16 for single byte', () => {
      const data = new Uint8Array([0x00]);
      const result = crc16_reflect(0xd175, 0xffff, data);
      assert.strictEqual(typeof result, 'number');
      assert.ok(result >= 0 && result <= 0xffff);
    });

    test('should compute CRC16 for known data', () => {
      // Test with a simple byte sequence
      const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const result = crc16_reflect(0xd175, 0xffff, data);
      assert.strictEqual(typeof result, 'number');
      assert.ok(result >= 0 && result <= 0xffff);
    });

    test('should be deterministic', () => {
      const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const result1 = crc16_reflect(0xd175, 0xffff, data);
      const result2 = crc16_reflect(0xd175, 0xffff, data);
      assert.strictEqual(result1, result2);
    });

    test('should produce different results for different data', () => {
      const data1 = new Uint8Array([0x01]);
      const data2 = new Uint8Array([0x02]);
      const result1 = crc16_reflect(0xd175, 0xffff, data1);
      const result2 = crc16_reflect(0xd175, 0xffff, data2);
      assert.notStrictEqual(result1, result2);
    });

    test('should handle large data', () => {
      const data = new Uint8Array(1024);
      for (let i = 0; i < data.length; i++) {
        data[i] = i & 0xff;
      }
      const result = crc16_reflect(0xd175, 0xffff, data);
      assert.strictEqual(typeof result, 'number');
      assert.ok(result >= 0 && result <= 0xffff);
    });

    test('should match golden values for known inputs', () => {
      assert.strictEqual(crc16_reflect(0xd175, 0xffff, new Uint8Array([0x00])), CRC_GOLDEN_00);
      assert.strictEqual(
        crc16_reflect(0xd175, 0xffff, new Uint8Array([0x01, 0x02, 0x03, 0x04])),
        CRC_GOLDEN_01020304
      );
    });
  });

  suite('sendFirmware', () => {
    const MTU = 20; // payload per Data packet = 20 - 6 = 14 bytes

    test('should reject empty content', async () => {
      const { characteristic } = createMockCharacteristic();
      await assert.rejects(
        sendFirmware(characteristic, new Uint8Array([]), 1, MTU),
        /empty/i
      );
    });

    test('should reject content larger than 65535 bytes', async () => {
      const { characteristic } = createMockCharacteristic();
      await assert.rejects(
        sendFirmware(characteristic, new Uint8Array(0x10000), 1, MTU),
        /exceeds maximum/i
      );
    });

    test('should reject invalid slot numbers', async () => {
      const { characteristic } = createMockCharacteristic();
      const content = new Uint8Array([0x01]);
      for (const slot of [0, 3, -1, 1.5]) {
        await assert.rejects(sendFirmware(characteristic, content, slot, MTU), /Invalid slot/i);
      }
    });

    test('should reject MTU not greater than DATA_HEADER_SIZE', async () => {
      const { characteristic } = createMockCharacteristic();
      const content = new Uint8Array([0x01]);
      await assert.rejects(
        sendFirmware(characteristic, content, 1, BLE_CONSTANTS.DATA_HEADER_SIZE),
        /MTU/
      );
    });

    test('should not write anything when validation fails', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      await assert.rejects(sendFirmware(characteristic, new Uint8Array([]), 1, MTU));
      assert.strictEqual(writes.length, 0);
    });

    test('should send Data, Program, and Load packets with correct wire format', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      const content = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await sendFirmware(characteristic, content, 1, MTU);

      // One Data chunk + Program header + Load command
      assert.strictEqual(writes.length, 3);

      const dataPacket = writes[0].data;
      assert.strictEqual(dataPacket.length, BLE_CONSTANTS.DATA_HEADER_SIZE + content.length);
      assert.strictEqual(dataPacket[0], 0x01);                    // protocol version
      assert.strictEqual(dataPacket[1], 'D'.charCodeAt(0));       // packet type
      assert.strictEqual(dataPacket.readUInt16LE(2), 0);          // offset
      assert.strictEqual(dataPacket.readUInt16LE(4), content.length); // chunk size
      assert.deepStrictEqual([...dataPacket.subarray(6)], [...content]);

      const programPacket = writes[1].data;
      assert.strictEqual(programPacket.length, BLE_CONSTANTS.PROGRAM_HEADER_SIZE);
      assert.strictEqual(programPacket[0], 0x01);                 // protocol version
      assert.strictEqual(programPacket[1], 'P'.charCodeAt(0));    // packet type
      assert.strictEqual(programPacket.readUInt16LE(2), content.length);
      assert.strictEqual(programPacket.readUInt16LE(4), crc16_reflect(0xd175, 0xffff, content));
      assert.strictEqual(programPacket[6], 1);                    // slot
      assert.strictEqual(programPacket[7], 0);                    // reserved

      const loadPacket = writes[2].data;
      assert.strictEqual(loadPacket.length, 2);
      assert.strictEqual(loadPacket[0], 0x01);
      assert.strictEqual(loadPacket[1], 'L'.charCodeAt(0));
    });

    test('should split content into MTU-sized chunks with correct offsets', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      const payloadSize = MTU - BLE_CONSTANTS.DATA_HEADER_SIZE; // 14
      const content = new Uint8Array(payloadSize * 2 + 3);       // 2 full chunks + 3 bytes
      for (let i = 0; i < content.length; i++) { content[i] = i & 0xff; }

      await sendFirmware(characteristic, content, 2, MTU);

      // 3 Data chunks + Program + Load
      assert.strictEqual(writes.length, 5);

      const expectedChunks = [
        { offset: 0, size: payloadSize },
        { offset: payloadSize, size: payloadSize },
        { offset: payloadSize * 2, size: 3 },
      ];
      expectedChunks.forEach((expected, i) => {
        const packet = writes[i].data;
        assert.strictEqual(packet[1], 'D'.charCodeAt(0));
        assert.strictEqual(packet.readUInt16LE(2), expected.offset);
        assert.strictEqual(packet.readUInt16LE(4), expected.size);
        assert.deepStrictEqual(
          [...packet.subarray(BLE_CONSTANTS.DATA_HEADER_SIZE)],
          [...content.subarray(expected.offset, expected.offset + expected.size)]
        );
      });

      // Program header carries the requested slot
      assert.strictEqual(writes[3].data[6], 2);
    });

    test('should send exactly one chunk when content equals the payload size', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      const payloadSize = MTU - BLE_CONSTANTS.DATA_HEADER_SIZE;
      const content = new Uint8Array(payloadSize).fill(0xaa);

      await sendFirmware(characteristic, content, 1, MTU);

      assert.strictEqual(writes.length, 3); // 1 Data + Program + Load
      assert.strictEqual(writes[0].data.readUInt16LE(4), payloadSize);
    });

    test('should handle single-byte payloads at minimum usable MTU', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      const content = new Uint8Array([0x11, 0x22]);

      await sendFirmware(characteristic, content, 1, BLE_CONSTANTS.MIN_USABLE_MTU);

      // 1 byte per chunk => 2 Data chunks + Program + Load
      assert.strictEqual(writes.length, 4);
      assert.strictEqual(writes[0].data.readUInt16LE(4), 1);
      assert.strictEqual(writes[1].data.readUInt16LE(2), 1); // second chunk offset
    });

    test('should use write-without-response when the characteristic supports it', async () => {
      const { characteristic, writes } = createMockCharacteristic(['writeWithoutResponse']);
      await sendFirmware(characteristic, new Uint8Array([0x01]), 1, MTU);
      assert.ok(writes.every((w) => w.withoutResponse === true));
    });

    test('should use write-with-response by default', async () => {
      const { characteristic, writes } = createMockCharacteristic(['write']);
      await sendFirmware(characteristic, new Uint8Array([0x01]), 1, MTU);
      assert.ok(writes.every((w) => w.withoutResponse === undefined));
    });

    test('should propagate write errors', async () => {
      const characteristic = {
        properties: [],
        writeAsync: async () => { throw new Error('GATT failure'); },
      } as unknown as NobleCharacteristic;
      await assert.rejects(
        sendFirmware(characteristic, new Uint8Array([0x01]), 1, MTU),
        /GATT failure/
      );
    });
  });

  suite('sendReset', () => {
    test('should send a 2-byte packet without slot', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      await sendReset(characteristic);
      assert.strictEqual(writes.length, 1);
      const packet = writes[0].data;
      assert.strictEqual(packet.length, 2);
      assert.strictEqual(packet[0], 0x01);
      assert.strictEqual(packet[1], 'R'.charCodeAt(0));
    });

    test('should send a 3-byte packet with slot', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      await sendReset(characteristic, undefined, 2);
      assert.strictEqual(writes.length, 1);
      const packet = writes[0].data;
      assert.strictEqual(packet.length, 3);
      assert.strictEqual(packet[0], 0x01);
      assert.strictEqual(packet[1], 'R'.charCodeAt(0));
      assert.strictEqual(packet[2], 2);
    });

    test('should report progress', async () => {
      const { characteristic } = createMockCharacteristic();
      const messages: string[] = [];
      await sendReset(characteristic, (m) => messages.push(m), 1);
      assert.strictEqual(messages.length, 1);
      assert.ok(messages[0].includes('[R]eset'));
      assert.ok(messages[0].includes('Slot 1'));
    });
  });

  suite('sendReload', () => {
    test('should send a 2-byte Load packet', async () => {
      const { characteristic, writes } = createMockCharacteristic();
      await sendReload(characteristic);
      assert.strictEqual(writes.length, 1);
      const packet = writes[0].data;
      assert.strictEqual(packet.length, 2);
      assert.strictEqual(packet[0], 0x01);
      assert.strictEqual(packet[1], 'L'.charCodeAt(0));
    });
  });
});
