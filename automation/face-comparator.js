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

class FaceComparator {
    constructor() {
        this.modelLoaded = false;
        this.modelPath = path.join(__dirname, '..', 'models'); // 模型目录
        // 检测使用 TinyFaceDetector 小模型（速度快），配合 landmark + recognition 提取特征
        this.detector = 'tinyFaceDetector';
    }

    async loadModels() {
        if (this.modelLoaded) return;
        // 确保模型文件存在
        if (!fs.existsSync(path.join(this.modelPath, 'tiny_face_detector_model-weights_manifest.json'))) {
            throw new Error('未找到人脸识别模型文件，请将模型文件放入 models 目录');
        }
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

        return tf.tensor3d(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            [info.height, info.width, info.channels]
        );
    }

    async getFaceDescriptor(imagePath) {
        const tensor = await this.loadImageTensor(imagePath);
        try {
            const options = new faceapi.TinyFaceDetectorOptions({
                inputSize: 320,       // 输入尺寸（32 的倍数），越小越快
                scoreThreshold: 0.5
            });
            const detection = await faceapi.detectSingleFace(tensor, options)
                .withFaceLandmarks()
                .withFaceDescriptor();
            return detection ? detection.descriptor : null;
        } finally {
            tensor.dispose();
        }
    }

    // 对所有图片进行人脸聚类，返回每个不同人脸的一张代表图片路径
    async clusterFaces(imagePaths) {
        await this.loadModels();
        const faceData = [];
        for (const imgPath of imagePaths) {
            try {
                const desc = await this.getFaceDescriptor(imgPath);
                if (desc) faceData.push({ imgPath, descriptor: desc });
            } catch (err) {
                console.warn(`跳过图片 ${imgPath}: ${err.message}`);
            }
        }

        const clusters = []; // 每个元素是 { representative, repDescriptor, members: [imgPath] }
        for (const item of faceData) {
            let matchedCluster = null;
            for (const cluster of clusters) {
                const similarity = faceapi.euclideanDistance(item.descriptor, cluster.repDescriptor);
                if (similarity < 0.6) { // 阈值可调
                    matchedCluster = cluster;
                    break;
                }
            }
            if (matchedCluster) {
                matchedCluster.members.push(item.imgPath);
            } else {
                clusters.push({
                    representative: item.imgPath,
                    repDescriptor: item.descriptor,
                    members: [item.imgPath]
                });
            }
        }

        return clusters.map(c => c.representative);
    }
}

module.exports = FaceComparator;
