# Open Blink VSCode 扩展 for Windows

**此仓库是Windows用户使用的。如果您正在寻找Mac版本，请访问[这里](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)。**

[![English](https://img.shields.io/badge/language-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/language-中文-red.svg)](README.zh-CN.md)
[![日本語](https://img.shields.io/badge/language-日本語-green.svg)](README.ja.md)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/OpenBlink/openblink-vscode-extension)

关于Open Blink的更多信息，请访问[这里](https://github.com/OpenBlink/openblink)。

此扩展提供与[Web IDE](https://openblink.org/)基本相同的功能。
Open Blink VSCode扩展是一个通过BLE与微控制器设备进行通信的VSCode扩展。它使您能够轻松地编译代码并将其写入设备。

## 许可证

BSD-3-Clause

## 主要功能

- BLE设备检测和连接
- 固件编译和写入
- 设备软重置
- 实时状态显示

## 已验证环境

| PC操作系统 | PC型号 | 开发板名称 | 固件哈希值 |
|-------|---------|--------|--------|
| Windows 11 | ThinkPad E14 Gen4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |
| macOS 15.0 (24A8332) | MacMini M4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |
- 其他环境请从[源码](https://github.com/OpenBlink/openblink-vscode-extension)自行构建。

## 目标用户

- 使用Open Blink设备的开发者
- 从事使用BLE的微控制器开发的人员

## 安装方法

1. 打开VSCode扩展市场
2. 搜索"Open Blink VSCode Extension"
3. 点击"安装"
（需要VSCode版本1.96.0或更高。Cursor环境用户请特别注意）

## 使用方法

### 连接设备

1. 在兼容设备上安装作为PlatformIO项目分发的固件
2. 点击VSCode侧边栏中的Open Blink图标
3. 选择"Connect Device"
4. 从可用设备列表中选择目标设备

### 编写代码

1. 编辑项目源代码
2. 点击"Compile and Blink"按钮执行编译和写入

### 其他操作

- 设备重置：点击"Soft Reset"按钮
- 断开设备：点击"Disconnect Device"按钮

## 配置选项

即将推出...

## 故障排除

即将推出...

## 支持

- [GitHub Issues](https://github.com/OpenBlink/vscode-extension/issues)
- [DeepWiki](https://deepwiki.com/OpenBlink/openblink-vscode-extension)

## 参与开发
### 开发环境设置

```bash
git clone https://github.com/OpenBlink/vscode-extension.git
cd vscode-extension
npm install
npm -g install yo vsce
```

## 未来工作
- [ ] 添加测试
- [ ] 整理输出日志

---

**注意**：此README将持续更新。