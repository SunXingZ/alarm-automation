// tfjs-node 的 dist 仍调用 Node 17+ 已移除的 util.isNullOrUndefined / util.isArray，
// 在加载 tfjs-node 前补齐 polyfill，避免在新版 Node（Electron 内置 Node 24）下报错
const nodeUtil = require('util');
if (typeof nodeUtil.isNullOrUndefined !== 'function') {
    nodeUtil.isNullOrUndefined = (v) => v === null || v === undefined;
}
if (typeof nodeUtil.isArray !== 'function') {
    nodeUtil.isArray = (v) => Array.isArray(v);
}

// 必须先加载 tfjs-node（TensorFlow C++ 后端），再加载 face-api，才能启用原生加速
require('@tensorflow/tfjs-node');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api');

// @vladmandic/face-api 导出的 tf 即其内部使用的 tfjs-core 实例；
// 因上方已加载 tfjs-node，默认后端为 'tensorflow'（原生 C++ 加速）。
const tf = faceapi.tf;

// 同一人判定阈值边界（欧氏距离）。
// 注意：该识别网络输出的是“未归一化”的 128 维描述子（范数约 1.3），
// 必须用欧氏距离衡量，不能用余弦相似度的常规阈值（0.4~0.5），
// 否则所有脸都会被判为同一人（实测同人余弦也在 0.85 以上）。
const MIN_THRESHOLD = 0.40;
const MAX_THRESHOLD = 0.65;

function eucDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}

class FaceComparator {
    constructor(options = {}) {
        this.modelLoaded = false;
        this.modelPath = path.join(__dirname, '..', 'models'); // 模型目录
        // 同一人判定阈值（欧氏距离），由界面滑块传入；未传用默认 0.45。
        const raw = Number(options.distanceThreshold);
        this.distanceThreshold = Number.isFinite(raw)
            ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, raw))
            : 0.45;
    }

    async loadModels() {
        if (this.modelLoaded) return;
        // 确保模型文件存在
        if (!fs.existsSync(path.join(this.modelPath, 'ssd_mobilenetv1_model-weights_manifest.json'))) {
            throw new Error('未找到人脸识别模型文件，请将模型文件放入 models 目录');
        }
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(this.modelPath);
        await faceapi.nets.tinyFaceDetector.loadFromDisk(this.modelPath);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelPath);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelPath);
        this.modelLoaded = true;
    }

    // 读取图片并转为 RGB 三通道张量
    async loadImageTensor(imagePath) {
        const { data, info } = await sharp(imagePath)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const tensor = tf.tensor3d(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            [info.height, info.width, info.channels]
        );
        return { tensor, info };
    }

    // 在给定张量上跑检测链（牺牲速度换召回率）：SSD(0.4) -> SSD(0.15) -> Tiny(0.2)
    async detectChain(tensor) {
        const detect = (options) => faceapi.detectSingleFace(tensor, options)
            .withFaceLandmarks()
            .withFaceDescriptor();
        let detection = await detect(new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4, maxResults: 1 }));
        if (!detection) {
            detection = await detect(new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15, maxResults: 1 }));
        }
        if (!detection) {
            detection = await detect(new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }));
        }
        return detection;
    }

    // 提取单张人脸特征，返回 { descriptor, isPartial }；未检出人脸返回 null
    async getFaceDescriptor(imagePath) {
        const { tensor, info } = await this.loadImageTensor(imagePath);
        try {
            const detection = await this.detectChain(tensor);
            if (!detection) return null;

            // 检测框超出画面 => 人脸被截断（如 2/3 脸），仅作日志统计
            const box = detection.detection.box;
            const overflow = Math.max(0, -box.x, -box.y, box.x + box.width - info.width, box.y + box.height - info.height);

            return { descriptor: detection.descriptor, isPartial: overflow > 2 };
        } finally {
            tensor.dispose();
        }
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
        // 不同人因距离超过阈值保持分离。实测同人链距离 ≤0.47，不同人 ≥0.52，默认阈值 0.50 可较好分离。
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
            groups.get(root).push(faces[i].imgPath);
        }
        const clusters = [...groups.values()];
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
