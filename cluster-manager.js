#!/usr/bin/env node

/**
 * Whisper WASM 集群管理器
 * 使用 Node.js cluster 模块实现多进程架构
 * 充分利用多核 CPU，提升并发处理能力
 */

import cluster from 'cluster';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件和目录信息
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取 CPU 核心数，用于确定创建的子进程数量
const numCPUs = os.cpus().length;

console.log(`🚀 Whisper WASM 集群管理器启动`);
console.log(`💻 系统 CPU 核心数: ${numCPUs}`);

if (cluster.isPrimary) {
    console.log(`👑 主进程 (PID: ${process.pid}) 启动`);
    
    // 记录工作进程数量
    let workerCount = 0;
    
    // 创建子进程
    for (let i = 0; i < numCPUs; i++) {
        createWorker();
    }
    
    // 创建工作进程的函数
    function createWorker() {
        const worker = cluster.fork();
        workerCount++;
        console.log(`👷 工作进程 (PID: ${worker.process.pid}) 已创建，当前工作进程数: ${workerCount}`);
        
        // 监听工作进程退出事件
        worker.on('exit', (code, signal) => {
            workerCount--;
            console.log(`⚠️  工作进程 (PID: ${worker.process.pid}) 退出，代码: ${code}, 信号: ${signal}`);
            console.log(`📊 当前工作进程数: ${workerCount}`);
            
            // 如果工作进程不是正常退出（代码不为0），则重启
            if (code !== 0 && !worker.exitedAfterDisconnect) {
                console.log(`🔄 正在重启工作进程...`);
                createWorker();
            }
        });
        
        // 监听工作进程消息
        worker.on('message', (message) => {
            if (message.type === 'worker-ready') {
                console.log(`✅ 工作进程 (PID: ${worker.process.pid}) 已准备就绪`);
            } else if (message.type === 'log') {
                console.log(`📋 [Worker ${worker.process.pid}]: ${message.data}`);
            }
        });
    }
    
    // 监听 SIGINT 信号，优雅关闭
    process.on('SIGINT', async () => {
        console.log(`\n📢 收到关闭信号，正在关闭所有工作进程...`);
        
        // 断开所有工作进程连接
        cluster.disconnect(() => {
            console.log(`✅ 所有工作进程已关闭`);
            console.log(`👋 主进程 (PID: ${process.pid}) 已退出`);
            process.exit(0);
        });
    });
    
    console.log(`🎉 集群已启动，共创建 ${numCPUs} 个工作进程`);
    console.log(`🌐 等待工作进程准备就绪...`);
    
} else {
    // 工作进程逻辑
    console.log(`👷 工作进程 (PID: ${process.pid}) 启动`);
    
    // 导入 Express 服务器
    try {
        // 启动 Express 服务器
        const serverModule = await import('./server.js');
        
        // 发送准备就绪消息给主进程
        process.send({ type: 'worker-ready' });
        
    } catch (error) {
        console.error('❌ 启动服务器失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
    
    // 监听主进程消息
    process.on('message', (message) => {
        if (message.type === 'shutdown') {
            console.log(`📢 收到关闭命令，正在关闭服务器...`);
            // 这里可以添加服务器关闭逻辑
            process.exit(0);
        }
    });
}
