const BrowserManager = require('./browser-manager');
const fs = require('fs-extra');
const path = require('path');
const { compressToJpg } = require('./image-saver');

// HTML 转义，避免单元格内容破坏结构
function escapeHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Excel 标准 64 色索引调色板（SheetJS indexed 颜色）
const INDEXED_COLORS = [
    '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
    '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
    '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080',
    '#9999FF', '#993366', '#FFFFCC', '#CCFFFF', '#660066', '#FF8080', '#0066CC', '#CCCCFF',
    '#000080', '#FF00FF', '#FFFF00', '#00FFFF', '#800080', '#800000', '#008080', '#0000FF',
    '#00CCFF', '#CCFFFF', '#CCFFCC', '#FFFF99', '#99CCFF', '#FF99CC', '#CC99FF', '#FFCC99',
    '#3366FF', '#33CCCC', '#99CC00', '#FFCC00', '#FF9900', '#FF6600', '#666699', '#969696',
    '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333'
];

// 将 SheetJS 颜色对象解析为 CSS 颜色
function resolveColor(color) {
    if (!color) return null;
    if (color.rgb) {
        let rgb = color.rgb.replace('#', '');
        if (rgb.length === 8) rgb = rgb.slice(2); // ARGB → RGB
        if (/^[0-9a-fA-F]{6}$/.test(rgb)) return '#' + rgb;
        return null;
    }
    if (typeof color.indexed === 'number') return INDEXED_COLORS[color.indexed] || null;
    return null; // theme 颜色难以直接映射，忽略
}

// 将 SheetJS 单元格样式对象映射为内联 CSS
function styleToCss(s) {
    if (!s) return '';
    const parts = [];
    if (s.font) {
        const f = s.font;
        if (f.name) parts.push(`font-family:"${f.name}","宋体","SimSun","PingFang SC",sans-serif`);
        if (f.sz) parts.push(`font-size:${f.sz}px`);
        if (f.bold) parts.push('font-weight:bold');
        if (f.italic) parts.push('font-style:italic');
        const c = resolveColor(f.color);
        if (c) parts.push(`color:${c}`);
    }
    if (s.fill && s.fill.patternType && s.fill.fgColor) {
        const c = resolveColor(s.fill.fgColor);
        if (c) parts.push(`background-color:${c}`);
    }
    if (s.alignment) {
        const al = s.alignment;
        if (al.horizontal) parts.push(`text-align:${al.horizontal}`);
        if (al.vertical) parts.push(`vertical-align:${al.vertical}`);
        if (al.wrapText) parts.push('white-space:normal');
    }
    const borderStyleMap = { hair: '1px solid', thin: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted', double: '3px double' };
    if (s.border) {
        for (const side of ['top', 'bottom', 'left', 'right']) {
            const b = s.border[side];
            if (b && b.style) {
                const col = resolveColor(b.color) || '#000000';
                parts.push(`border-${side}:${borderStyleMap[b.style] || '1px solid'} ${col}`);
            }
        }
    }
    return parts.join(';');
}

// 将人脸截图与该停靠段的表格行拼成一张 JPG（≤3M），纵向布局：
// 上面为“旧脸”（换脸前最后一次出现）→ 中间为“新脸”（换脸后第一次出现）→ 下面为该换脸时段内的停靠段表格
// 表格按原表完整列、单元格级样式与列宽渲染（不包含原表标题行），保持与原表一致
async function composeFaceStopImage(facePaths, seg, plate, header, headerStyles, widths, outputPath, tmpDir) {
    const faceImgs = (Array.isArray(facePaths) ? facePaths : [facePaths])
        .map(p => {
            const b64 = fs.readFileSync(p).toString('base64');
            return `<div class="face"><img src="data:image/jpeg;base64,${b64}"></div>`;
        }).join('');

    const colgroup = widths.map(w => `<col${w ? ` style="width:${w}px"` : ''}>`).join('');
    const ths = header.map((h, c) => {
        const css = styleToCss(headerStyles[c]);
        return `<th${css ? ` style="${css}"` : ''}>${escapeHtml(h)}</th>`;
    }).join('');
    const rowsHtml = seg.rows.map((r) => {
        const tds = r.cells.map((v, c) => {
            const css = styleToCss(r.styles[c]);
            return `<td${css ? ` style="${css}"` : ''}>${escapeHtml(v)}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body { margin: 0; font-family: "宋体", "SimSun", "PingFang SC", "Microsoft YaHei", serif; background: #fff; }
        .compose { width: fit-content; padding: 8px; }
        .face { text-align: center; margin-bottom: 8px; }
        .face img { max-width: 1200px; max-height: 420px; }
        table { border-collapse: collapse; font-size: 13px; color: #000; background: #fff; }
        th, td { padding: 4px 8px; text-align: left; white-space: nowrap; }
    </style></head><body><div class="compose" id="compose">
        ${faceImgs}
        <table>
            <colgroup>${colgroup}</colgroup>
            <thead><tr>${ths}</tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    </div></body></html>`;

    const htmlPath = path.join(tmpDir, 'compose_tmp.html');
    fs.writeFileSync(htmlPath, html, 'utf8');

    const page = await BrowserManager.newPage();
    try {
        // 视口放宽，保证完整列都能被截到（列宽较大时表格可能超过 1320）
        await page.setViewport({ width: 2600, height: 1600, deviceScaleFactor: 1 });
        await page.goto('file://' + htmlPath, { waitUntil: 'load' });
        await new Promise(r => setTimeout(r, 400));
        const el = await page.$('#compose');
        if (!el) throw new Error('拼图元素未渲染');
        const buf = await el.screenshot({ type: 'jpeg', quality: 88 });
        const tmpJpg = path.join(tmpDir, 'compose_tmp.jpg');
        fs.writeFileSync(tmpJpg, buf);
        // 压缩到 ≤3M 后写入最终路径
        await compressToJpg(tmpJpg, outputPath, 3);
        fs.removeSync(tmpJpg);
    } finally {
        await page.close();
        fs.removeSync(htmlPath);
    }
}

module.exports = { composeFaceStopImage };
