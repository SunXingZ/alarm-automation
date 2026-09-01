// 下载 InsightFace buffalo_l 模型（det_10g.onnx + w600k_r50.onnx）到 models/insightface/。
// 用法：npm run download-models（本地新 clone 后执行一次；CI 构建时自动执行）。
// 依次尝试官方 GitHub Releases 及多个镜像源，全部失败则报错退出。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'models', 'insightface');
const ZIP = path.join(OUT_DIR, 'buffalo_l.zip');

// deepinsight/insightface v0.7 的 buffalo_l.zip（含检测+识别等 5 个模型）
const SOURCES = [
    'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    'https://ghfast.top/https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    'https://ghproxy.net/https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
];

function existsModels() {
    return fs.existsSync(path.join(OUT_DIR, 'det_10g.onnx')) &&
           fs.existsSync(path.join(OUT_DIR, 'w600k_r50.onnx'));
}

function main() {
    if (existsModels()) {
        console.log('模型已存在，跳过下载');
        return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let ok = false;
    for (const url of SOURCES) {
        console.log('下载:', url);
        try {
            execFileSync('curl', ['-sL', '--retry', '3', '--connect-timeout', '20', '-o', ZIP, url], { stdio: 'inherit' });
            // 校验是 zip 而非错误页（buffalo_l.zip 约 275MB）
            const stat = fs.statSync(ZIP);
            if (stat.size < 50 * 1024 * 1024) throw new Error(`文件过小(${stat.size}字节)，疑似下载失败`);
            ok = true;
            break;
        } catch (e) {
            console.warn('失败:', e.message);
        }
    }
    if (!ok) {
        try { fs.unlinkSync(ZIP); } catch (e) {}
        console.error('所有下载源均失败，请检查网络或手动下载 buffalo_l.zip 解压到 models/insightface/');
        process.exit(1);
    }
    // 解压只需要检测+识别两个模型。
    // Windows 没有 unzip 命令，用系统自带 bsdtar（Win10+ 的 tar.exe 支持 zip 及成员选择）
    if (process.platform === 'win32') {
        execFileSync('tar', ['-xf', ZIP, '-C', OUT_DIR, 'det_10g.onnx', 'w600k_r50.onnx'], { stdio: 'inherit' });
    } else {
        execFileSync('unzip', ['-o', ZIP, 'det_10g.onnx', 'w600k_r50.onnx', '-d', OUT_DIR], { stdio: 'inherit' });
    }
    fs.unlinkSync(ZIP);
    console.log('模型下载完成:', fs.readdirSync(OUT_DIR).join(', '));
}

main();
