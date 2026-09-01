// 人脸比对：InsightFace (SCRFD det_10g 检测 + ArcFace w600k_r50 识别) + onnxruntime-node。
// 对外接口与旧 face-api 版完全一致：
//   new FaceComparator({ distanceThreshold }) / clusterFaces(imagePaths, log)
//   => [{ representative, members: [imgPath...] }, ...]
// ArcFace 输出 512 维 L2 归一化描述子，用欧氏距离判定（同人典型 ~0.7-1.1，异人 ~1.2+）。
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
const REC_SIZE = 112;        // ArcFace 输入尺寸

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
        // 同一人判定阈值（欧氏距离），由界面滑块传入；未传用默认 1.00
        // 实测校准：同人典型 0.4~0.98，异人 ≥1.02；1.00 对全部测试车牌均正确分离
        const raw = Number(options.distanceThreshold);
        this.distanceThreshold = Number.isFinite(raw)
            ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, raw))
            : 1.00;
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
        const recPath = path.join(this.modelPath, 'w600k_r50.onnx');
        if (!fs.existsSync(detPath) || !fs.existsSync(recPath)) {
            throw new Error('未找到人脸识别模型文件（models/insightface/det_10g.onnx 与 w600k_r50.onnx），请先运行 npm run download-models');
        }
        this.detSession = await ort.InferenceSession.create(fs.readFileSync(detPath));
        this.recSession = await ort.InferenceSession.create(fs.readFileSync(recPath));
        this.modelLoaded = true;
    }

    // 读取图片 RGB 原始像素
    async loadRawRGB(imagePath) {
        const { data, info } = await sharp(imagePath)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
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

    async extractDescriptor(img, detection) {
        const aligned = this.embedAligned(img, detection.kps);
        if (!aligned) return null;
        const tensor = new ort.Tensor('float32', aligned, [1, 3, REC_SIZE, REC_SIZE]);
        const out = await this.recSession.run({ [this.recSession.inputNames[0]]: tensor });
        const emb = Array.from(out[this.recSession.outputNames[0]].data);
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
        log(`人脸提取: ${faces.length}/${imagePaths.length} 张检出（部分脸 ${partialCount} 张），阈值 ${this.distanceThreshold.toFixed(2)}`);

        // 并查集单链接聚类（连通分量）：
        // 同一人的正脸/侧脸/部分脸能通过中间帧链到同一簇（解决旧版“只与代表图比对”导致的过拆分），
        // 不同人因距离超过阈值保持分离。ArcFace 对姿态变化鲁棒，正侧脸距离明显小于异人间距。
        const n = faces.length;
        const parent = Array.from({ length: n }, (_, i) => i);
        const find = (x) => {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        };
        const th = this.distanceThreshold;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (eucDistance(faces[i].descriptor, faces[j].descriptor) <= th) {
                    const ri = find(i);
                    const rj = find(j);
                    if (ri !== rj) parent[ri] = rj;
                }
            }
        }

        const groups = new Map();
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(i);
        }

        // 临界单张吸附：遮挡（如手挡嘴）会让描述子整体偏移，单张被略过阈值拆出；
        // 若单张到某簇（>=3 张）有 >=3 张距离 <= 1.12（多数投票），判定为同人并入。
        // 实测：G-A9196 #63（手遮嘴）到 13 张簇有 5 票被正确召回，其他全部测试车牌不受影响。
        const ABSORB_RADIUS = 1.12;
        const ABSORB_VOTES = 3;
        for (const [root, idxs] of groups) {
            if (idxs.length !== 1) continue;
            const me = faces[idxs[0]];
            for (const [root2, idxs2] of groups) {
                if (root2 === root || idxs2.length < ABSORB_VOTES) continue;
                const votes = idxs2.filter(i2 => eucDistance(me.descriptor, faces[i2].descriptor) <= ABSORB_RADIUS).length;
                if (votes >= ABSORB_VOTES) {
                    parent[root] = root2;
                    break;
                }
            }
        }

        // 重算分组（吸附后）
        const finalGroups = new Map();
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!finalGroups.has(root)) finalGroups.set(root, []);
            finalGroups.get(root).push(faces[i].imgPath);
        }
        const clusters = [...finalGroups.values()];
        clusters.forEach((members, idx) => {
            log(`人脸簇 #${idx + 1}: ${members.length} 张，代表图 ${path.basename(members[0])}`);
        });

        return clusters.map((members) => ({
            representative: members[0],
            members
        }));
    }
}

module.exports = FaceComparator;
