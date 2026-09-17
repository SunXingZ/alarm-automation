// 运输车辆监控平台的筛选选项（值来自平台 queryUserAlarmList / 下拉接口）
const ALARM_TYPE_GROUPS = [
    { cls: 'ADAS预警', items: [{ id: 15, name: '前向碰撞预警' }] },
    {
        cls: '驾驶员行为状态预警',
        items: [
            { id: 1, name: '抽烟' },
            { id: 2, name: '接打电话' },
            { id: 3, name: '分神驾驶' },
            { id: 4, name: '驾驶员变更' },
            { id: 5, name: '疲劳驾驶' },
            { id: 6, name: '驾驶员异常' },
            { id: 14, name: '摄像头遮挡' },
            { id: 58, name: '红外阻隔型墨镜报警' },
            { id: 77, name: '驾驶员正脸抓拍' },
            { id: 111, name: '自动抓拍事件' }
        ]
    },
    { cls: '行业报警', items: [{ id: 76, name: '无牌/多次/非法出入境报警' }] },
    {
        cls: '行业下发预警',
        items: [
            { id: 177, name: '市内包车非法出境(行业下发)' },
            { id: 178, name: '超速(行业下发)' },
            { id: 179, name: '疲劳驾驶(行业下发)' },
            { id: 180, name: '2-5 点营运(行业下发)' }
        ]
    },
    { cls: '乘客安全带检测', items: [{ id: 191, name: '乘客未系安全带报警' }] }
];

const RISK_LEVELS = [
    { id: 0, name: '蓝色' },
    { id: 1, name: '黄色' },
    { id: 2, name: '橙色' }
];

const REPAIR_STATUSES = [
    { id: '1', name: '待处理' },
    { id: '2,4', name: '已处置' }
];

// ==================== 通用工具 ====================
// 日志追加（自动滚动到底部）
function appendLog(outputEl, message) {
    const div = document.createElement('div');
    div.textContent = message;
    outputEl.appendChild(div);
    outputEl.scrollTop = outputEl.scrollHeight;
}

// 从路径取文件名（渲染进程无 path 模块）
function pathBasename(p) {
    return String(p || '').split(/[\\/]/).pop();
}

// 车牌号规整：沪X 前缀后加 -（如 沪EE2709 → 沪E-E2709）；已含 - 则保持不变
function formatPlate(p) {
    const s = String(p || '').trim();
    if (!s || s.includes('-')) return s;
    if (/^沪[A-Za-z]/.test(s)) return s.slice(0, 2) + '-' + s.slice(2);
    return s;
}

// 从文件名解析车牌号与日期（含时分秒），_ / - / T / 空格 均可作分隔
// 返回 { plate, date, time }：解析不到的部分为空字符串；整体解析失败返回 null
function parsePlateDateFromFilename(name) {
    const s = String(name || '').trim();
    if (!s) return null;

    // 日期/时间部分：yyyy[_/-]MM[_/-]dd[分隔 HH[:/_ -]mm[:/_ -]ss]
    const dateMatch = s.match(/(\d{4})[_\-](\d{1,2})[_\-](\d{1,2})(?:[T _\-](\d{1,2})[: _\-](\d{1,2})(?:[: _\-](\d{1,2}))?)?/);
    if (!dateMatch) return null;

    const pad = (n) => String(n).padStart(2, '0');
    const date = `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}`;
    let time = '';
    if (dateMatch[4] && dateMatch[5]) {
        time = `${pad(dateMatch[4])}:${pad(dateMatch[5])}`;
        time += dateMatch[6] ? ':' + pad(dateMatch[6]) : ':00';
    }

    // 车牌：日期之前的部分（去掉结尾分隔符与 (n) 后缀）；需形如“省字+字母/数字/横杠”才算解析到
    const rawPlate = s.slice(0, dateMatch.index).replace(/[_\-]+$/, '').trim();
    let plate = '';
    if (/^[\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5-]*$/.test(rawPlate) && /[A-Za-z0-9]/.test(rawPlate)) {
        plate = formatPlate(rawPlate.replace(/\(\d+\)$/, ''));
    }

    return { plate, date, time };
}

