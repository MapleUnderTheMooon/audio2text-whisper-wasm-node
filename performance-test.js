#!/usr/bin/env node

/**
 * Whisper WASM 性能测试脚本
 * 用于测试优化前后的性能差异
 */

import { audioToText } from './whisper.js';
import fs from 'fs';
import path from 'path';

// 测试音频文件路径
const testAudioPath = './hhhh.wav';

// 检查测试音频文件是否存在
if (!fs.existsSync(testAudioPath)) {
    console.error('❌ 测试音频文件不存在:', testAudioPath);
    console.log('📌 请确保测试音频文件存在，或修改 testAudioPath 变量');
    process.exit(1);
}

// 测试配置选项
const testConfigs = [
    {
        name: '默认配置',
        options: {}
    },
    {
        name: '速度优先模式',
        options: {
            performance_mode: 'speed'
        }
    },
    {
        name: '准确率优先模式',
        options: {
            performance_mode: 'accuracy'
        }
    }
];

// 测试执行次数
const testRuns = 3;

console.log('🚀 Whisper WASM 性能测试开始');
console.log('📊 测试配置:');
console.log(`   - 测试音频: ${testAudioPath}`);
console.log(`   - 执行次数: ${testRuns}次`);
console.log(`   - 测试模式: ${testConfigs.map(config => config.name).join(', ')}`);
console.log('\n' + '='.repeat(60) + '\n');

// 运行性能测试
async function runPerformanceTest() {
    for (const config of testConfigs) {
        console.log(`🎯 测试: ${config.name}`);
        
        const results = [];
        
        for (let i = 0; i < testRuns; i++) {
            console.log(`   🔄 执行第 ${i + 1}/${testRuns} 次...`);
            
            const startTime = Date.now();
            
            try {
                const result = await audioToText(testAudioPath, config.options);
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                results.push(duration);
                
                console.log(`   ✅ 完成，耗时: ${duration}ms`);
                console.log(`   📝 识别结果: ${result.text.substring(0, 50)}...`);
                
            } catch (error) {
                console.error(`   ❌ 测试失败: ${error.message}`);
                results.push(Infinity);
            }
        }
        
        // 计算统计数据
        const validResults = results.filter(r => r !== Infinity);
        if (validResults.length === 0) {
            console.log(`   ❌ 所有测试都失败了`);
        } else {
            const avgDuration = validResults.reduce((sum, duration) => sum + duration, 0) / validResults.length;
            const minDuration = Math.min(...validResults);
            const maxDuration = Math.max(...validResults);
            
            console.log(`   \n📊 统计结果:`);
            console.log(`   - 平均耗时: ${avgDuration.toFixed(2)}ms`);
            console.log(`   - 最快耗时: ${minDuration}ms`);
            console.log(`   - 最慢耗时: ${maxDuration}ms`);
            console.log(`   - 成功率: ${(validResults.length / testRuns * 100).toFixed(1)}%`);
        }
        
        console.log('\n' + '='.repeat(60) + '\n');
    }
    
    console.log('🎉 性能测试完成');
}

// 执行测试
runPerformanceTest().catch(error => {
    console.error('❌ 测试过程中发生错误:', error.message);
    console.error(error.stack);
    process.exit(1);
});
