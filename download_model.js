import fs from 'fs';
import path from 'path';
import { pipeline, env } from '@xenova/transformers';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 支持的模型列表及其精度说明
const SUPPORTED_MODELS = [
    { id: 'Xenova/whisper-tiny', name: 'whisper-tiny', description: '最小最快，精度最低', size: '~75MB', accuracy: '低' },
    { id: 'Xenova/whisper-base', name: 'whisper-base', description: '基础模型，平衡速度和精度', size: '~142MB', accuracy: '中低' },
    { id: 'Xenova/whisper-small', name: 'whisper-small', description: '小模型，较好的精度和速度', size: '~466MB', accuracy: '中' },
    { id: 'Xenova/whisper-medium', name: 'whisper-medium', description: '中等模型，高精度', size: '~1.5GB', accuracy: '高' },
    { id: 'Xenova/whisper-large', name: 'whisper-large', description: '大模型，最高精度，速度较慢', size: '~2.9GB', accuracy: '最高' },
    { id: 'distil-whisper/distil-whisper-tiny', name: 'distil-whisper-tiny', description: '蒸馏小模型，更快', size: '~61MB', accuracy: '低' },
    { id: 'distil-whisper/distil-whisper-base', name: 'distil-whisper-base', description: '蒸馏基础模型', size: '~125MB', accuracy: '中低' },
    { id: 'distil-whisper/distil-whisper-small', name: 'distil-whisper-small', description: '蒸馏小模型', size: '~401MB', accuracy: '中' },
    { id: 'distil-whisper/distil-whisper-medium', name: 'distil-whisper-medium', description: '蒸馏中等模型', size: '~1.2GB', accuracy: '高' }
];

// 解析命令行参数
function parseArgs() {
    const args = {
        model: 'Xenova/whisper-tiny', // 默认模型
        quantized: false, // 默认不量化
        help: false
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        const nextArg = process.argv[i + 1];
        
        if (arg === '--model' || arg === '-m') {
            if (nextArg && !nextArg.startsWith('-')) {
                args.model = nextArg;
                i++;
            } else {
                console.error('❌ 缺少模型名称参数');
                showHelp();
                process.exit(1);
            }
        } else if (arg === '--quantized' || arg === '-q') {
            if (nextArg && !nextArg.startsWith('-')) {
                args.quantized = nextArg.toLowerCase() === 'true' || nextArg === '1';
                i++;
            } else {
                // 没有值时默认true
                args.quantized = true;
            }
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            console.error(`❌ 未知参数: ${arg}`);
            showHelp();
            process.exit(1);
        }
    }
    
    return args;
}

// 显示帮助信息
function showHelp() {
    console.log('🚀 模型下载工具');
    console.log('=' .repeat(50));
    console.log('用法: node download_model.js [选项]');
    console.log('\n选项:');
    console.log('  --model, -m <model>     指定要下载的模型 (默认: Xenova/whisper-tiny)');
    console.log('  --quantized, -q [true/false]  是否下载量化模型 (默认: false)');
    console.log('  --help, -h              显示帮助信息');
    console.log('\n支持的模型:');
    SUPPORTED_MODELS.forEach((model, index) => {
        console.log(`  ${index + 1}. ${model.id}`);
        console.log(`     ${model.description}`);
        console.log(`     大小: ${model.size}, 精度: ${model.accuracy}`);
    });
    console.log('\n示例:');
    console.log('  node download_model.js --model Xenova/whisper-small');
    console.log('  node download_model.js -m Xenova/whisper-medium --quantized true');
}

// 解析命令行参数
const args = parseArgs();

// 如果请求帮助，显示帮助信息
if (args.help) {
    showHelp();
    process.exit(0);
}

// 验证模型名称
const isValidModel = SUPPORTED_MODELS.some(model => model.id === args.model);
if (!isValidModel) {
    console.error(`❌ 无效的模型名称: ${args.model}`);
    console.error('✅ 支持的模型:');
    SUPPORTED_MODELS.forEach(model => console.log(`  - ${model.id}`));
    process.exit(1);
}

// 设置模型缓存目录到项目本地
const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

console.log('📁 模型将下载到:', modelsDir);
console.log('🌐 检查网络连接...');

