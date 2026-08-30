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

// 本地表格文件：解析文件名中的车牌号与日期并自动填入查询条件
const localFileInput = document.getElementById('local-file');
const filePickBtn = document.getElementById('file-pick-btn');
const fileNameEl = document.getElementById('file-name');

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

filePickBtn.addEventListener('click', () => localFileInput.click());
localFileInput.addEventListener('change', () => {
    const f = localFileInput.files && localFileInput.files[0];
    if (!f) return;
    fileNameEl.textContent = f.name;
    const parsed = parsePlateDateFromFilename(f.name);
    // 容错：只填充解析到的字段，解析不到的保留用户已有输入
    let filled = false;
    if (parsed && parsed.plate) {
        document.getElementById('plate').value = parsed.plate;
        filled = true;
    }
    if (parsed && parsed.date) {
        const start = parsed.time ? `${parsed.date} ${parsed.time}` : `${parsed.date} 00:00:00`;
        document.getElementById('start-date').value = start;
        document.getElementById('end-date').value = `${parsed.date} 23:59:59`;
        filled = true;
    }
    if (!filled) {
        fileNameEl.textContent = '无法解析（文件名需包含 车牌 或 年月日）';
    }
});

document.getElementById('start-btn').addEventListener('click', async () => {
    // 道路运输车辆运营监测分析应用 与 运输车辆监控平台 均需用户在弹出的浏览器中手动登录，无需凭据表单
    const readChecks = (id, parse) => Array.from(document.querySelectorAll('#' + id + ' input:checked')).map(i => parse(i.value));
    const payload = {
        plate: document.getElementById('plate').value.trim(),
        startDate: document.getElementById('start-date').value,
        endDate: document.getElementById('end-date').value,
        alarmTypes: readChecks('alarm-type-filters', parseInt),
        riskLevels: readChecks('risk-level-filters', parseInt),
        repairStatus: readChecks('repair-status-filters', (v) => v)
    };

    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.textContent = '运行中...';

    const logOutput = document.getElementById('log-output');
    logOutput.innerHTML = '';

    // 更新顶部状态徽标
    const statusEl = document.getElementById('log-status');
    const setStatus = (text, cls) => {
        statusEl.textContent = text;
        statusEl.className = 'log-status ' + (cls || '');
    };
    setStatus('运行中', 'running');

    // 监听日志消息
    window.electronAPI.onLogMessage((message) => {
        const div = document.createElement('div');
        div.textContent = message;
        logOutput.appendChild(div);
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    // 开始自动化
    const result = await window.electronAPI.startAutomation(payload);

    if (result.success) {
        alert(`任务完成！结果保存在: ${result.outputDir}`);
        setStatus('完成', 'done');
    } else {
        alert(`任务失败: ${result.error}`);
        setStatus('失败', 'error');
    }

    btn.disabled = false;
    btn.textContent = '开始自动化';
});
