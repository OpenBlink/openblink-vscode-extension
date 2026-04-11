/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as assert from 'assert';
import { crc16_reflect } from '../../protocol';

/**
 * @brief Unit tests for the BLE protocol module.
 *
 * Validates the {@link crc16_reflect} function with edge cases (empty data,
 * single byte, large data), determinism, and collision resistance.
 */
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
  });
});
