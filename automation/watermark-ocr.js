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
            // 数字 + 时间/速度分隔符白名单；km/h 的字母、经纬度 E/N、通道号 CH 一并放行，
            // 供内容驱动的整条水印带识别（不同版式下水印内容不变，位置会变）
            const w = await createWorker('eng', 1, {
                langPath: findLangDir(),
                corePath: findCoreDir(),
                tessedit_char_whitelist: '0123456789-: .kmhKMGENCH',
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

// 将灰度 buffer 做“极性自适应二值化”（深字浅底自动反相再阈值化），返回 sharp 实例
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

// OCR 指定区域，返回识别文本。
// variant='bin'：极性自适应二值化（优先，浅底/低对比更稳）；'gray'：灰度归一化（兜底）
async function ocrRegionOnce(imagePath, region, scale, variant) {
    const { left, top, width, height } = region;
    if (width <= 0 || height <= 0) return '';
    const w = await getWorker();
    const base = sharp(imagePath).extract({ left, top, width, height }).grayscale();
    let buf;
    if (variant === 'bin') {
        const gray = await base.raw().toBuffer({ resolveWithObject: true });
        buf = await binarizeBuffer(gray)
            .resize({ width: width * scale, height: height * scale, kernel: 'lanczos3' })
            .png().toBuffer();
    } else {
        buf = await base
            .resize({ width: width * scale, height: height * scale, kernel: 'lanczos3' })
            .normalize().png().toBuffer();
    }
    return (await w.recognize(buf)).data.text || '';
}

// 读取一张截图上的全部水印信息（内容驱动：按水印“内容”解析，不依赖信息在哪个角）。
// 平台水印版式会变（如经纬度从左侧第二行移到顶部、速度为 "0 KM/H" 或 "G：71km/h"），
// 因此按“整条水印带”取文本再按内容解析：
//   顶部带：通道号 / GPS 时间 / 车牌 / 经纬度
//   底部带：速度（字很小，必须裁剪放大；整条带会被画面内容干扰，故只取右下小区域）
// 返回 { time: "YYYY-MM-DD HH:MM:SS"|null, speed: number|null, hasGpsWatermark: boolean }
async function readWatermarkInfo(imagePath) {
    const info = { time: null, speed: null, hasGpsWatermark: false };
    const meta = await sharp(imagePath).metadata();
    if (!meta.width || !meta.height) return info;
    const W = meta.width, H = meta.height;

    // 顶部整条带（全宽）：时间、车牌、经纬度都在这里，不限定左右
    const topRegion = { left: 0, top: 0, width: W, height: Math.round(H * 0.22) };
    let topText = await ocrRegionOnce(imagePath, topRegion, 2, 'bin');
    info.time = parseTime(topText);
    if (!info.time) {
        const t2 = await ocrRegionOnce(imagePath, topRegion, 2, 'gray');
        info.time = parseTime(t2);
        topText += '\n' + t2;
    }

    // 速度：右下小区域（字迹极小，全宽带会被车身/座垫纹理干扰误读成 228/18 之类）
    const spot = { left: Math.round(W * 0.70), top: Math.round(H * 0.86), width: W - Math.round(W * 0.70), height: H - Math.round(H * 0.86) };
    let spotText = await ocrRegionOnce(imagePath, spot, 3, 'bin');
    info.speed = parseSpeed(spotText);
    if (info.speed === null) {
        const t2 = await ocrRegionOnce(imagePath, spot, 3, 'gray');
        spotText += '\n' + t2;
        info.speed = parseSpeed(t2);
    }

    // 抓拍图判定：识别到时间、速度或经纬度之任一，即认为带 GPS 水印的抓拍截图。
    // 是否有人脸交给后续人脸检测判断（无人脸自然会被丢弃），这里只过滤完全无水印的插图。
    let all = topText + '\n' + spotText;
    // 顶带完全没读出内容时，再取底部整条带兜底判定（避免误杀）
    if (!info.time && info.speed === null && !/[EN]\s*\d{1,3}/.test(all)) {
        const botTop = Math.round(H * 0.86);
        all += '\n' + await ocrRegionOnce(imagePath, { left: 0, top: botTop, width: W, height: H - botTop }, 2, 'bin');
    }
    info.hasGpsWatermark = !!info.time || info.speed !== null || /[EN]\s*\d{1,3}/.test(all);
    return info;
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
    // 兜底：裁剪区本来就是速度专属角落，小字 OCR 常丢掉 km/h 后缀，
    // 且速度前缀字母不固定（G/V/S/E…，白名单外的会被 OCR 丢弃）。
    // 无论前缀是什么字母，取文本中最后一个数字作为速度
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length) {
        const v = parseFloat(nums[nums.length - 1]);
        if (Number.isFinite(v)) return v;
    }
    return null;
}

module.exports = { readWatermarkInfo, closeWorker };
