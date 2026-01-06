#!/usr/bin/env node

/**
 * 多线程测试脚本 - 用于测试Whisper API的并发性能
 * 支持配置线程数、测试次数、音频文件等
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

// 配置参数
const CONFIG = {
    API_URL: 'http://localhost:3000/api/transcribe',
    AUDIO_FILE: '../hhhh.wav', // 测试音频文件路径
    MODEL: 'Xenova/whisper-tiny',
    LANGUAGE: 'zh',
    THREAD_COUNT: 5, // 并发线程数
    TEST_COUNT: 20, // 总测试次数
};

// 检查测试音频文件是否存在
if (!fs.existsSync(CONFIG.AUDIO_FILE)) {
    console.error('❌ 测试音频文件不存在:', CONFIG.AUDIO_FILE);
    console.log('📌 请确保测试音频文件存在，或修改 CONFIG.AUDIO_FILE 变量');
    process.exit(1);
}

// 测试结果统计
let totalRequests = 0;
let successfulRequests = 0;
let failedRequests = 0;
let totalTime = 0;
const responseTimes = [];

// 单个请求测试函数
async function testRequest(threadId, requestId) {
    const startTime = Date.now();
    
    try {
        // 创建FormData
        const formData = new FormData();
        formData.append('audio', fs.createReadStream(CONFIG.AUDIO_FILE));
        formData.append('model', CONFIG.MODEL);
        formData.append('language', CONFIG.LANGUAGE);
        
        // 发送POST请求
        const response = await axios.post(CONFIG.API_URL, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // 更新统计数据
        totalRequests++;
        successfulRequests++;
        totalTime += duration;
        responseTimes.push(duration);
        
        console.log(`✅ 线程${threadId} - 请求${requestId}：成功，耗时${duration}ms`);
        return { success: true, duration };
        
    } catch (error) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // 更新统计数据
        totalRequests++;
        failedRequests++;
        totalTime += duration;
        responseTimes.push(duration);
        
        console.error(`❌ 线程${threadId} - 请求${requestId}：失败，错误${error.message}`);
        return { success: false, duration, error: error.message };
    }
}

// 线程测试函数
async function runThread(threadId, requestsPerThread) {
    console.log(`🚀 线程${threadId}：启动，执行${requestsPerThread}次请求`);
    
    for (let i = 0; i < requestsPerThread; i++) {
        await testRequest(threadId, i + 1);
    }
    
    console.log(`🏁 线程${threadId}：完成`);
}

// 主测试函数
async function runMultiThreadTest() {
    console.log('🚀 Whisper API 多线程测试开始');
    console.log('📊 测试配置:');
    console.log(`   - API地址: ${CONFIG.API_URL}`);
    console.log(`   - 音频文件: ${CONFIG.AUDIO_FILE}`);
    console.log(`   - 模型: ${CONFIG.MODEL}`);
    console.log(`   - 语言: ${CONFIG.LANGUAGE}`);
    console.log(`   - 并发线程数: ${CONFIG.THREAD_COUNT}`);
    console.log(`   - 总测试次数: ${CONFIG.TEST_COUNT}`);
    console.log('\n' + '='.repeat(60) + '\n');
    
    const startTime = Date.now();
    
    // 计算每个线程需要执行的请求数
    const requestsPerThread = Math.ceil(CONFIG.TEST_COUNT / CONFIG.THREAD_COUNT);
    
    // 创建线程数组
    const threads = [];
    for (let i = 0; i < CONFIG.THREAD_COUNT; i++) {
        threads.push(runThread(i + 1, requestsPerThread));
    }
    
    // 等待所有线程完成
    await Promise.all(threads);
    
    const endTime = Date.now();
    const totalTestTime = endTime - startTime;
    
    // 计算统计结果
    const avgResponseTime = successfulRequests > 0 ? totalTime / successfulRequests : 0;
    const successRate = (successfulRequests / totalRequests) * 100;
    const throughput = totalRequests / (totalTestTime / 1000); // 请求/秒
    
    // 计算响应时间分布
    let minResponseTime = Infinity;
    let maxResponseTime = 0;
    if (responseTimes.length > 0) {
        minResponseTime = Math.min(...responseTimes);
        maxResponseTime = Math.max(...responseTimes);
        responseTimes.sort((a, b) => a - b);
    }
    
    const p50 = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.5)] : 0;
    const p90 = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.9)] : 0;
    const p95 = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.95)] : 0;
    
    console.log('\n' + '='.repeat(60) + '\n');
    console.log('🎉 多线程测试完成');
    console.log('📊 测试结果统计:');
    console.log('\n📈 基本统计:');
    console.log(`   - 总请求数: ${totalRequests}`);
    console.log(`   - 成功请求: ${successfulRequests}`);
    console.log(`   - 失败请求: ${failedRequests}`);
    console.log(`   - 成功率: ${successRate.toFixed(2)}%`);
    console.log(`   - 总测试时间: ${totalTestTime}ms`);
    console.log(`   - 吞吐量: ${throughput.toFixed(2)} 请求/秒`);
    
    console.log('\n⏱️  响应时间统计:');
    console.log(`   - 平均响应时间: ${avgResponseTime.toFixed(2)}ms`);
    console.log(`   - 最小响应时间: ${minResponseTime}ms`);
    console.log(`   - 最大响应时间: ${maxResponseTime}ms`);
    console.log(`   - P50响应时间: ${p50}ms`);
    console.log(`   - P90响应时间: ${p90}ms`);
    console.log(`   - P95响应时间: ${p95}ms`);
    
    console.log('\n📋 详细响应时间列表:');
    console.log(responseTimes.join(', '));
}

// 执行测试
runMultiThreadTest().catch(error => {
    console.error('❌ 测试过程中发生错误:', error.message);
    console.error(error.stack);
    process.exit(1);
});
