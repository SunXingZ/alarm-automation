const XLSX = require('xlsx');

// 读取 xls/xlsx，返回按时间升序的数据行数组（保留单元格级样式供拼图复刻）
// 表头行需包含“GPS时间”和“速度(km/h)”等列（第一行常为标题，自动定位表头行）
function readSpreadsheet(filePath) {
    const wb = XLSX.readFile(filePath, { cellStyles: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const nCols = range.e.c + 1;
    const nRows = range.e.r + 1;

    const text = (cell) => (cell ? XLSX.utils.format_cell(cell).trim() : '');

    // 读取全部单元格（保留样式对象）
    const grid = [];
    for (let r = 0; r < nRows; r++) {
        const row = [];
        for (let c = 0; c < nCols; c++) row.push(ws[XLSX.utils.encode_cell({ r, c })] || null);
        grid.push(row);
    }

    const headerIdx = grid.findIndex(row =>
        row.some(c => text(c).includes('GPS时间')) && row.some(c => text(c).includes('速度'))
    );
    if (headerIdx < 0) return { error: '未找到表头（需包含 GPS时间 和 速度 列）' };

    const headerRow = grid[headerIdx];
    const header = headerRow.map(c => text(c));
    const headerStyles = headerRow.map(c => (c && c.s) || null);
    const idx = (kw) => header.findIndex(h => h.includes(kw));
    const iTime = idx('GPS时间');
    const iSpeed = idx('速度');
    if (iTime < 0 || iSpeed < 0) return { error: '缺少 GPS时间 或 速度 列' };
    const iDir = idx('方向');
    const iLng = idx('经度');
    const iLat = idx('纬度');
    const iAddr = idx('地址');

    // 列宽：优先 wpx，否则按 wch 字符数估算（无则空，浏览器自适应）
    const widths = (ws['!cols'] || []).map(col => {
        if (!col) return null;
        if (col.wpx) return Math.round(col.wpx);
        if (col.wch) return Math.round(col.wch * 7 + 12);
        return null;
    });

    const data = [];
    for (let r = headerIdx + 1; r < nRows; r++) {
        const row = grid[r];
        const timeStr = text(row[iTime]);
        if (!timeStr) continue;
        const d = new Date(timeStr.replace(' ', 'T'));
        if (isNaN(d.getTime())) continue;
        data.push({
            time: d,
            timeStr,
            speed: parseFloat(text(row[iSpeed])) || 0,
            direction: iDir >= 0 ? text(row[iDir]) : '',
            lng: iLng >= 0 ? text(row[iLng]) : '',
            lat: iLat >= 0 ? text(row[iLat]) : '',
            address: iAddr >= 0 ? text(row[iAddr]) : '',
            cells: row.map(c => text(c)),            // 每列显示文本（format_cell 按原格式）
            styles: row.map(c => (c && c.s) || null) // 每列单元格样式
        });
    }
    data.sort((a, b) => a.time - b.time);
    return { rows: data, header, headerStyles, widths };
}

// 在 [start, end] 内查找停靠段：连续速度=0 的行，并补充其前/后最近的速度>0 边界行
function findStopsInWindow(rows, start, end) {
    const segs = [];
    const n = rows.length;
    let i = 0;
    while (i < n) {
        const r = rows[i];
        if (r.time < start) { i++; continue; }
        if (r.time > end) break;
        if (r.speed !== 0) { i++; continue; }

        // 连续 0 速段
        const run = [r];
        let j = i + 1;
        while (j < n && rows[j].time <= end && rows[j].speed === 0) { run.push(rows[j]); j++; }

        // 前一个速度>0 的行（可能略早于窗口起点）
        let before = null;
        for (let k = i - 1; k >= 0; k--) { if (rows[k].speed > 0) { before = rows[k]; break; } }
        // 后一个速度>0 的行（可能略晚于窗口终点）
        let after = null;
        for (let k = j; k < n; k++) { if (rows[k].speed > 0) { after = rows[k]; break; } }

        const segRows = [];
        if (before) segRows.push(before);
        segRows.push(...run);
        if (after) segRows.push(after);

        segs.push({
            rows: segRows,
            startTimeStr: segRows[0].timeStr,
            endTimeStr: segRows[segRows.length - 1].timeStr
        });
        i = j;
    }
    return segs;
}

// 在多个停靠段中，取“发生时刻”最靠近指定时间的那一段
// 停靠段发生时刻取该段内第一条 0 速行的时间
function pickClosestStop(stops, endTimeStr) {
    if (!stops || stops.length === 0) return null;
    const end = new Date(String(endTimeStr).replace(' ', 'T')).getTime();
    let best = null;
    let bestDist = Infinity;
    for (const s of stops) {
        const zeroRow = s.rows.find(r => r.speed === 0) || s.rows[0];
        const t = new Date(zeroRow.timeStr.replace(' ', 'T')).getTime();
        const dist = Math.abs(t - end);
        if (dist < bestDist) {
            bestDist = dist;
            best = s;
        }
    }
    return best;
}

// 主入口：给定表格文件与（已升序的）人脸时间点数组，
// 相邻人脸时间构成窗口，返回每个窗口内的停靠段
function findStopsForFaceTimes(filePath, faceTimes) {
    const parsed = readSpreadsheet(filePath);
    if (parsed.error) return { error: parsed.error };

    const times = faceTimes
        .map(t => new Date(String(t).replace(' ', 'T')))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);
    if (times.length < 2) return { rowCount: parsed.rows.length, header: parsed.header, headerStyles: parsed.headerStyles, widths: parsed.widths, windows: [] };

    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

    const windows = [];
    for (let k = 0; k < times.length - 1; k++) {
        windows.push({
            startTimeStr: fmt(times[k]),
            endTimeStr: fmt(times[k + 1]),
            stops: findStopsInWindow(parsed.rows, times[k], times[k + 1])
        });
    }
    return { rowCount: parsed.rows.length, header: parsed.header, headerStyles: parsed.headerStyles, widths: parsed.widths, windows };
}

// 读取表格的时间范围：第一行（最早）到最后一行的 GPS 时间
function getSpreadsheetTimeRange(filePath) {
    const parsed = readSpreadsheet(filePath);
    if (parsed.error) return { error: parsed.error };
    if (parsed.rows.length === 0) return { error: '表格无有效数据行' };
    return {
        start: parsed.rows[0].timeStr,
        end: parsed.rows[parsed.rows.length - 1].timeStr,
        rowCount: parsed.rows.length
    };
}

module.exports = { readSpreadsheet, findStopsInWindow, findStopsForFaceTimes, pickClosestStop, getSpreadsheetTimeRange };
