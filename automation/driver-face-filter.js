const sharp = require('sharp');

// 司机人脸截图特征：四角均带水印文字
//   左上=时间、右上=车牌、左下=经纬度、右下=速度
// 非司机截图通常只有左上角时间水印，其余三角无文字。
// 阈值基于实际样本标定（司机截图四角边缘密度 0.036~0.10，非司机其余角 ≤0.04），可按需调整。

const CORNER_W_RATIO = 0.30;   // 角区域宽度占比
const CORNER_H_RATIO = 0.12;   // 角区域高度占比
const EDGE_DIFF = 40;          // 相邻像素亮度差阈值（超过视为边缘）
const TEXT_RATIO = 0.02;       // 角内边缘像素占比超过该值视为“有水印文字”
const REQUIRED_CORNERS = 4;    // 需要四角都具备文字

// 计算一个角区域内是否有文字状内容（基于边缘像素密度）
function cornerHasText(data, width, height, channels) {
    const total = (width - 1) * (height - 1);
    if (total <= 0) return false;
    let edges = 0;
    for (let y = 1; y < height; y++) {
        for (let x = 1; x < width; x++) {
            const i = (y * width + x) * channels;
            const cur = data[i];
            const up = data[((y - 1) * width + x) * channels];
            const left = data[(y * width + (x - 1)) * channels];
            if (Math.abs(cur - up) > EDGE_DIFF || Math.abs(cur - left) > EDGE_DIFF) edges++;
        }
    }
    return edges / total > TEXT_RATIO;
}

// 判断是否为司机人脸截图（四角均检测到水印文字）
async function isDriverScreenshot(filePath) {
    const meta = await sharp(filePath).metadata();
    const W = meta.width;
    const H = meta.height;
    const cw = Math.max(10, Math.round(W * CORNER_W_RATIO));
    const ch = Math.max(10, Math.round(H * CORNER_H_RATIO));
    const corners = [
        { left: 0, top: 0 },              // 左上：时间
        { left: W - cw, top: 0 },         // 右上：车牌
        { left: 0, top: H - ch },         // 左下：经纬度
        { left: W - cw, top: H - ch }     // 右下：速度
    ];

    let texted = 0;
    for (const { left, top } of corners) {
        if (left < 0 || top < 0) return false;
        const { data, info } = await sharp(filePath)
            .extract({ left, top, width: cw, height: ch })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        if (cornerHasText(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            info.width, info.height, info.channels
        )) texted++;
    }
    return texted >= REQUIRED_CORNERS;
}

module.exports = { isDriverScreenshot };
