import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { audioToText, getSupportedModels, getSupportedLanguages } from './whisper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Whisper 快速启动测试');
console.log('=' .repeat(50));

// 检查测试音频文件
function findTestAudioFile() {
    const testFiles = [
        './hhhhh.wav',
        './test-audio.wav', 
        './test-audio.mp3',
        './sample.wav'
    ];
    
    for (const file of testFiles) {
        const fullPath = path.join(__dirname, file);
        if (fs.existsSync(fullPath)) {
            console.log(`✅ 找到测试音频文件: ${file}`);
            return fullPath;
        }
    }
    
    console.log('⚠️  未找到测试音频文件');
    return null;
}

// 验证模型配置
function validateModelSetup() {
    console.log('\n🔍 验证模型配置...');
    
    // 检查缓存目录
    const cacheDir = path.join(__dirname, 'node_modules', '@xenova', 'transformers', '.cache', 'Xenova', 'whisper-tiny');
    
    if (fs.existsSync(cacheDir)) {
        console.log('✅ 模型缓存目录存在:', cacheDir);
        
        const files = fs.readdirSync(cacheDir);
        console.log(`📁 包含 ${files.length} 个模型文件`);
        files.forEach(file => {
            const filePath = path.join(cacheDir, file);
            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
            console.log(`   - ${file} (${sizeMB}MB)`);
        });
        
        return true;
    } else {
        console.log('❌ 模型缓存目录不存在:', cacheDir);
        return false;
    }
}

// 主测试函数
async function runQuickTest() {
    try {
        // 1. 验证模型配置
        if (!validateModelSetup()) {
            console.log('\n❌ 模型配置验证失败，请先运行模型下载');
            return;
        }
        
        // 2. 显示支持的模型和语言
        console.log('\n🤖 支持的模型:');
        getSupportedModels().forEach((model, index) => {
            console.log(`   ${index + 1}. ${model}`);
        });
        
        console.log('\n🌍 支持的语言:');
        getSupportedLanguages().forEach(lang => {
            console.log(`   ${lang.code}: ${lang.name}`);
        });
        
        // 3. 查找测试音频文件
        const audioFile = findTestAudioFile();
        
        if (audioFile) {
            console.log(`\n🎤 开始语音识别测试...`);
            console.log(`📁 文件: ${path.basename(audioFile)}`);
            
            const startTime = Date.now();
            
            // 测试不同模型加载
            const testModels = [
                'Xenova/whisper-tiny',
                'base', // 测试简写模型名称
                'Xenova/whisper-base' // 测试完整模型名称
            ];
            
            for (const modelName of testModels) {
                console.log(`\n🔄 测试模型: ${modelName}`);
                const startTime = Date.now();
                
                try {
                    // 执行语音识别
                    const result = await audioToText(audioFile, {
                        language: 'zh',
                        model: modelName
                    });
                    
                    const endTime = Date.now();
                    const processingTime = (endTime - startTime) / 1000;
                    
                    console.log(`✅ 模型 ${modelName} 加载成功！`);
                    console.log(`   📝 识别结果: ${result.text.substring(0, 50)}${result.text.length > 50 ? '...' : ''}`);
                    console.log(`   ⏱️  处理时间: ${processingTime.toFixed(2)}秒`);
                    console.log(`   🤖 使用模型: ${result.model}`);
                } catch (modelError) {
                    console.error(`❌ 模型 ${modelName} 加载失败:`, modelError.message);
                }
            }
            
            const endTime = Date.now();
            const processingTime = (endTime - startTime) / 1000;
            
            console.log('\n' + '=' .repeat(50));
            console.log('✅ 语音识别完成！');
            console.log('=' .repeat(50));
            console.log(`📝 识别结果: ${result.text}`);
            console.log(`🔤 语言: ${result.language}`);
            console.log(`🎯 置信度: ${(result.confidence * 100).toFixed(1)}%`);
            console.log(`⏱️  处理时间: ${processingTime.toFixed(2)}秒`);
            console.log(`🤖 模型: ${result.model}`);
            console.log(`🕒 时间戳: ${result.timestamp}`);
            
            if (result.chunks && result.chunks.length > 0) {
                console.log('\n⏰ 分段结果:');
                result.chunks.forEach((chunk, index) => {
                    const start = chunk.timestamp[0].toFixed(1);
                    const end = chunk.timestamp[1].toFixed(1);
                    console.log(`   ${index + 1}. [${start}s-${end}s]: ${chunk.text}`);
                });
            }
            
        } else {
            console.log('\n💡 请添加测试音频文件后重试');
            console.log('支持的格式: .wav, .mp3, .mp4, .m4a, .flac, .ogg, .webm');
        }
        
        console.log('\n🎯 快速测试完成！');
        console.log('🚀 启动完整服务: npm start');
        console.log('🌐 访问: http://localhost:3000');
        
    } catch (error) {
        console.error('\n❌ 测试失败:', error.message);
        console.error('📋 错误详情:', error);
        
        if (error.message.includes('模型') || error.message.includes('model')) {
            console.log('\n💡 模型相关问题解决建议:');
            console.log('1. 运行: node download_model.js');
            console.log('2. 检查网络连接');
            console.log('3. 尝试设置代理: set HTTP_PROXY=your-proxy');
        }
    }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
    runQuickTest();
}

export { runQuickTest };