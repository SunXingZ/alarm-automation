// 从司机人脸截图的左上角水印中识别“抓拍时间”（YYYY-MM-DD HH:MM:SS）。
// 该时间与 GPS 轨迹表同源，是匹配停靠段的正确依据（报警行里的 alerttime 可能是报警登记时间，不等于抓拍时间）。
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

let worker = null;
let workerReady = null;

// 打包后 node_modules 会被打进 app.asar；wasm 与语言包必须放在 asarUnpack 解包目录，
// 运行时从 app.asar.unpacked 读取（asar 内文件无法被原生/Worker 直接加载）
function appResourcesRoot() {
    try {
        const electron = require('electron');
        if (electron && electron.app && electron.app.isPackaged) {
            return path.join(process.resourcesPath, 'app.asar.unpacked');
        }
    } catch (e) { /* 非 electron 环境（如单测）*/ }
    return path.join(__dirname, '..'); // 开发态：项目根目录
}

// 语言包（eng.traineddata.gz）候选目录：打包后优先 app.asar.unpacked，开发态用项目 node_modules
function findLangDir() {
    const root = appResourcesRoot();
    const candidates = [
        path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
        path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
        path.join(root, 'node_modules', '@tesseract.js-data', 'eng'),
        path.join(__dirname, 'tessdata')
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'eng.traineddata.gz')) ||
            fs.existsSync(path.join(dir, 'eng.traineddata'))) {
            return dir;
        }
    }
    return candidates[0];
}

// tesseract.js-core（wasm）目录，打包后需指向解包目录
function findCoreDir() {
    return path.join(appResourcesRoot(), 'node_modules', 'tesseract.js-core');
}

async function getWorker() {
    if (worker) return worker;
    if (!workerReady) {
        workerReady = (async () => {
            // 数字 + 时间/速度分隔符白名单（km/h 的字母也放行，供速度水印识别）
            const w = await createWorker('eng', 1, {
                langPath: findLangDir(),
                corePath: findCoreDir(),
                tessedit_char_whitelist: '0123456789-: .kmhKMG',
                tessedit_pageseg_mode: '7'
            });
            return w;
        })().catch((err) => { workerReady = null; throw err; });
    }
    worker = await workerReady;
    return worker;
}

async function closeWorker() {
    if (worker) {
        try { await worker.terminate(); } catch (e) { /* ignore */ }
        worker = null;
        workerReady = null;
    }
}

