const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

async function downloadImage(url, destPath) {
    // proxy: false 忽略环境里的代理变量（避免本地代理未运行时下载失败），直连下载
    const response = await axios({ url, responseType: 'arraybuffer', proxy: false });
    await fs.promises.writeFile(destPath, response.data);
}

// 压缩图片为 JPG 且不超过 maxSizeMB 兆字节
async function compressToJpg(inputPath, outputPath, maxSizeMB = 3) {
    let quality = 90;
    const maxBytes = maxSizeMB * 1024 * 1024;
    while (quality > 10) {
        const buffer = await sharp(inputPath)
            .jpeg({ quality })
            .toBuffer();
        if (buffer.length <= maxBytes) {
            await sharp(buffer).toFile(outputPath);
            return;
        }
        quality -= 10;
    }
    // 若仍超限，进一步缩小尺寸
    const metadata = await sharp(inputPath).metadata();
    const newWidth = Math.floor(metadata.width * 0.8);
    await sharp(inputPath)
        .resize({ width: newWidth })
        .jpeg({ quality: 80 })
        .toFile(outputPath);
}

module.exports = { downloadImage, compressToJpg };