// ==================== 顶部选项卡切换 ====================
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === tabId));
}
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ==================== 处理申诉表格（选项卡2，原有功能） ====================
// 生成单个复选框
function makeCheck(value, label) {
    const l = document.createElement('label');
    l.className = 'checkbox-label';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.value = value;
    l.appendChild(c);
    l.appendChild(document.createTextNode(' ' + label));
    return l;
}

// 报警类型（按分组渲染）
const alarmBox = document.getElementById('alarm-type-filters');
for (const g of ALARM_TYPE_GROUPS) {
    const t = document.createElement('div');
    t.className = 'filter-sub-title';
    t.textContent = g.cls;
    alarmBox.appendChild(t);
    g.items.forEach(it => alarmBox.appendChild(makeCheck(String(it.id), it.name)));
}

// 风险等级
const riskBox = document.getElementById('risk-level-filters');
RISK_LEVELS.forEach(it => riskBox.appendChild(makeCheck(String(it.id), it.name)));

// 处理状态
const repairBox = document.getElementById('repair-status-filters');
REPAIR_STATUSES.forEach(it => repairBox.appendChild(makeCheck(String(it.id), it.name)));

// 筛选条件折叠/展开
const filterHeader = document.getElementById('filter-header');
const filterBody = document.getElementById('filter-body');
filterHeader.addEventListener('click', () => {
    const open = filterBody.style.display !== 'none';
    filterBody.style.display = open ? 'none' : 'block';
    filterHeader.classList.toggle('open', !open);
});

// 人脸同一人判定阈值滑块（欧氏距离，显示当前值）
const thresholdSlider = document.getElementById('face-threshold');
const thresholdValue = document.getElementById('face-threshold-value');
const clampThreshold = (v) => Math.min(1.40, Math.max(0.70, Number(v)));
thresholdSlider.addEventListener('input', () => {
    thresholdValue.textContent = clampThreshold(thresholdSlider.value).toFixed(2);
});

// 本地表格文件：解析文件名中的车牌号与日期并自动填入查询条件
const localFileInput = document.getElementById('local-file');
const filePickBtn = document.getElementById('file-pick-btn');
const fileNameEl = document.getElementById('file-name');
let spreadsheetPath = ''; // 选中的表格文件绝对路径（供停靠段匹配读取）
let spreadsheetFromExport = false; // 表格是否来自导出申诉流程（处理成功后需归档到结果目录）

// 用文件名日期填充时间（缺时间按 0-24 点）
function fillDatesFromFilename(parsed) {
    if (!parsed || !parsed.date) return false;
    const start = parsed.time ? `${parsed.date} ${parsed.time}` : `${parsed.date} 00:00:00`;
    document.getElementById('start-date').value = start;
    document.getElementById('end-date').value = `${parsed.date} 23:59:59`;
    return true;
}

filePickBtn.addEventListener('click', () => localFileInput.click());

localFileInput.addEventListener('change', async () => {
    const f = localFileInput.files && localFileInput.files[0];
    if (!f) return;
    fileNameEl.textContent = f.name;
    spreadsheetPath = window.electronAPI.getFilePath(f) || '';
    spreadsheetFromExport = false; // 手动选择的本地表格，不参与归档
    const parsed = parsePlateDateFromFilename(f.name);
    // 容错：只填充解析到的字段，解析不到的保留用户已有输入
    let filled = false;
    if (parsed && parsed.plate) {
        document.getElementById('plate').value = parsed.plate;
        filled = true;
    }
    // 时间：优先读取表格首行~末行的 GPS 时间；读取失败再回退用文件名日期
    if (spreadsheetPath) {
        try {
            const range = await window.electronAPI.getSpreadsheetRange(spreadsheetPath);
            if (range && !range.error && range.start && range.end) {
                document.getElementById('start-date').value = range.start;
                document.getElementById('end-date').value = range.end;
                filled = true;
            } else {
                filled = fillDatesFromFilename(parsed) || filled;
            }
        } catch (e) {
            filled = fillDatesFromFilename(parsed) || filled;
        }
    } else {
        filled = fillDatesFromFilename(parsed) || filled;
    }
    if (!filled) {
        fileNameEl.textContent = '无法解析（文件名需包含 车牌 或 年月日）';
    }
});

