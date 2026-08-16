/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as assert from 'assert';
import {
  calculateStats,
  appendConsoleLog,
  getConsoleLog,
  recordMetrics,
  getMetricsHistory,
} from '../../ui-manager';

/**
 * @brief Unit tests for the pure logic in the UI manager.
 *
 * Covers {@link calculateStats}, the console ring buffer
 * ({@link appendConsoleLog} / {@link getConsoleLog}), and the metrics
 * history ({@link recordMetrics} / {@link getMetricsHistory}).
 *
 * Note: the console buffer and metrics history are module-level
 * singletons, so tests assert on relative changes rather than assuming
 * a pristine initial state.
 */
suite('UI Manager Test Suite', () => {
  suite('calculateStats', () => {
    test('should return nulls for an empty array', () => {
      assert.deepStrictEqual(calculateStats([]), { min: null, avg: null, max: null });
    });

    test('should return the value itself for a single element', () => {
      assert.deepStrictEqual(calculateStats([42]), { min: 42, avg: 42, max: 42 });
    });

    test('should compute min, avg, and max', () => {
      assert.deepStrictEqual(calculateStats([3, 1, 2]), { min: 1, avg: 2, max: 3 });
    });

    test('should handle negative values', () => {
      assert.deepStrictEqual(calculateStats([-5, 0, 5]), { min: -5, avg: 0, max: 5 });
    });

    test('should handle floating point averages', () => {
      const stats = calculateStats([1, 2]);
      assert.strictEqual(stats.min, 1);
      assert.strictEqual(stats.max, 2);
      assert.strictEqual(stats.avg, 1.5);
    });

    test('should not overflow the stack on large arrays', () => {
      const arr = new Array<number>(200000).fill(1);
      arr[123456] = 7;
      const stats = calculateStats(arr);
      assert.strictEqual(stats.min, 1);
      assert.strictEqual(stats.max, 7);
    });
  });

  suite('console ring buffer', () => {
    test('should append lines in order', () => {
      const before = getConsoleLog().length;
      appendConsoleLog('line-a');
      appendConsoleLog('line-b');
      const log = getConsoleLog();
      assert.ok(log.length >= before); // may have evicted
      assert.strictEqual(log[log.length - 2], 'line-a');
      assert.strictEqual(log[log.length - 1], 'line-b');
    });

    test('should evict oldest lines beyond the configured buffer size (default 100)', () => {
      for (let i = 0; i < 150; i++) {
        appendConsoleLog(`bulk-${i}`);
      }
      const log = getConsoleLog();
      assert.strictEqual(log.length, 100);
      assert.strictEqual(log[log.length - 1], 'bulk-149');
      assert.strictEqual(log[0], 'bulk-50');
    });

    test('should return a snapshot, not the live buffer', () => {
      appendConsoleLog('snapshot-test');
      const snapshot = getConsoleLog();
      snapshot.push('mutated');
      const fresh = getConsoleLog();
      assert.notStrictEqual(fresh[fresh.length - 1], 'mutated');
    });
  });

  suite('metrics history', () => {
    test('should record values into the corresponding history arrays', () => {
      const before = {
        compile: getMetricsHistory().compile.length,
        transfer: getMetricsHistory().transfer.length,
        size: getMetricsHistory().size.length,
      };
      recordMetrics({ compileTime: 12, transferTime: 34, programSize: 56 });
      const history = getMetricsHistory();
      assert.ok(history.compile.length >= before.compile);
      assert.strictEqual(history.compile[history.compile.length - 1], 12);
      assert.strictEqual(history.transfer[history.transfer.length - 1], 34);
      assert.strictEqual(history.size[history.size.length - 1], 56);
    });

    test('should only record fields that are present', () => {
      const transferBefore = getMetricsHistory().transfer.length;
      const sizeBefore = getMetricsHistory().size.length;
      recordMetrics({ compileTime: 99 });
      const history = getMetricsHistory();
      assert.strictEqual(history.compile[history.compile.length - 1], 99);
      assert.strictEqual(history.transfer.length, transferBefore);
      assert.strictEqual(history.size.length, sizeBefore);
    });

    test('should evict oldest entries beyond the configured history size (default 100)', () => {
      for (let i = 0; i < 150; i++) {
        recordMetrics({ compileTime: i });
      }
      const history = getMetricsHistory();
      assert.strictEqual(history.compile.length, 100);
      assert.strictEqual(history.compile[history.compile.length - 1], 149);
      assert.strictEqual(history.compile[0], 50);
    });
  });
});
