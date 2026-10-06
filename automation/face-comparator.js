// 人脸比对：InsightFace (SCRFD det_10g 检测) + 可切换识别模型 + onnxruntime-node。
// 对外接口与旧 face-api 版完全一致：
//   new FaceComparator({ distanceThreshold, model }) / clusterFaces(imagePaths, log)
//   => [{ representative, members: [imgPath...] }, ...]
// 识别模型输出 512 维 L2 归一化描述子，用欧氏距离判定（同人典型 ~0.7-1.1，异人 ~1.2+）。
// 支持：
//   - 双识别模型切换：r50（ArcFace w600k_r50，稳定） / adaface（AdaFace IR-101 WebFace12M，侧脸/昏暗更准）
//   - 翻转 TTA：水平镜像关键点再提一次特征取平均，提升侧脸鲁棒性
//   - 暗帧增强：亮度不足时 gamma 校正后再检测/嵌入，提升暗光场景召回
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

// 同一人判定阈值边界（欧氏距离，512 维归一化描述子）
const MIN_THRESHOLD = 0.70;
const MAX_THRESHOLD = 1.40;

// ArcFace 标准 5 点模板（112x112 输出图坐标系）
const ARCFACE_DST = [
    [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
    [41.5493, 92.3655], [70.7299, 92.2041]
];
const DET_SIZE = 640;        // SCRFD 输入尺寸（拉伸缩放，与官方实现一致）
const DET_THRESH = 0.35;     // 检测分数阈值（低阈值保召回）
const REC_SIZE = 112;        // 识别模型输入尺寸

// 可切换的识别模型配置：file 为模型目录下 ONNX 文件名；
// defaultThreshold 为该模型默认同一人判定阈值（欧氏距离），切换模型时 UI 用它复位滑块。
// 阈值按真实抓拍数据校准：r50 同人典型 0.4~0.98，异人 ≥1.02；
// adaface 同人 0.54~0.83(+侧脸右尾)、异人 ≥1.17，默认 0.95（见校准记录）。
const MODEL_CONFIGS = {
    r50: {
        file: 'w600k_r50.onnx',
        defaultThreshold: 1.00
    },
    adaface: {
        file: 'adaface_ir101.onnx',
        // 实测校准（真实抓拍截图，r50 聚类标签）：同人 0.54~0.83，异人 1.17~1.40，
        // 分离中点 0.99；取 0.95 略偏宽松以召回侧脸/昏暗困难样本（其在同人分布右尾）
        defaultThreshold: 0.95
    }
};

// 暗帧增强：全图平均亮度低于该值视为昏暗场景，gamma 校正后再检测/嵌入
const DARK_MEAN_THRESHOLD = 70;

// 模块级 session 缓存：检测模型全模型共用；识别模型按 key 缓存。
// 每次任务 new FaceComparator 时避免重复初始化（批量一键处理多次实例化）
const sessionCache = { det: null, rec: {} };

function eucDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}

// 解 4x4 线性方程组（高斯消元，带部分主元）
function solve4(A, b) {
    const M = [A[0].slice(), A[1].slice(), A[2].slice(), A[3].slice()];
    const v = b.slice();
    for (let col = 0; col < 4; col++) {
        let piv = col;
        for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        [M[col], M[piv]] = [M[piv], M[col]];
        [v[col], v[piv]] = [v[piv], v[col]];
        const d = M[col][col];
        if (Math.abs(d) < 1e-12) return null;
        for (let r = col + 1; r < 4; r++) {
            const f = M[r][col] / d;
            for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
            v[r] -= f * v[col];
        }
    }
    const x = new Array(4);
    for (let r = 3; r >= 0; r--) {
        let s = v[r];
        for (let c = r + 1; c < 4; c++) s -= M[r][c] * x[c];
        x[r] = s / M[r][r];
    }
    return x;
}

// 最小二乘估计相似变换 src -> dst（x' = a*x - b*y + tx; y' = b*x + a*y + ty）
function estimateSimilarity(src, dst) {
    // 正规方程 A^T A p = A^T b
    const ata = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const atb = [0, 0, 0, 0];
    for (let i = 0; i < src.length; i++) {
        const [x, y] = src[i];
        const [dx, dy] = dst[i];
        const rows = [[x, -y, 1, 0], [y, x, 0, 1]];
        const vals = [dx, dy];
        for (let r = 0; r < 2; r++) {
            for (let j = 0; j < 4; j++) {
                atb[j] += rows[r][j] * vals[r];
                for (let k = 0; k < 4; k++) ata[j][k] += rows[r][j] * rows[r][k];
            }
        }
    }
    const p = solve4(ata, atb);
    if (!p) return null;
    return { a: p[0], b: p[1], tx: p[2], ty: p[3] };
}

