const BrowserManager = require('./browser-manager');
const ServiceA = require('./service-a');
const ServiceB = require('./service-b');
const FaceComparator = require('./face-comparator');
const { isDriverScreenshot } = require('./driver-face-filter');
const { downloadImage, compressToJpg } = require('./image-saver');
const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

async function runAutomation(options = {}, log = console.log) {
    const { outputDir = path.join(__dirname, '..', 'output'), plate, startDate, endDate, alarmTypes, riskLevels, repairStatus } = options;

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
        const comparator = new FaceComparator();
        // 临时目录必须放可写位置（userData），打包后 __dirname 在只读 app.asar 内
        const tmpDir = path.join(app.getPath('userData'), 'tmp_screenshots');
        fs.ensureDirSync(tmpDir);
        fs.ensureDirSync(outputDir);

        // 目录名安全化（去除路径非法字符）
        const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        let totalScreenshots = 0;
        let totalFaces = 0;
        const savedDirs = []; // 实际保存了人脸的目录（用于完成后自动打开）

        // 逐订单处理：按“车牌 + 日期”独立下载、聚类、保存
        for (const order of orders) {
            log(`正在处理车牌: ${order.plate}，时间: ${order.startDate} ~ ${order.endDate}`);
            const urls = await serviceB.searchAndGetScreenshots(
                order.plate, order.startDate, order.endDate, filters
            );
            if (urls.length === 0) {
                log(`车牌 ${order.plate} 未找到截图，跳过`);
                continue;
            }
            totalScreenshots += urls.length;

            // 下载该订单截图到临时目录
            const localPaths = [];
            for (let i = 0; i < urls.length; i++) {
                const filePath = path.join(tmpDir, `${sanitize(order.plate)}_${i}.jpg`);
                try {
                    await downloadImage(urls[i], filePath);
                    localPaths.push(filePath);
                } catch (err) {
                    log(`下载截图失败: ${urls[i]} - ${err.message}`);
                }
            }
            log(`车牌 ${order.plate} 成功下载 ${localPaths.length} 张截图`);
            if (localPaths.length === 0) continue;

            // 只保留司机人脸截图（四角均有水印文字），过滤非司机照片
            const driverPaths = [];
            for (const p of localPaths) {
                try {
                    if (await isDriverScreenshot(p)) {
                        driverPaths.push(p);
                    } else {
                        fs.removeSync(p); // 删除非司机截图，减少后续比对量
                    }
                } catch (err) {
                    log(`司机截图判定失败: ${p} - ${err.message}`);
                }
            }
            log(`车牌 ${order.plate} 司机截图 ${driverPaths.length}/${localPaths.length} 张`);
            if (driverPaths.length === 0) continue;

            // 该订单单独人脸聚类，获取不同人脸的代表截图
            const representativePaths = await comparator.clusterFaces(driverPaths);
            log(`车牌 ${order.plate} 识别出 ${representativePaths.length} 个不同人脸`);
            totalFaces += representativePaths.length;

            // 保存到 output/<车牌>_<日期>/face_NNN.jpg（单层目录）
            const orderDir = path.join(outputDir, sanitize(order.plate) + '_' + sanitize(order.startDate).slice(0, 10));
            fs.ensureDirSync(orderDir);
            savedDirs.push(orderDir);
            for (let i = 0; i < representativePaths.length; i++) {
                const outputPath = path.join(orderDir, `face_${String(i + 1).padStart(3, '0')}.jpg`);
                await compressToJpg(representativePaths[i], outputPath, 3);
                log(`保存: ${outputPath}`);
            }
        }

        log(`共获取 ${totalScreenshots} 张截图，保存 ${totalFaces} 个不同人脸`);
        log('任务完成');
        return { success: true, outputDir, savedDirs };
    } catch (err) {
        log(`任务失败: ${err.message}`);
        return { success: false, error: err.message };
    } finally {
        await BrowserManager.close();
    }
}

module.exports = { runAutomation };