// 处理日志：只注册一次，避免多次运行后日志重复（此前每次点击都会重复注册）
const logOutput = document.getElementById('log-output');
const statusEl = document.getElementById('log-status');
window.electronAPI.onLogMessage((message) => appendLog(logOutput, message));

const setStatus = (text, cls) => {
    statusEl.textContent = text;
    statusEl.className = 'log-status ' + (cls || '');
};

const startBtn = document.getElementById('start-btn');
let processRunning = false;

// 启动处理流程（读取选项卡2 表单当前值组装 payload）
// opts.silent: 不弹完成/失败提示（一键处理批量模式使用）
// opts.openDirOnFinish: 是否在完成后自动打开输出目录（批量模式为 false，结束后统一打开）
async function startProcess(opts = {}) {
    if (processRunning) {
        return { success: false, error: '已有任务在运行中，请等待完成' };
    }
    const readChecks = (id, parse) => Array.from(document.querySelectorAll('#' + id + ' input:checked')).map(i => parse(i.value));
    const payload = {
        plate: document.getElementById('plate').value.trim(),
        startDate: document.getElementById('start-date').value,
        endDate: document.getElementById('end-date').value,
        alarmTypes: readChecks('alarm-type-filters', parseInt),
        riskLevels: readChecks('risk-level-filters', parseInt),
        repairStatus: readChecks('repair-status-filters', (v) => v),
        spreadsheetPath: spreadsheetPath || '',
        faceThreshold: clampThreshold(thresholdSlider.value),
        openDirOnFinish: opts.openDirOnFinish !== false,
        copySpreadsheet: spreadsheetFromExport // 自动导入的表格在成功后归档到结果目录
    };

    processRunning = true;
    startBtn.disabled = true;
    startBtn.querySelector('.btn-text').textContent = '运行中...';
    logOutput.innerHTML = '';
    setStatus('运行中', 'running');

    const result = await window.electronAPI.startAutomation(payload);

    if (result.success) {
        setStatus('完成', 'done');
        if (!opts.silent) alert(`任务完成！结果保存在: ${result.outputDir}`);
    } else {
        setStatus('失败', 'error');
        if (!opts.silent) alert(`任务失败: ${result.error}`);
    }

    processRunning = false;
    startBtn.disabled = false;
    startBtn.querySelector('.btn-text').textContent = '开始自动化';
    return result;
}

startBtn.addEventListener('click', () => startProcess());

// ==================== 导出申诉表格（选项卡1，新增功能） ====================
const exportBtn = document.getElementById('export-btn');
const processAllBtn = document.getElementById('process-all-btn');
const exportLogOutput = document.getElementById('export-log-output');
const exportLogStatus = document.getElementById('export-log-status');
const exportSummary = document.getElementById('export-summary');
const exportResultBody = document.getElementById('export-result-body');

let exportResults = [];          // 导出结果（含实时状态，多批次累积）
const exportRowMap = new Map();  // index -> tr 行元素
let exporting = false;
let batchRunning = false;
let batchOffset = 0;             // 当前批次写入累积表格的起始下标
const processedOrderNos = new Set(); // 本次会话已成功处理过的申诉（一键处理去重，防重复处理同一申诉）

const setExportStatus = (text, cls) => {
    exportLogStatus.textContent = text;
    exportLogStatus.className = 'log-status ' + (cls || '');
};

window.electronAPI.onExportLogMessage((message) => appendLog(exportLogOutput, message));
window.electronAPI.onExportProgress((p) => {
    if (!p || typeof p.index !== 'number') return;
    const idx = batchOffset + p.index;
    exportResults[idx] = { ...(exportResults[idx] || {}), ...p };
    renderExportRow(idx);
    updateExportSummary();
});

const STATUS_TEXT = {
    exporting: '导出中',
    exported: '已导出',
    processing: '处理中',
    processed: '已处理',
    failed: '失败'
};

function statusTag(status) {
    return `<span class="status-tag status-${status}">${STATUS_TEXT[status] || status || '待处理'}</span>`;
}

