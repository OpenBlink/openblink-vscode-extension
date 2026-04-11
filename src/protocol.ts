/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import { BLE_CONSTANTS, NobleCharacteristic } from './types';

/**
 * @brief Compute a reflected CRC-16 checksum.
 *
 * Processes each byte of `data` bit-by-bit using the reflected algorithm
 * (LSB-first). Used for integrity verification of firmware data sent over BLE.
 *
 * @param poly  Generator polynomial in reflected form (e.g. 0xD175).
 * @param seed  Initial CRC register value (e.g. 0xFFFF).
 * @param data  Input byte array to checksum.
 * @returns     16-bit CRC value.
 */
export function crc16_reflect(poly: number, seed: number, data: Uint8Array): number {
  let crc = seed;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >>> 1) ^ poly;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xffff;
}

/**
 * @brief Write a buffer to a BLE characteristic with a timeout guard.
 *
 * Automatically selects write-with-response or write-without-response
 * based on the characteristic's supported properties.
 *
 * @param characteristic  Target BLE characteristic.
 * @param buffer          Data to write.
 * @param timeout         Maximum time to wait in milliseconds (default: {@link BLE_CONSTANTS.WRITE_TIMEOUT}).
 * @throws Error if the write does not complete within the timeout.
 */
async function writeCharacteristic(
  characteristic: NobleCharacteristic,
  buffer: ArrayBuffer,
  timeout: number = BLE_CONSTANTS.WRITE_TIMEOUT
): Promise<void> {
  const nodeBuffer = Buffer.from(buffer);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`BLE write timeout after ${timeout}ms`));
    }, timeout);

    const writePromise = characteristic.properties.includes('writeWithoutResponse')
      ? characteristic.writeAsync(nodeBuffer, true)
      : characteristic.writeAsync(nodeBuffer);

    writePromise
      .then(() => {
        clearTimeout(timeoutId);
        resolve();
      })
      .catch((error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * @brief Transfer compiled mruby firmware to a device over BLE.
 *
 * The transfer consists of three phases:
 *  1. **Data chunks** – the bytecode is split into MTU-sized packets, each
 *     prefixed with a 6-byte header (version, type='D', offset, size).
 *  2. **Program header** – an 8-byte packet (version, type='P', length, CRC,
 *     slot, reserved) that commits the uploaded data.
 *  3. **Reload command** – triggers the device to load the new program.
 *
 * @param programCharacteristic  BLE characteristic for the program endpoint.
 * @param mrbContent             Compiled mruby bytecode to transfer (1–65535 bytes).
 * @param slot                   Target program slot on the device (1 or 2).
 * @param negotiatedMTU          Negotiated BLE MTU size in bytes (must be
 *                               greater than {@link BLE_CONSTANTS.DATA_HEADER_SIZE}).
 * @param onProgress             Optional callback invoked with progress messages.
 * @throws Error if any parameter is out of range.
 */
export async function sendFirmware(
  programCharacteristic: NobleCharacteristic,
  mrbContent: Uint8Array,
  slot: number,
  negotiatedMTU: number,
  onProgress?: (message: string) => void
): Promise<void> {
  // --- Input validation ---------------------------------------------------
  const contentLength = mrbContent.length;
  if (contentLength === 0) {
    throw new Error('Program is empty (0 bytes)');
  }
  if (contentLength > 0xFFFF) {
    throw new Error(`Program size (${contentLength} bytes) exceeds maximum of 65535 bytes supported by the BLE protocol`);
  }
  if (slot !== 1 && slot !== 2) {
    throw new Error(`Invalid slot number: ${slot}. Must be 1 or 2`);
  }
  if (negotiatedMTU <= BLE_CONSTANTS.DATA_HEADER_SIZE) {
    throw new Error(`Negotiated MTU (${negotiatedMTU}) is too small; must be greater than DATA_HEADER_SIZE (${BLE_CONSTANTS.DATA_HEADER_SIZE})`);
  }
  // -----------------------------------------------------------------------
  const crc16 = crc16_reflect(0xd175, 0xffff, mrbContent);
  const DATA_PAYLOAD_SIZE = negotiatedMTU - BLE_CONSTANTS.DATA_HEADER_SIZE;

  onProgress?.(`[TRANSFER] slot=${slot}, size=${contentLength}bytes, CRC16=${crc16.toString(16)}, MTU=${negotiatedMTU}`);

  // Send data chunks
  for (let offset = 0; offset < contentLength; offset += DATA_PAYLOAD_SIZE) {
    const chunkDataSize = Math.min(DATA_PAYLOAD_SIZE, contentLength - offset);
    const buffer = new ArrayBuffer(BLE_CONSTANTS.DATA_HEADER_SIZE + chunkDataSize);
    const view = new DataView(buffer);

    view.setUint8(0, 0x01);                      // Protocol version
    view.setUint8(1, 'D'.charCodeAt(0));           // Packet type: [D]ata
    view.setUint16(2, offset, true);               // Byte offset (little-endian)
    view.setUint16(4, chunkDataSize, true);        // Chunk size   (little-endian)

    const payload = new Uint8Array(buffer, BLE_CONSTANTS.DATA_HEADER_SIZE, chunkDataSize);
    payload.set(mrbContent.subarray(offset, offset + chunkDataSize));

    await writeCharacteristic(programCharacteristic, buffer);
    onProgress?.(`[TRANSFER] [D]ata Ok: Offset=${offset}, Size=${chunkDataSize}`);
  }

  // Send program header
  const programBuffer = new ArrayBuffer(BLE_CONSTANTS.PROGRAM_HEADER_SIZE);
  const programView = new DataView(programBuffer);

  programView.setUint8(0, 0x01);                  // Protocol version
  programView.setUint8(1, 'P'.charCodeAt(0));      // Packet type: [P]rogram
  programView.setUint16(2, contentLength, true);   // Total content length (little-endian)
  programView.setUint16(4, crc16, true);           // CRC-16 checksum     (little-endian)
  programView.setUint8(6, slot);                   // Target program slot
  programView.setUint8(7, 0);                      // Reserved

  await writeCharacteristic(programCharacteristic, programBuffer);
  onProgress?.('[TRANSFER] [P]rogram Complete');

  // Send reload command
  await sendReload(programCharacteristic, onProgress);
}

/**
 * @brief Send a soft-reset command to the connected device.
 *
 * Writes a 2-byte packet (version=0x01, type='R') to the program
 * characteristic, causing the device to perform a software reset.
 *
 * @param programCharacteristic  BLE characteristic for the program endpoint.
 * @param onProgress             Optional callback invoked with a completion message.
 */
export async function sendReset(
  programCharacteristic: NobleCharacteristic,
  onProgress?: (message: string) => void
): Promise<void> {
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setUint8(0, 0x01);                          // Protocol version
  view.setUint8(1, 'R'.charCodeAt(0));             // Packet type: [R]eset

  await writeCharacteristic(programCharacteristic, buffer);
  onProgress?.('[TRANSFER] [R]eset Complete');
}

/**
 * @brief Send a reload command to the connected device.
 *
 * Writes a 2-byte packet (version=0x01, type='L') to the program
 * characteristic, instructing the device to reload the stored program.
 *
 * @param programCharacteristic  BLE characteristic for the program endpoint.
 * @param onProgress             Optional callback invoked with a completion message.
 */
export async function sendReload(
  programCharacteristic: NobleCharacteristic,
  onProgress?: (message: string) => void
): Promise<void> {
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setUint8(0, 0x01);                          // Protocol version
  view.setUint8(1, 'L'.charCodeAt(0));             // Packet type: [L]oad

  await writeCharacteristic(programCharacteristic, buffer);
  onProgress?.('[TRANSFER] [L]oad Complete');
}
