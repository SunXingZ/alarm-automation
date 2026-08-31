const BrowserManager = require('./browser-manager');
const ServiceA = require('./service-a');
const ServiceB = require('./service-b');
const FaceComparator = require('./face-comparator');
const { isDriverScreenshot } = require('./driver-face-filter');
const { downloadImage, compressToJpg } = require('./image-saver');
const { readSpreadsheet, findStopsInWindow, pickClosestStop, findSpeedAtTime } = require('./stop-finder');
const { composeFaceStopImage } = require('./image-composer');
const { readWatermarkTime, readWatermarkSpeed, closeWorker } = require('./watermark-ocr');
const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

async function runAutomation(options = {}, log = console.log) {
    const { outputDir = path.join(__dirname, '..', 'output'), plate, startDate, endDate, alarmTypes, riskLevels, repairStatus, spreadsheetPath, faceThreshold } = options;

    // 道路运输车辆运营监测分析应用流程开关（暂时屏蔽，后续改回 true 即可恢复）
    const ENABLE_SERVICE_A = false;

    // 运输车辆监控平台筛选条件（不勾选则为空，查询时不限制）
    const filters = { alarmTypes: alarmTypes || [], riskLevels: riskLevels || [], repairStatus: repairStatus || [] };

    try {
        log('开始自动化流程...');
        // 登录需用户手动在浏览器窗口中操作，必须使用可见窗口（有头模式）
        await BrowserManager.launch(false);
        log('浏览器已启动（请在弹出的窗口手动登录）');

        // 组装待处理订单：填写了车牌则跳过道路运输车辆运营监测分析应用，直接查询运输车辆监控平台
        const today = () => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        let orders;
        if (plate) {
            orders = [{ plate, startDate: startDate || today(), endDate: endDate || today() }];
            log(`已指定车牌 ${plate}，直接查询运输车辆监控平台`);
        } else if (ENABLE_SERVICE_A) {
            // 道路运输车辆运营监测分析应用：获取待处理订单（登录由用户手动完成，登录后自动继续）
            const serviceA = new ServiceA(log);
            orders = await serviceA.getPendingOrders();
            log(`找到 ${orders.length} 个待处理订单`);
            if (orders.length === 0) {
                log('没有待处理订单，任务结束');
                return { success: true, outputDir };
            }
        } else {
            log('道路运输车辆运营监测分析应用流程已暂时屏蔽，且未填写车牌号，无法获取待处理订单，任务结束');
            return { success: true, outputDir };
        }

        // 运输车辆监控平台：查询并下载截图（登录由用户手动完成，登录后自动继续）
        const serviceB = new ServiceB(log);
        const comparator = new FaceComparator({ distanceThreshold: faceThreshold });
        // 临时目录必须放可写位置（userData），打包后 __dirname 在只读 app.asar 内
        const tmpDir = path.join(app.getPath('userData'), 'tmp_screenshots');
        fs.ensureDirSync(tmpDir);
        fs.ensureDirSync(outputDir);

        // 目录名安全化（去除路径非法字符）
        const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        let totalScreenshots = 0;
        let totalFaces = 0;
        const savedDirs = []; // 实际保存了人脸的目录（用于完成后自动打开）

        // 逐订单处理：按“车牌 + 日期”独立下载、聚类、保存，并按表格匹配停靠段
        for (const order of orders) {
            log(`正在处理车牌: ${order.plate}，时间: ${order.startDate} ~ ${order.endDate}`);
            const photos = await serviceB.searchAndGetScreenshots(
                order.plate, order.startDate, order.endDate, filters
            );
            if (photos.length === 0) {
                log(`车牌 ${order.plate} 未找到截图，跳过`);
                continue;
            }
            totalScreenshots += photos.length;

            // 下载该订单截图到临时目录（记录每张截图对应的报警时间）
            const localPaths = []; // [{ path, time }]
            for (let i = 0; i < photos.length; i++) {
                const filePath = path.join(tmpDir, `${sanitize(order.plate)}_${i}.jpg`);
                try {
                    await downloadImage(photos[i].url, filePath);
                    localPaths.push({ path: filePath, time: photos[i].time || '' });
                } catch (err) {
                    log(`下载截图失败: ${photos[i].url} - ${err.message}`);
                }
            }
            log(`车牌 ${order.plate} 成功下载 ${localPaths.length} 张截图`);
            if (localPaths.length === 0) continue;

            // 只保留司机人脸截图（四角均有水印文字），过滤非司机照片
            const driverPaths = []; // [{ path, time }]
            for (const item of localPaths) {
                try {
                    if (await isDriverScreenshot(item.path)) {
                        driverPaths.push(item);
                    } else {
                        fs.removeSync(item.path); // 删除非司机截图，减少后续比对量
                    }
                } catch (err) {
                    log(`司机截图判定失败: ${item.path} - ${err.message}`);
                }
            }
            log(`车牌 ${order.plate} 司机截图 ${driverPaths.length}/${localPaths.length} 张`);
            if (driverPaths.length === 0) continue;

            // 用截图水印上的"抓拍时间"覆盖报警行解析的时间：两者可能不一致，
            // 水印时间与 GPS 轨迹表同源，是匹配停靠段的正确依据（否则停靠段会落在人脸时间范围外）
            for (const item of driverPaths) {
                try {
                    const wmTime = await readWatermarkTime(item.path);
                    if (wmTime) {
                        item.time = wmTime;
                    } else {
                        log(`水印时间识别失败，保留报警行时间: ${item.time}`);
                    }
                } catch (err) {
                    log(`水印时间识别异常: ${item.path} - ${err.message}`);
                }
            }

            // 提前解析表格（供速度过滤交叉验证与后续停靠段匹配共用）
            const parsed = spreadsheetPath ? readSpreadsheet(spreadsheetPath) : null;
            if (parsed && parsed.error) {
                log(`解析表格失败: ${parsed.error}`);
            }

            // 右下角速度水印为 0（车静止，司机可能在摄像头外）则丢弃该截图。
            // 优先用表格交叉验证（水印时间与 GPS 轨迹同源，秒级精确，比小字 OCR 可靠）；
            // 表格匹配不到时才回退 OCR 右下角速度水印
            const speedRows = parsed && !parsed.error ? parsed.rows : null;
            const validDriverPaths = [];
            for (const item of driverPaths) {
                let speed = null;
                if (speedRows) {
                    speed = findSpeedAtTime(speedRows, item.time, 60);
                }
                if (speed === null) {
                    try {
                        speed = await readWatermarkSpeed(item.path);
                    } catch (err) {
                        log(`速度水印识别异常，保留: ${path.basename(item.path)} - ${err.message}`);
                    }
                }
                if (speed !== null && speed < 0.5) {
                    log(`速度为 0 丢弃: ${path.basename(item.path)}`);
                    fs.removeSync(item.path);
                    continue;
                }
                validDriverPaths.push(item);
            }
            log(`车牌 ${order.plate} 速度过滤后剩余 ${validDriverPaths.length}/${driverPaths.length} 张`);
            if (validDriverPaths.length === 0) continue;

            // 该订单单独人脸聚类，返回每个聚类（不同人脸）及全部成员截图
            const clusters = await comparator.clusterFaces(validDriverPaths.map(x => x.path), log);
            log(`车牌 ${order.plate} 识别出 ${clusters.length} 个不同人脸`);
            totalFaces += clusters.length;

            // 输出目录：output/<车牌>_<日期>（单层目录，人脸与停靠拼图都放这里）
            const orderDir = path.join(outputDir, sanitize(order.plate) + '_' + sanitize(order.startDate).slice(0, 10));
            fs.ensureDirSync(orderDir);
            savedDirs.push(orderDir);

            // 表格停靠段匹配（换脸时刻）：按时间顺序汇总每个聚类的成员出现时间，
            // 相邻出现的人脸属于不同聚类即“换脸”事件；每次换脸以 旧脸最后一次出现 + 新脸第一次出现 为窗口，
            // 在表格内找 0 速段及前后 >0 速行，各生成一张拼图
            if (!spreadsheetPath) continue;
            const timeByPath = new Map(validDriverPaths.map(x => [x.path, x.time]));
            const occ = [];
            clusters.forEach((c, ci) => {
                for (const p of c.members) {
                    const t = timeByPath.get(p) || '';
                    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) occ.push({ path: p, time: t, ci });
                }
            });
            occ.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
            // 相邻出现的人脸聚类不同 => 换脸事件
            const changes = [];
            for (let k = 0; k < occ.length - 1; k++) {
                if (occ[k].ci !== occ[k + 1].ci) changes.push({ old: occ[k], new: occ[k + 1] });
            }
            log(`表格匹配：${occ.length} 张含人脸截图 / ${clusters.length} 个不同人脸，检测到 ${changes.length} 个换脸事件`);
            if (changes.length === 0) {
                log('未检测到换脸事件，跳过停靠段匹配');
                continue;
            }

            // 单独保存的人脸截图 = 拼图中用到的换脸人脸（旧脸最后一次出现 + 新脸第一次出现），按出现顺序去重后按时间排序
            const faceSet = [];
            const seenPaths = new Set();
            for (const ch of changes) {
                for (const fc of [ch.old, ch.new]) {
                    if (!seenPaths.has(fc.path)) {
                        seenPaths.add(fc.path);
                        faceSet.push(fc);
                    }
                }
            }
            faceSet.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
            for (let i = 0; i < faceSet.length; i++) {
                const outputPath = path.join(orderDir, `face_${String(i + 1).padStart(3, '0')}.jpg`);
                await compressToJpg(faceSet[i].path, outputPath, 3);
                log(`保存: ${outputPath}（${faceSet[i].time}）`);
            }

            if (!parsed || parsed.error) { log('表格不可用，跳过停靠段拼图'); continue; }
            const tOf = (s) => new Date(String(s).replace(' ', 'T'));
            let stopNo = 0;
            for (const ch of changes) {
                const stops = findStopsInWindow(parsed.rows, tOf(ch.old.time), tOf(ch.new.time));
                // 窗口内只取最靠近窗口终点（新脸出现时刻）的那一次停靠
                const chosen = pickClosestStop(stops, ch.new.time);
                if (!chosen) {
                    log(`换脸 ${ch.old.time}(旧) ~ ${ch.new.time}(新)：窗口内无停靠段，跳过`);
                    continue;
                }
                stopNo++;
                const outPath = path.join(orderDir, `stop_${String(stopNo).padStart(3, '0')}.jpg`);
                try {
                    await composeFaceStopImage(
                        [ch.old.path, ch.new.path],
                        chosen, order.plate, parsed.header, parsed.headerStyles, parsed.widths, outPath, tmpDir
                    );
                    log(`换脸 ${ch.old.time}(旧) ~ ${ch.new.time}(新)：共 ${stops.length} 个停靠段，取最靠近 ${ch.new.time} 的 1 个 -> 保存 ${outPath}（${chosen.rows.length} 行）`);
                } catch (err) {
                    log(`停靠段拼图失败: ${err.message}`);
                }
            }
        }

        log(`共获取 ${totalScreenshots} 张截图，保存 ${totalFaces} 个不同人脸`);
        log('任务完成');
        return { success: true, outputDir, savedDirs };
    } catch (err) {
        log(`任务失败: ${err.message}`);
        return { success: false, error: err.message };
    } finally {
        await closeWorker();
        await BrowserManager.close();
    }
}

module.exports = { runAutomation };