function updateExportSummary() {
    if (!exportResults.length) {
        exportSummary.textContent = '';
        return;
    }
    const ok = exportResults.filter(r => r.status === 'exported' && (!r.orderNo || !processedOrderNos.has(r.orderNo))).length; // 可处理 = 已导出、未处理过（口径与一键处理一致）
    const done = exportResults.filter(r => r.status === 'processed').length;
    const fail = exportResults.filter(r => r.status === 'failed').length;
    let summary = `共 ${exportResults.length} 条 · 可处理 ${ok}`;
    if (done) summary += ` · 已处理 ${done}`;
    if (fail) summary += ` · 失败 ${fail}`;
    exportSummary.textContent = summary;
    processAllBtn.disabled = batchRunning || exporting || !exportResults.some(r => r.status === 'exported' && (!r.orderNo || !processedOrderNos.has(r.orderNo)));
}

// 渲染/更新某一行导出结果（含下载与处理按钮）
function renderExportRow(index) {
    const r = exportResults[index];
    if (!r) return;
    let tr = exportRowMap.get(index);
    if (!tr) {
        // 清掉占位空行
        const empty = exportResultBody.querySelector('.empty-row');
        if (empty) empty.remove();
        tr = document.createElement('tr');
        exportRowMap.set(index, tr);
        exportResultBody.appendChild(tr);
    }
    const canDownload = !!r.filePath;
    tr.innerHTML = `
        <td>${r.plate || '-'}</td>
        <td class="time-cell">${r.startTime || '-'}</td>
        <td class="time-cell">${r.endTime || '-'}</td>
        <td>${statusTag(r.status)}</td>
        <td class="ops-cell"></td>`;
    const ops = tr.querySelector('.ops-cell');

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'mini-btn';
    dlBtn.textContent = '下载表格';
    dlBtn.disabled = !canDownload;
    dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        const res = await window.electronAPI.saveExportedFile(r.filePath, pathBasename(r.filePath));
        dlBtn.disabled = false;
        if (res && res.error) alert(`保存失败: ${res.error}`);
    });

    // 处理/导入按钮保持常亮可点；运行时点击由 processSingleComplaint / startProcess 内的防重入保护拦截
    const prBtn = document.createElement('button');
    prBtn.type = 'button';
    prBtn.className = 'mini-btn';
    prBtn.textContent = '处理申诉';
    prBtn.addEventListener('click', () => processSingleComplaint(index));

    // 仅导入：填入处理申诉选项卡但不自动执行（用户手动点“开始自动化”）
    const imBtn = document.createElement('button');
    imBtn.type = 'button';
    imBtn.className = 'mini-btn';
    imBtn.textContent = '导入表格';
    imBtn.addEventListener('click', () => {
        loadComplaintIntoProcessForm(exportResults[index]);
        switchTab('tab-process');
    });

    ops.appendChild(prBtn);
    ops.appendChild(imBtn);
    ops.appendChild(dlBtn);
}

exportBtn.addEventListener('click', async () => {
    if (exporting || batchRunning || processRunning) return;
    // 读取本次导出数量（正整数；空/非法 = 不限制）
    const limitVal = document.getElementById('export-limit').value.trim();
    const limit = limitVal === '' ? 0 : (parseInt(limitVal, 10) || 0);
    if (limitVal !== '' && limit <= 0) {
        alert('导出数量需为正整数，或留空表示全部');
        return;
    }
    exporting = true;
    exportBtn.disabled = true;
    exportBtn.querySelector('.btn-text').textContent = '导出中...';
    exportLogOutput.innerHTML = '';
    batchOffset = exportResults.length; // 新批次追加到既有记录之后（累积显示）
    setExportStatus('运行中', 'running');

    const result = await window.electronAPI.exportComplaintTables(limit);

    if (result && result.success) {
        // 以本次批次结果为准，追加/补全到累积表格（实时进度已画的行不覆盖）
        const results = result.results || [];
        results.forEach((item, i) => {
            const idx = batchOffset + i;
            exportResults[idx] = { ...(exportResults[idx] || {}), ...item };
            renderExportRow(idx);
        });
        updateExportSummary();
        const fail = exportResults.slice(batchOffset).filter(r => r && r.status === 'failed').length;
        setExportStatus(fail ? `完成（新增 ${results.length} 条，${fail} 条失败）` : `完成（新增 ${results.length} 条）`, fail ? 'error' : 'done');
    } else {
        appendLog(exportLogOutput, `导出失败：${(result && result.error) || '未知错误'}`);
        setExportStatus('失败', 'error');
    }

    exporting = false;
    exportBtn.disabled = false;
    exportBtn.querySelector('.btn-text').textContent = '开始导出';
    updateExportSummary(); // exporting 复位后刷新一键处理按钮的可用状态
});