// 配置下载环境
env.allowLocalModels = true;
env.localModelPath = modelsDir;

// 清理默认缓存，强制使用本地目录
env.useBrowserCache = false;

console.log('📂 强制使用本地模型目录:', modelsDir);
console.log('🎯 要下载的模型:', args.model);
console.log('🔢 是否量化:', args.quantized ? '是' : '否');

// 使用多个备用源
const downloadSources = [
    { host: 'https://cdn.jsdelivr.net', path: '@huggingface/hub/transformers.js' },
    { host: 'https://hf-mirror.com', path: '' },
    { host: 'https://huggingface.co', path: '' }
];

// 当前使用的源
let currentSourceIndex = 0;
let currentSource = downloadSources[currentSourceIndex];

function switchToNextSource() {
    currentSourceIndex++;
    if (currentSourceIndex < downloadSources.length) {
        currentSource = downloadSources[currentSourceIndex];
        env.remoteHost = currentSource.host;
        env.remotePath = currentSource.path;
        console.log(`🔄 切换到备用源: ${currentSource.host}`);
        return true;
    }
    return false;
}

async function downloadModelWithRetry(modelName, quantized = false, maxRetries = 3) {
    let attempt = 1;
    let transcriber = null;

    while (attempt <= maxRetries && !transcriber) {
        try {
            // 获取模型信息
            const modelInfo = SUPPORTED_MODELS.find(m => m.id === modelName) || { name: modelName };
            
            console.log(`
🚀 尝试 ${attempt}/${maxRetries} - 下载 ${modelInfo.name} 模型`);
            console.log(`📡 使用源: ${currentSource.host}`);
            
            // 设置当前源
            env.remoteHost = currentSource.host;
            env.remotePath = currentSource.path || '@huggingface/hub/transformers.js';
            
            console.log('🔧 下载配置:');
            console.log(`- 模型仓库: ${modelName}`);
            console.log(`- 量化: ${quantized}`);
            console.log(`- 远程主机: ${env.remoteHost}`);
            console.log(`- 本地缓存: ${modelsDir}`);

            const startTime = Date.now();
            
            // 下载模型
            transcriber = await pipeline(
                'automatic-speech-recognition',
                modelName,
                {
                    quantized: quantized,
                    progress_callback: (data) => {
                        if (data.status === 'initiate') {
                            console.log(`📥 正在下载: ${data.file}`);
                        } else if (data.status === 'progress') {
                            const percentage = (data.progress * 100).toFixed(1);
                            const loaded = data.loaded ? (data.loaded / 1024 / 1024).toFixed(1) : 'N/A';
                            const total = data.total ? (data.total / 1024 / 1024).toFixed(1) : 'N/A';
                            const speed = data.loaded && data.elapsed ? `${(data.loaded / 1024 / data.elapsed).toFixed(1)}KB/s` : 'N/A';
                            
                            console.log(`⏳ 下载进度: ${data.file}`);
                            console.log(`   ${percentage}% (${loaded}/${total}MB) - 速度: ${speed}`);
                        } else if (data.status === 'done') {
                            console.log(`✅ 下载完成: ${data.file}`);
                        }
                    }
                }
            );

            const downloadTime = Date.now() - startTime;
            console.log(`\n🎉 模型下载成功！耗时: ${(downloadTime / 1000 / 60).toFixed(1)} 分钟`);
            console.log(`📁 模型已保存到: ${modelsDir}`);
            
            // 测试模型
            console.log('\n🧪 测试模型功能...');
            try {
                const testResult = await transcriber({
                    audio: {
                        array: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]), // 简单测试音频
                        sampling_rate: 16000
                    }
                });
                
                console.log('✅ 模型测试通过！');
                console.log('📝 测试结果:', testResult.text || '无输出');
            } catch (testError) {
                console.log('⚠️  模型功能测试失败，但模型文件已下载:', testError.message);
            }
            
            // 列出下载的文件
            console.log('\n📋 下载的文件列表:');
            if (fs.existsSync(modelsDir)) {
                const files = fs.readdirSync(modelsDir, { recursive: true });
                files.forEach(file => {
                    const filePath = path.join(modelsDir, file);
                    const stats = fs.statSync(filePath);
                    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                    console.log(`   ${file} (${sizeMB}MB)`);
                });
            }
            
            return transcriber;
            
        } catch (error) {
            console.error(`❌ 尝试 ${attempt} 失败:`, error.message);
            
            if (attempt < maxRetries) {
                // 尝试切换到备用源
                if (switchToNextSource()) {
                    console.log('🔄 切换到下一个下载源...');
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒
                } else {
                    console.log('⚠️  所有下载源都已尝试');
                    break;
                }
            }
            
            attempt++;
        }
    }
    
    if (!transcriber) {
        console.error('❌ 所有下载尝试都失败了');
        console.log('💡 建议解决方案:');
        console.log('1. 检查网络连接');
        console.log('2. 设置代理: set HTTP_PROXY=http://proxy:port');
        console.log('3. 使用国内镜像: set HF_MIRROR_URL=https://hf-mirror.com');
        process.exit(1);
    }
    
    return transcriber;
}