// 从识别文本中提取 "YYYY-MM-DD HH:MM:SS"；容忍 -/–/—/./ 等分隔符
function parseTime(text) {
    const s = String(text || '').replace(/[–—–]/g, '-');
    const m = s.match(/(\d{4})\s*[-\s./]\s*(\d{1,2})\s*[-\s./]\s*(\d{1,2})\s*[\s\-–.]*\s*(\d{1,2})\s*[:：.\s]\s*(\d{1,2})\s*[:：.\s]\s*(\d{1,2})/);
    if (!m) return null;
    // 年份异常多为误识别（如把 2026 认成 1026），返回 null 回退报警行时间
    const year = Number(m[1]);
    if (year < 2000 || year > 2099) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const out = `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(out)) return null;
    const d = new Date(out.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return out;
}

// 识别单张截图左上角水印时间；成功返回 "YYYY-MM-DD HH:MM:SS"，否则返回 null
async function readWatermarkTime(imagePath) {
    const w = await getWorker();
    const meta = await sharp(imagePath).metadata();
    if (!meta.width || !meta.height) return null;
    // 时间水印位于左上角：约占顶部 8%、左侧 55% 区域
    const cropW = Math.round(meta.width * 0.55);
    const cropH = Math.round(meta.height * 0.08);

    // 变体2（优先）：极性自适应二值化。深字浅底自动反相，再阈值化，提升低对比/浅色背景下的识别率
    const gray = await sharp(imagePath)
        .extract({ left: 0, top: 0, width: cropW, height: cropH })
        .grayscale().raw().toBuffer({ resolveWithObject: true });
    const gd = gray.data, gw = gray.info.width, gh = gray.info.height;
    let gsum = 0;
    for (let i = 0; i < gd.length; i++) gsum += gd[i];
    const invert = (gsum / gd.length) > 128;
    const bin = Buffer.alloc(gw * gh);
    for (let i = 0; i < gd.length; i++) {
        const v = invert ? 255 - gd[i] : gd[i];
        bin[i] = v > 128 ? 255 : 0;
    }
    const bufBin = await sharp(bin, { raw: { width: gw, height: gh, channels: 1 } })
        .resize({ width: gw * 2, height: gh * 2, kernel: 'lanczos3' })
        .png().toBuffer();
    const tBin = parseTime((await w.recognize(bufBin)).data.text);
    if (tBin) return tBin;

    // 变体1（兜底）：灰度+归一化，放大 2 倍
    const bufGray = await sharp(imagePath)
        .extract({ left: 0, top: 0, width: cropW, height: cropH })
        .resize({ width: cropW * 2, height: cropH * 2, kernel: 'lanczos3' })
        .grayscale().normalize().toBuffer();
    const tGray = parseTime((await w.recognize(bufGray)).data.text);
    return tGray;
}

// 将灰度 buffer 做“极性自适应二值化”（深字浅底自动反相再阈值化），返回 PNG buffer
function binarizeBuffer(gray) {
    const gd = gray.data, gw = gray.info.width, gh = gray.info.height;
    let gsum = 0;
    for (let i = 0; i < gd.length; i++) gsum += gd[i];
    const invert = (gsum / gd.length) > 128;
    const bin = Buffer.alloc(gw * gh);
    for (let i = 0; i < gd.length; i++) {
        const v = invert ? 255 - gd[i] : gd[i];
        bin[i] = v > 128 ? 255 : 0;
    }
    return sharp(bin, { raw: { width: gw, height: gh, channels: 1 } });
}

// 识别右下角速度水印（格式如 "G：71km/h"），返回数字（0 表示静止）；识别失败返回 null
async function readWatermarkSpeed(imagePath) {
    try {
        const w = await getWorker();
        const meta = await sharp(imagePath).metadata();
        if (!meta.width || !meta.height) return null;
        // 速度水印位于右下角：右侧 25% 宽、底部 12% 高
        const left = Math.round(meta.width * 0.75);
        const top = Math.round(meta.height * 0.88);
        const cropW = meta.width - left;
        const cropH = meta.height - top;
        if (cropW <= 0 || cropH <= 0) return null;

        // 变体2（优先）：极性自适应二值化，显著提升浅底/低对比下对 0 的识别
        const gray = await sharp(imagePath)
            .extract({ left, top, width: cropW, height: cropH })
            .grayscale().raw().toBuffer({ resolveWithObject: true });
        const bufBin = await binarizeBuffer(gray)
            .resize({ width: cropW * 3, height: cropH * 3, kernel: 'lanczos3' })
            .png().toBuffer();
        const sBin = parseSpeed((await w.recognize(bufBin)).data.text);
        if (sBin !== null) return sBin;

        // 变体1（兜底）：灰度+归一化
        const bufGray = await sharp(imagePath)
            .extract({ left, top, width: cropW, height: cropH })
            .resize({ width: cropW * 3, height: cropH * 3, kernel: 'lanczos3' })
            .grayscale().normalize().toBuffer();
        return parseSpeed((await w.recognize(bufGray)).data.text);
    } catch (e) {
        return null; // 识别失败不强制丢弃
    }
}

// 从识别文本中提取速度数值；取 "km/h" 前面的数字（前面的 G 等字符不固定，只看数字+km/h）
function parseSpeed(text) {
    let s = String(text || '');
    // OCR 常把数字 0 识别成字母 O/o，先统一回填为 0（"Okm/h" => "0km/h"）
    s = s.replace(/O/g, '0').replace(/o/g, '0');
    // 只认紧跟 km/km/h 的数字（\s 兼容空格/换行）
    const m = s.match(/(\d+(?:\.\d+)?)\s*[kK]\s*[mM]/);
    if (m) {
        const v = parseFloat(m[1]);
        if (Number.isFinite(v)) return v;
    }
    // 兜底：裁剪区本来就是速度专属角落，小字 OCR 常丢掉 km/h 后缀
    // （如 "G：0" 只剩 "G：0"），此时取文本中最后一个数字作为速度
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length) {
        const v = parseFloat(nums[nums.length - 1]);
        if (Number.isFinite(v)) return v;
    }
    return null;
}

module.exports = { readWatermarkTime, readWatermarkSpeed, closeWorker };