// ==================== 处理申诉（单个 / 一键批量） ====================
// 把导出表格自动“导入”到处理申诉表格选项卡：填入文件、车牌、起止时间
function loadComplaintIntoProcessForm(r) {
    switchTab('tab-process');
    document.getElementById('plate').value = formatPlate(r.plate);
    document.getElementById('start-date').value = r.startTime || '';
    document.getElementById('end-date').value = r.endTime || '';
    spreadsheetPath = r.filePath || '';
    spreadsheetFromExport = true; // 来自导出流程，处理成功后归档到结果目录
    fileNameEl.textContent = r.filePath ? pathBasename(r.filePath) : '未选择';
}

// 处理单条导出的申诉：跳转选项卡并自动执行
async function processSingleComplaint(index) {
    if (processRunning || batchRunning || exporting) return;
    const r = exportResults[index];
    if (!r || !r.filePath) return;
    loadComplaintIntoProcessForm(r);
    const row = exportRowMap.get(index);
    r.status = 'processing';
    if (row) renderExportRow(index);
    updateExportSummary();

    const result = await startProcess();

    r.status = result.success ? 'processed' : 'failed';
    r.error = result.error || '';
    if (result.success && r.orderNo) processedOrderNos.add(r.orderNo); // 单条处理成功同样记入，一键处理不再重复碰
    if (row) renderExportRow(index);
    updateExportSummary();
}

// 一键处理：按顺序把每个已导出且未处理过的表格导入并执行自动化处理
// （同一条申诉即使多批次重复出现在表格中，也只处理一次；单条处理按钮不受此限制，可随时重跑）
processAllBtn.addEventListener('click', async () => {
    const seen = new Set();
    const list = exportResults
        .map((r, i) => ({ r, i }))
        .filter(x => x.r.status === 'exported' && (!x.r.orderNo || !processedOrderNos.has(x.r.orderNo)))
        .filter(x => {
            if (!x.r.orderNo) return true; // 无单号的行不去重
            if (seen.has(x.r.orderNo)) return false; // 同一申诉只处理一次
            seen.add(x.r.orderNo);
            return true;
        });
    if (!list.length || batchRunning || processRunning || exporting) return;
    if (!confirm(`共 ${list.length} 个表格，将依次自动处理（每个处理完再处理下一个），确认开始？`)) return;

    batchRunning = true;
    processAllBtn.disabled = true;
    exportBtn.disabled = true;
    processAllBtn.querySelector('.btn-text').textContent = '批量处理中...';
    let failCount = 0;

    for (const { r, i } of list) {
        loadComplaintIntoProcessForm(r);
        r.status = 'processing';
        renderExportRow(i);
        updateExportSummary();

        const result = await startProcess({ silent: true, openDirOnFinish: false });
        if (result.success) {
            r.status = 'processed';
            if (r.orderNo) processedOrderNos.add(r.orderNo);
        } else {
            r.status = 'failed';
            r.error = result.error || '';
            failCount++;
        }
        renderExportRow(i);
        updateExportSummary();
    }

    // 批量结束后统一打开输出根目录（AlarmAutomationOutput）
    const err = await window.electronAPI.openOutputDir('');
    if (err) appendLog(logOutput, `自动打开保存目录失败: ${err}`);
    alert(`批量处理完成：成功 ${list.length - failCount}，失败 ${failCount}`);

    batchRunning = false;
    processAllBtn.disabled = false;
    exportBtn.disabled = false;
    processAllBtn.querySelector('.btn-text').textContent = '一键处理申诉表格';
});