class FaceComparator {
    constructor(options = {}) {
        this.modelLoaded = false;
        this.modelPath = path.join(__dirname, '..', 'models', 'insightface');
        // 识别模型选择：'adaface'（默认，侧脸/昏暗更准） | 'r50'（稳定，可对比验证）
        this.modelKey = MODEL_CONFIGS[options.model] ? options.model : 'adaface';
        // 同一人判定阈值（欧氏距离），由界面滑块传入；未传用当前模型默认值
        const raw = Number(options.distanceThreshold);
        if (Number.isFinite(raw)) {
            this.distanceThreshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, raw));
        } else {
            this.distanceThreshold = MODEL_CONFIGS[this.modelKey].defaultThreshold;
        }
    }

    // 模型目录：打包后在 resources/models/insightface（extraResources 直接复制，不受 asar 影响）；
    // 开发态在项目根 models/insightface
    resolveModelDir() {
        try {
            const packaged = path.join(process.resourcesPath, 'models', 'insightface');
            if (fs.existsSync(path.join(packaged, 'det_10g.onnx'))) return packaged;
        } catch (e) { /* 非 electron 环境无 process.resourcesPath */ }
        return path.join(__dirname, '..', 'models', 'insightface');
    }

    async loadModels() {
        if (this.modelLoaded) return;
        this.modelPath = this.resolveModelDir();
        const detPath = path.join(this.modelPath, 'det_10g.onnx');
        let recPath = path.join(this.modelPath, MODEL_CONFIGS[this.modelKey].file);
        // 识别模型文件缺失时自动回退 r50（如 CI 下载 AdaFace 失败或老包未含该模型），避免任务直接失败
        if (!fs.existsSync(recPath) && this.modelKey !== 'r50') {
            console.warn(`警告：识别模型 ${MODEL_CONFIGS[this.modelKey].file} 缺失，自动回退标准模型 w600k_r50.onnx（可运行 npm run download-models 补齐）`);
            this.modelKey = 'r50';
            recPath = path.join(this.modelPath, MODEL_CONFIGS.r50.file);
        }
        if (!fs.existsSync(detPath) || !fs.existsSync(recPath)) {
            const need = MODEL_CONFIGS[this.modelKey].file;
            throw new Error(`未找到人脸识别模型文件（models/insightface/det_10g.onnx 与 ${need}），请先运行 npm run download-models`);
        }
        // 检测模型共用；识别模型按 key 缓存，避免批量任务重复初始化
        if (!sessionCache.det) {
            sessionCache.det = await ort.InferenceSession.create(fs.readFileSync(detPath));
        }
        if (!sessionCache.rec[this.modelKey]) {
            sessionCache.rec[this.modelKey] = await ort.InferenceSession.create(fs.readFileSync(recPath));
        }
        this.detSession = sessionCache.det;
        this.recSession = sessionCache.rec[this.modelKey];
        this.modelLoaded = true;
    }

    // 读取图片 RGB 原始像素；昏暗场景先做 gamma 校正（提升检测召回与特征质量）
    async loadRawRGB(imagePath) {
        let { data, info } = await sharp(imagePath)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        // 平均亮度（快速抽样：每 16 像素取 1 个，避免 1080p 全量遍历）
        let sum = 0, sampled = 0;
        for (let i = 0; i < data.length; i += 16 * 3) {
            sum += data[i] + data[i + 1] + data[i + 2];
            sampled += 3;
        }
        const mean = sum / sampled;
        if (mean < DARK_MEAN_THRESHOLD) {
            // gamma = log(0.5) / log(mean/255)：把平均亮度拉到中灰
            const gamma = Math.log(0.5) / Math.log(Math.max(mean, 1) / 255);
            const lut = new Uint8Array(256);
            for (let v = 0; v < 256; v++) {
                lut[v] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(v / 255, 1 / gamma))));
            }
            const enhanced = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) enhanced[i] = lut[data[i]];
            data = enhanced;
            return { data, width: info.width, height: info.height, brightness: mean, enhanced: true };
        }
        return { data, width: info.width, height: info.height, brightness: mean };
    }

    // SCRFD 检测：返回最高分人脸 { box:[x1,y1,x2,y2], kps:[[x,y]x5], score }（原图坐标）；未检出返回 null
    async detectFace(img) {
        const { data, width, height } = img;
        // RGB HWC -> CHW float32，(x-127.5)/128
        const pix = DET_SIZE * DET_SIZE;
        const input = new Float32Array(3 * pix);
        for (let y = 0; y < DET_SIZE; y++) {
            const sy = Math.min(height - 1, Math.floor(y * height / DET_SIZE));
            for (let x = 0; x < DET_SIZE; x++) {
                const sx = Math.min(width - 1, Math.floor(x * width / DET_SIZE));
                const si = (sy * width + sx) * 3;
                const di = y * DET_SIZE + x;
                input[di] = (data[si] - 127.5) / 128;
                input[pix + di] = (data[si + 1] - 127.5) / 128;
                input[2 * pix + di] = (data[si + 2] - 127.5) / 128;
            }
        }
        const tensor = new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]);
        const out = await this.detSession.run({ [this.detSession.inputNames[0]]: tensor });

        // det_10g 输出顺序（已探针验证）：[scores_8/16/32, bbox_8/16/32, kps_8/16/32]
        const names = this.detSession.outputNames;
        const scoreOuts = [out[names[0]], out[names[1]], out[names[2]]];
        const bboxOuts = [out[names[3]], out[names[4]], out[names[5]]];
        const kpsOuts = [out[names[6]], out[names[7]], out[names[8]]];

        // 全部锚点里取最高分（只需司机 1 张脸，等价 top-1 检测，省去 NMS）。
        // det_10g 每位置 2 个锚点（如 stride8: 12800 = 80*80*2），两锚点共用同一中心
        const NUM_ANCHORS = 2;
        let best = null;
        for (let s = 0; s < 3; s++) {
            const stride = [8, 16, 32][s];
            const gw = DET_SIZE / stride;      // 网格宽
            const scores = scoreOuts[s].data;
            const n = scores.length;           // gw*gw*NUM_ANCHORS
            for (let i = 0; i < n; i++) {
                const sc = scores[i];
                if (sc < DET_THRESH || (best && sc <= best.score)) continue;
                const pos = Math.floor(i / NUM_ANCHORS);
                const cx = ((pos % gw) + 0.5) * stride;
                const cy = (Math.floor(pos / gw) + 0.5) * stride;
                const bd = bboxOuts[s].data;
                const box = [
                    cx - bd[i * 4] * stride,
                    cy - bd[i * 4 + 1] * stride,
                    cx + bd[i * 4 + 2] * stride,
                    cy + bd[i * 4 + 3] * stride
                ];
                const kd = kpsOuts[s].data;
                const kps = [];
                for (let p = 0; p < 5; p++) {
                    kps.push([cx + kd[i * 10 + p * 2] * stride, cy + kd[i * 10 + p * 2 + 1] * stride]);
                }
                best = { box, kps, score: sc };
            }
        }
        if (!best) return null;
        // 还原到原图坐标（输入是拉伸缩放的）
        const sx = width / DET_SIZE, sy = height / DET_SIZE;
        best.box = [best.box[0] * sx, best.box[1] * sy, best.box[2] * sx, best.box[3] * sy];
        best.kps = best.kps.map(([x, y]) => [x * sx, y * sy]);
        return best;
    }

    // 5 点对齐 + ArcFace 前向：返回 L2 归一化的 512 维描述子
    embedAligned(img, kps) {
        // 相似变换：模板点 -> 原图关键点（用于把输出图坐标映射回原图采样）
        const t = estimateSimilarity(ARCFACE_DST, kps);
        if (!t) return null;
        const { data, width, height } = img;
        const face = new Float32Array(3 * REC_SIZE * REC_SIZE);
        for (let y = 0; y < REC_SIZE; y++) {
            for (let x = 0; x < REC_SIZE; x++) {
                // 原图采样坐标（双线性）
                const ox = t.a * x - t.b * y + t.tx;
                const oy = t.b * x + t.a * y + t.ty;
                const x0 = Math.floor(ox), y0 = Math.floor(oy);
                const fx = ox - x0, fy = oy - y0;
                const xc = Math.max(0, Math.min(width - 1, x0));
                const yc = Math.max(0, Math.min(height - 1, y0));
                const x1 = Math.min(width - 1, xc + 1);
                const y1 = Math.min(height - 1, yc + 1);
                const di = (y * REC_SIZE + x);
                for (let c = 0; c < 3; c++) {
                    const v00 = data[(yc * width + xc) * 3 + c];
                    const v10 = data[(yc * width + x1) * 3 + c];
                    const v01 = data[(y1 * width + xc) * 3 + c];
                    const v11 = data[(y1 * width + x1) * 3 + c];
                    const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
                    face[c * REC_SIZE * REC_SIZE + di] = (v - 127.5) / 128;
                }
            }
        }
        return face;
    }

    // 单次识别前向：返回未归一化的 512 维原始输出
    async runRecognition(aligned) {
        const tensor = new ort.Tensor('float32', aligned, [1, 3, REC_SIZE, REC_SIZE]);
        const out = await this.recSession.run({ [this.recSession.inputNames[0]]: tensor });
        return out[this.recSession.outputNames[0]].data;
    }

    // 翻转 TTA 的镜像关键点：模板顺序为 [左眼,右眼,鼻,左嘴角,右嘴角]，
    // 镜像后左右互换 => [W-x右眼, W-x左眼, W-x鼻, W-x右嘴角, W-x左嘴角]
    mirrorKps(kps, width) {
        const mx = ([x, y]) => [width - x, y];
        return [mx(kps[1]), mx(kps[0]), mx(kps[2]), mx(kps[4]), mx(kps[3])];
    }

    // 5 点对齐 + 识别前向（带翻转 TTA）：原图与水平镜像各提一次特征取平均，
    // L2 归一化后返回 512 维描述子。TTA 对侧脸姿态鲁棒性有小幅稳定提升。
    async extractDescriptor(img, detection) {
        const aligned = this.embedAligned(img, detection.kps);
        if (!aligned) return null;
        const emb = Array.from(await this.runRecognition(aligned));
        try {
            const alignedFlip = this.embedAligned(img, this.mirrorKps(detection.kps, img.width));
            if (alignedFlip) {
                const embFlip = await this.runRecognition(alignedFlip);
                for (let i = 0; i < emb.length; i++) emb[i] += embFlip[i];
            }
        } catch (e) { /* TTA 失败不阻断，仅用原图特征 */ }
        // L2 归一化
        let norm = 0;
        for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
        norm = Math.sqrt(norm);
        if (norm < 1e-6) return null;
        for (let i = 0; i < emb.length; i++) emb[i] /= norm;
        return emb;
    }

    // 提取单张人脸特征，返回 { descriptor, isPartial }；未检出人脸返回 null
    async getFaceDescriptor(imagePath) {
        const img = await this.loadRawRGB(imagePath);
        if (img.enhanced) this.enhancedCount = (this.enhancedCount || 0) + 1;
        const detection = await this.detectFace(img);
        if (!detection) return null;
        // 检测框超出画面 => 人脸被截断（如 2/3 脸），仅作日志统计
        const [x1, y1, x2, y2] = detection.box;
        const overflow = Math.max(0, -x1, -y1, x2 - img.width, y2 - img.height);
        const descriptor = await this.extractDescriptor(img, detection);
        if (!descriptor) return null;
        return { descriptor, isPartial: overflow > 2 };
    }

    // 对人脸聚类，返回每个聚类的代表图与全部成员路径（供换脸检测选取具体截图）
    // 返回形如 [{ representative, members: [imgPath...] }, ...]
    async clusterFaces(imagePaths, log = () => {}) {
        await this.loadModels();
        this.enhancedCount = 0; // 本次聚类暗帧增强张数（用于日志）
        const faces = [];
        let partialCount = 0;
        for (const imgPath of imagePaths) {
            try {
                const result = await this.getFaceDescriptor(imgPath);
                if (result) {
                    if (result.isPartial) partialCount++;
                    faces.push({ imgPath, descriptor: result.descriptor });
                } else {
                    log(`人脸未检出: ${path.basename(imgPath)}`);
                }
            } catch (err) {
                console.warn(`跳过图片 ${imgPath}: ${err.message}`);
            }
        }
        log(`人脸提取: ${faces.length}/${imagePaths.length} 张检出（部分脸 ${partialCount} 张），模型 ${this.modelKey}，阈值 ${this.distanceThreshold.toFixed(2)}${this.enhancedCount ? `，暗帧增强 ${this.enhancedCount} 张` : ''}`);

        // 平均链接（UPGMA）层次聚类：
        // 旧版单链接（任两距离<=阈值即并簇）存在"链式吸附"缺陷——极端姿态/模糊照片的描述子
        // 会作为"桥"把不同司机一环扣一环连进同一簇（实测 GQ6585 两司机被错误合并，漏检换驾）。
        // 平均链接要求两簇间"平均距离"<=阈值才合并，长链在中间的弱连接处被阻断。
        // 实测（GQ6585 09-25 两司机 267 张，人工标注瘦/胖两组）：平均链接两模型均 0 混簇，
        // 代价是同人可能拆成 2~3 簇（多输出拼图，无害）；换驾不漏检优先。
        // 距离矩阵预计算 O(n²)，Lance-Williams 增量更新合并后簇间距。
        const n = faces.length;
        const th = this.distanceThreshold;
        // dist[i][j]：全量两两距离
        const dist = Array.from({ length: n }, () => new Float64Array(n));
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const d = eucDistance(faces[i].descriptor, faces[j].descriptor);
                dist[i][j] = d;
                dist[j][i] = d;
            }
        }
        // 活动簇列表：{ members: [下标], size }
        let clusters = Array.from({ length: n }, (_, i) => ({ members: [i], size: 1 }));
        // clusterDist[aIdx][bIdx]：簇间平均距离（按 clusters 数组下标索引）
        const clusterDist = dist.map((row, i) => row.map((d, j) => (i === j ? Infinity : d)));
        while (clusters.length > 1) {
            let best = Infinity, bi = -1, bj = -1;
            for (let i = 0; i < clusters.length; i++) {
                for (let j = i + 1; j < clusters.length; j++) {
                    if (clusterDist[i][j] < best) { best = clusterDist[i][j]; bi = i; bj = j; }
                }
            }
            if (bi < 0 || best > th) break;
            // 合并 bj 入 bi，Lance-Williams 更新与其余簇的平均距离
            const sizeA = clusters[bi].size, sizeB = clusters[bj].size;
            for (let k = 0; k < clusters.length; k++) {
                if (k === bi || k === bj) continue;
                const merged = (sizeA * clusterDist[bi][k] + sizeB * clusterDist[bj][k]) / (sizeA + sizeB);
                clusterDist[bi][k] = merged;
                clusterDist[k][bi] = merged;
            }
            clusters[bi] = { members: clusters[bi].members.concat(clusters[bj].members), size: sizeA + sizeB };
            // 删除 bj：把末尾簇换到 bj 位置（保持索引连续）
            const last = clusters.length - 1;
            if (bj !== last) {
                clusters[bj] = clusters[last];
                for (let k = 0; k < last; k++) {
                    clusterDist[bj][k] = clusterDist[last][k];
                    clusterDist[k][bj] = clusterDist[k][last];
                }
            }
            clusters.pop();
            for (let k = 0; k < clusters.length; k++) { clusterDist[k][clusters.length] = Infinity; clusterDist[clusters.length][k] = Infinity; }
        }
        const groups = new Map();
        for (const cl of clusters) groups.set(cl.members[0], cl.members);

        // 临界单张吸附：遮挡（如手挡嘴）会让描述子整体偏移，单张被略过阈值拆出；
        // 若单张到某簇（>=3 张）有 >=3 张距离 <= 1.12（多数投票），判定为同人并入。
        // 实测：G-A9196 #63（手遮嘴）到 13 张簇有 5 票被正确召回，其他全部测试车牌不受影响。
        const ABSORB_RADIUS = 1.12;
        const ABSORB_VOTES = 3;
        const absorbed = new Map(); // 单张下标 -> 并入簇 key
        for (const [root, idxs] of groups) {
            if (idxs.length !== 1) continue;
            const me = faces[idxs[0]];
            for (const [root2, idxs2] of groups) {
                if (root2 === root || idxs2.length < ABSORB_VOTES) continue;
                const votes = idxs2.filter(i2 => eucDistance(me.descriptor, faces[i2].descriptor) <= ABSORB_RADIUS).length;
                if (votes >= ABSORB_VOTES) {
                    absorbed.set(root, root2);
                    break;
                }
            }
        }
        // 吸附后重算分组（可能多级吸附：单张并入的簇再被并，此处仅处理一级，与旧版一致）
        for (const [from, to] of absorbed) {
            if (groups.has(from) && groups.has(to) && groups.get(from).length === 1) {
                groups.get(to).push(...groups.get(from));
                groups.delete(from);
            }
        }

        const finalGroups = new Map();
        for (const [, idxs] of groups) {
            finalGroups.set(idxs[0], idxs.map(i => faces[i].imgPath));
        }
        const clustersOut = [...finalGroups.values()];
        clustersOut.forEach((members, idx) => {
            log(`人脸簇 #${idx + 1}: ${members.length} 张，代表图 ${path.basename(members[0])}`);
        });

        return clustersOut.map((members) => ({
            representative: members[0],
            members
        }));
    }
}

module.exports = FaceComparator;
// 供 electron-main 通过 IPC 向渲染进程提供各模型默认阈值（切换模型时 UI 复位滑块）
module.exports.MODEL_CONFIGS = MODEL_CONFIGS;
