import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultUserDataDir = process.platform === 'win32'
  ? join(tmpdir(), `openblink-vscode-test-${process.pid}`)
  : `/tmp/openblink-vscode-test-${process.pid}`;

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: ['--user-data-dir', process.env.VSCODE_TEST_USER_DATA_DIR ?? defaultUserDataDir],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
