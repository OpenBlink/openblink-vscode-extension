//@ts-check
'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/**
 * @brief Webpack configuration for the OpenBlink VS Code extension.
 *
 * Bundles the TypeScript source into a single CommonJS module targeting
 * Node.js. Externals (`vscode`, `@abandonware/noble`) are excluded from
 * the bundle. Static assets (WASM compiler, icons, board resources) are
 * copied to the output directory via CopyWebpackPlugin.
 *
 * @type {import('webpack').Configuration}
 */
const config = {
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

module.exports = config;
