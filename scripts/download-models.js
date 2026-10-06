// 下载人脸识别模型到 models/insightface/：
//   1. InsightFace buffalo_l（det_10g.onnx + w600k_r50.onnx）
//   2. AdaFace IR-101 WebFace12M（adaface_ir101.onnx，高精度可选模型）
// 用法：npm run download-models（本地新 clone 后执行一次；CI 构建时自动执行）。
// 依次尝试官方源及多个镜像源，全部失败则报错退出。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'models', 'insightface');
const ZIP = path.join(OUT_DIR, 'buffalo_l.zip');

// deepinsight/insightface v0.7 的 buffalo_l.zip（含检测+识别等 5 个模型）
const BUFFALO_SOURCES = [
    'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    'https://ghfast.top/https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    'https://ghproxy.net/https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
];

// AdaFace IR-101（WebFace12M 训练，侧脸/昏暗更准）：ONNX 直链 + 国内 hf-mirror 镜像
// 约 260MB；输入 RGB 112x112 (x-127.5)/128，输出 512 维，与 ArcFace 管线同构
const ADAFACE_FILE = 'adaface_ir101.onnx';
const ADAFACE_SOURCES = [
    'https://huggingface.co/Evn9172/cvlface_adaface_ir101_webface12m_onnx/resolve/main/adaface_ir101.onnx',
    'https://hf-mirror.com/Evn9172/cvlface_adaface_ir101_webface12m_onnx/resolve/main/adaface_ir101.onnx'
];
const ADAFACE_MIN_BYTES = 200 * 1024 * 1024; // 完整模型约 260MB，防止下载到错误页

function download(sources, dest, minBytes) {
    for (const url of sources) {
        console.log('下载:', url);
        try {
            execFileSync('curl', ['-sL', '--retry', '3', '--connect-timeout', '20', '-o', dest, url], { stdio: 'inherit' });
            const stat = fs.statSync(dest);
            if (stat.size < minBytes) throw new Error(`文件过小(${stat.size}字节)，疑似下载失败`);
            return true;
        } catch (e) {
            console.warn('失败:', e.message);
        }
    }
    return false;
}

function downloadBuffalo() {
    if (fs.existsSync(path.join(OUT_DIR, 'det_10g.onnx')) &&
        fs.existsSync(path.join(OUT_DIR, 'w600k_r50.onnx'))) {
        console.log('buffalo_l 模型已存在，跳过下载');
        return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!download(BUFFALO_SOURCES, ZIP, 50 * 1024 * 1024)) {
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
}

function downloadAdaface() {
    const dest = path.join(OUT_DIR, ADAFACE_FILE);
    if (fs.existsSync(dest)) {
        console.log('AdaFace 模型已存在，跳过下载');
        return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!download(ADAFACE_SOURCES, dest, ADAFACE_MIN_BYTES)) {
        fs.unlinkSync(dest);
        // AdaFace 为可选高精度模型：下载失败不阻断主流程（标准模型 r50 仍可用），
        // 仅在用户选择高精度模型时才会因缺文件报错提示重跑本脚本
        console.warn('警告：AdaFace 模型下载失败，高精度模型选项暂不可用（标准模型不受影响）。可重新运行 npm run download-models 重试。');
        return;
    }
}

function main() {
    downloadBuffalo();
    downloadAdaface();
    console.log('模型下载完成:', fs.readdirSync(OUT_DIR).join(', '));
}

main();
