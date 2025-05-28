# Open Blink VSCode 拡張機能 for Windows

**このリポジトリはWindowsユーザー向けです。Mac版は[こちら](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)をご覧ください。**

[![English](https://img.shields.io/badge/language-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/language-中文-red.svg)](README.zh-CN.md)
[![日本語](https://img.shields.io/badge/language-日本語-green.svg)](README.ja.md)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/OpenBlink/openblink-vscode-extension)

Open Blinkの詳細については[こちら](https://github.com/OpenBlink/openblink)をご覧ください。

この拡張機能は[Web IDE](https://openblink.org/)とほぼ同等の機能を提供します。
Open Blink VSCode拡張機能は、BLEを介してマイクロコントローラーデバイスと通信できるVSCode拡張機能です。コードのコンパイルとデバイスへの書き込みを簡単に行うことができます。

## ライセンス

BSD-3-Clause

## 主な機能

- BLEデバイスの検出と接続
- ファームウェアのコンパイルと書き込み
- デバイスのソフトリセット
- リアルタイムステータス表示

## 動作確認済み環境

| PC-OS | PC-Model | ボード名 | ファームウェアハッシュ |
|-------|---------|--------|--------|
| Windows 11 | ThinkPad E14 Gen4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |
| macOS 15.0 (24A8332) | MacMini M4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |
- Linux等の環境をお使いの場合は、[ソース](https://github.com/OpenBlink/openblink-vscode-extension)からビルドしてください。

## 対象ユーザー

- Open Blinkデバイスを使用する開発者
- BLEを使用したマイクロコントローラー開発に携わる方々

## インストール方法

1. VSCodeの拡張機能マーケットプレイスを開く
2. "Open Blink VSCode Extension"を検索
3. "インストール"をクリック
（VSCodeバージョン1.96.0以上が必要です。Cursor環境のユーザーは特にご注意ください）

## 使用方法

### デバイスの接続

1. PlatformIOプロジェクトとして配布されているファームウェアを対応デバイスにインストール
2. VSCodeサイドバーのOpen Blinkアイコンをクリック
3. "Connect Device"を選択
4. 利用可能なデバイスリストから対象デバイスを選択

### コードの書き込み

1. プロジェクトのソースコードを編集
2. "Compile and Blink"ボタンをクリックしてコンパイルと書き込みを実行

### その他の操作

- デバイスリセット：「Soft Reset」ボタンをクリック
- デバイス切断：「Disconnect Device」ボタンをクリック

## 設定オプション

近日公開予定...

## トラブルシューティング

近日公開予定...

## サポート

- [GitHub Issues](https://github.com/OpenBlink/vscode-extension/issues)
- [DeepWiki](https://deepwiki.com/OpenBlink/openblink-vscode-extension)

## 開発に参加する
### 開発環境のセットアップ

```bash
git clone https://github.com/OpenBlink/vscode-extension.git
cd vscode-extension
npm install
npm -g install yo vsce
```

## 今後の予定
- [ ] テストの追加
- [ ] 出力ログの整理

---

**注意**: このREADMEは継続的に更新されます。