//@ts-check
'use strict';

const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const packageJson = require('./package.json');

/**
 * @brief Webpack configuration for the OpenBlink VS Code extension.
 *
 * Produces two bundles:
 *   1. `extension.js` — Main extension entry point (CommonJS, externals:
 *      `vscode` and `@abandonware/noble`).
 *   2. `mcp-server.js` — Standalone MCP server (CommonJS, no externals).
 *      Launched as a child process by the IDE's MCP client via stdio.
 *
 * Static assets (WASM compiler, icons, board resources) are copied to
 * the output directory via CopyWebpackPlugin (only in the extension config).
 *
 * @type {import('webpack').Configuration[]}
 */

/** @brief Extension bundle configuration. */
const extensionConfig = {
  target: 'node',
  mode: 'none',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    '@abandonware/noble': 'commonjs @abandonware/noble'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'resources/wasm/mrbc.js', to: 'mrbc.js' },
        { from: 'resources/wasm/mrbc.wasm', to: 'mrbc.wasm' },
        { from: 'resources/icons/openblink.svg', to: 'openblink.svg' },
        { from: 'resources/boards', to: 'boards' }
      ]
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

/**
 * @brief MCP server bundle configuration.
 *
 * Produces a standalone Node.js script that communicates via stdio using
 * the Model Context Protocol.  No VS Code or Noble externals — all
 * dependencies are bundled into a single file.
 */
const mcpServerConfig = {
  target: 'node',
  mode: 'none',

  entry: './src/mcp-server.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'mcp-server.js',
    libraryTarget: 'commonjs2'
  },
  externals: {},
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      EXTENSION_VERSION: JSON.stringify(packageJson.version),
    }),
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

module.exports = [extensionConfig, mcpServerConfig];
