// CI 打包后校验（Windows）：确认原生模块被解出 asar、模型文件在 asar 包内。
// 用法：node scripts/verify-pack-win.js（在仓库根目录、构建产物 dist/win-unpacked 存在时执行）
const fs = require('fs');
const path = require('path');

const RES = path.join('dist', 'win-unpacked', 'resources');
const UNPACKED_NM = path.join(RES, 'app.asar.unpacked', 'node_modules');
let fail = false;

// 递归查找匹配文件
function findFiles(dir, filter) {
    const hits = [];
    if (!fs.existsSync(dir)) return hits;
    const walk = (d) => {
        for (const name of fs.readdirSync(d)) {
            const p = path.join(d, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else if (filter(name)) hits.push(p);
        }
    };
    walk(dir);
    return hits;
}

function requireHit(label, dir, filter) {
    const hits = findFiles(dir, filter);
    if (hits.length) {
        hits.forEach(h => console.log(`OK: ${h}`));
        return true;
    }
    console.log(`MISSING: ${label}（在 ${dir} 下未找到）`);
    fail = true;
    return false;
}

// 1. onnxruntime-node 原生绑定（实际文件名 onnxruntime_binding.node）与 DLL
requireHit('onnxruntime 原生绑定 (*.node)', path.join(UNPACKED_NM, 'onnxruntime-node'), (n) => n.endsWith('.node'));
requireHit('onnxruntime DLL', path.join(UNPACKED_NM, 'onnxruntime-node'), (n) => /^onnxruntime.*\.dll$/i.test(n));

// 2. sharp win32 原生绑定
requireHit('sharp win32 绑定', path.join(UNPACKED_NM, '@img'), (n) => /^sharp-win32-x64-.*\.node$/.test(n));

// 3. 人脸模型通过 extraResources 复制到 resources/models（不进 asar）
const modelDir = path.join(RES, 'models', 'insightface');
for (const m of ['det_10g.onnx', 'w600k_r50.onnx']) {
    const p = path.join(modelDir, m);
    if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) {
        console.log(`OK: ${p} (${(fs.statSync(p).size / 1024 / 1024).toFixed(1)}MB)`);
    } else {
        console.log(`MISSING: ${p}`);
        fail = true;
    }
}

process.exit(fail ? 1 : 0);