// 函数：将已下载的模型移动到项目目录
function moveExistingModel(modelName) {
    // 提取模型名称（例如从 Xenova/whisper-tiny 提取 whisper-tiny）
    const modelShortName = modelName.split('/')[1] || modelName;
    const defaultCache = path.join(__dirname, 'node_modules', '@xenova', 'transformers', '.cache', modelName);
    
    if (fs.existsSync(defaultCache)) {
        console.log(`📦 发现已下载的模型 ${modelName}，正在移动到项目目录...`);
        
        try {
            // 复制文件到项目目录
            if (!fs.existsSync(modelsDir)) {
                fs.mkdirSync(modelsDir, { recursive: true });
            }
            
            const modelDir = path.join(modelsDir, modelShortName);
            if (!fs.existsSync(modelDir)) {
                fs.mkdirSync(modelDir, { recursive: true });
            }
            
            // 复制所有文件
            const files = fs.readdirSync(defaultCache);
            files.forEach(file => {
                const srcFile = path.join(defaultCache, file);
                const destFile = path.join(modelDir, file);
                fs.copyFileSync(srcFile, destFile);
                console.log(`✅ 复制: ${file}`);
            });
            
            console.log(`🎉 模型 ${modelName} 已成功移动到项目目录!`);
            return true;
        } catch (error) {
            console.error('❌ 移动模型失败:', error.message);
            return false;
        }
    } else {
        console.log(`ℹ️  未发现已下载的模型 ${modelName}`);
        return false;
    }
}

// 主函数
console.log('🚀 开始模型管理流程...');

// 首先尝试移动已下载的模型
const moved = moveExistingModel(args.model);

// 提取模型名称（例如从 Xenova/whisper-tiny 提取 whisper-tiny）
const modelShortName = args.model.split('/')[1] || args.model;

if (moved) {
    console.log('✅ 模型已移动，无需重新下载');
    console.log('📁 模型位置:', path.join(modelsDir, modelShortName));
    console.log('🎯 现在可以运行: node test.js hhhhh.wav');
} else {
    // 如果没有已下载的模型，则下载新模型
    downloadModelWithRetry(args.model, args.quantized).then(model => {
        console.log('\n🎉 模型下载和测试完成！');
        console.log('\n🚀 下一步测试:');
        console.log('1. 测试你的音频文件: node test.js hhhhh.wav');
        console.log('2. 启动服务器: npm start');
        console.log('3. 或直接使用: node examples.js');
        console.log('\n📁 离线使用:');
        console.log('模型已缓存到本地，无需网络连接即可使用');
        
        // 显示模型精度说明
        const modelInfo = SUPPORTED_MODELS.find(m => m.id === args.model);
        if (modelInfo) {
            console.log('\n📊 模型精度说明:');
            console.log(`- 模型: ${modelInfo.name}`);
            console.log(`- 描述: ${modelInfo.description}`);
            console.log(`- 大小: ${modelInfo.size}`);
            console.log(`- 精度: ${modelInfo.accuracy}`);
        }
        
        // 保持模型实例以测试
        if (model) {
            console.log('\n🧪 模型实例已准备就绪，可以立即测试');
        }
        }).catch(error => {
            console.error('\n💥 下载过程遇到严重错误:', error.message);
            process.exit(1);
        });
}