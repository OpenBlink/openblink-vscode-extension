const fs = require('fs');
const path = require('path');

// package.jsonのパスを設定
const packageJsonPath = path.join(__dirname, 'package.json');

// package.jsonを読み込む
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// WindowsとMacの記述を入れ替える
const isWindows = packageJson.name.includes('windows');

// 置換する文字列のマッピング
const replacements = {
    windows: {
        name: 'windows',
        displayName: 'Windows',
        description: 'Windows version',
        readme: {
            title: 'Open Blink VSCode Extension for Windows',
            note: '**This repository is for Windows users. If you are looking for the Mac version, please visit [here](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension).**',
            zhTitle: 'Open Blink VSCode 扩展 for Windows',
            zhNote: '**此仓库是Windows用户使用的。如果您正在寻找Mac版本，请访问[这里](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)。**',
            jaTitle: 'Open Blink VSCode 拡張機能 for Windows',
            jaNote: '**このリポジトリはWindowsユーザー向けです。Mac版は[こちら](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)をご覧ください。**'
        }
    },
    mac: {
        name: 'mac',
        displayName: 'Mac',
        description: 'Mac version',
        readme: {
            title: 'Open Blink VSCode Extension for Mac',
            note: '**This repository is for Mac users. If you are looking for the Windows version, please visit [here](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension).**',
            zhTitle: 'Open Blink VSCode 扩展 for Mac',
            zhNote: '**此仓库是Mac用户使用的。如果您正在寻找Windows版本，请访问[这里](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)。**',
            jaTitle: 'Open Blink VSCode 拡張機能 for Mac',
            jaNote: '**このリポジトリはMacユーザー向けです。Windows版は[こちら](https://marketplace.visualstudio.com/items?itemName=OpenBlink.open-blink-vscode-extension)をご覧ください。**'
        }
    }
};

// 現在のバージョンに基づいて置換対象を決定
const currentVersion = isWindows ? replacements.windows : replacements.mac;
const targetVersion = isWindows ? replacements.mac : replacements.windows;

// package.jsonの編集
packageJson.name = packageJson.name.replace(currentVersion.name, targetVersion.name);
packageJson.displayName = packageJson.displayName.replace(currentVersion.displayName, targetVersion.displayName);
packageJson.description = packageJson.description.replace(currentVersion.description, targetVersion.description);

// READMEファイルの編集
const readmeFiles = [
    { path: 'README.md', title: 'title', note: 'note' },
    { path: 'README.zh-CN.md', title: 'zhTitle', note: 'zhNote' },
    { path: 'README.ja.md', title: 'jaTitle', note: 'jaNote' }
];

readmeFiles.forEach(file => {
    const readmePath = path.join(__dirname, file.path);
    let content = fs.readFileSync(readmePath, 'utf8');
    
    // タイトルとノートの置換
    content = content.replace(currentVersion.readme[file.title], targetVersion.readme[file.title]);
    content = content.replace(currentVersion.readme[file.note], targetVersion.readme[file.note]);
    
    fs.writeFileSync(readmePath, content);
});

// 変更した内容をファイルに書き込む
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('package.jsonとREADMEファイルの編集が完了しました。');
