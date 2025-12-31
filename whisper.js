import fs from 'fs';
import path from 'path';
import { pipeline, env } from '@xenova/transformers';
import { fileURLToPath } from 'url';
import WavDecoder from 'wav-decoder';

// 解决 __dirname 问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 音频文件解码函数
async function decodeAudioFile(audioPath) {
    try {
        const ext = path.extname(audioPath).toLowerCase();
        const buffer = fs.readFileSync(audioPath);
        
        if (ext === '.wav') {
            try {
                // 使用WavDecoder处理WAV文件
                const decoded = await WavDecoder.decode(buffer);
                
                // 将音频数据转换为Float32Array（单声道）
                let audioData = decoded.channelData.length > 1 
                    ? mergeChannels(decoded.channelData)
                    : decoded.channelData[0];
                
                console.log(`📊 WAV文件信息: 采样率=${decoded.sampleRate}Hz, 时长=${(decoded.length/decoded.sampleRate).toFixed(2)}s`);
                
                // 重采样到16kHz（Whisper标准）
                if (decoded.sampleRate !== 16000) {
                    console.log(`🔄 重采样: ${decoded.sampleRate}Hz → 16000Hz`);
                    audioData = resampleAudio(audioData, decoded.sampleRate, 16000);
                }
                
                return audioData;
                
            } catch (decodeError) {
                console.log(`⚠️  WavDecoder失败，尝试手动解析: ${decodeError.message}`);
                return manualWavParse(buffer);
            }
        } else {
            // 对于其他格式，暂时返回Buffer
            console.log(`⚠️  格式 ${ext} 可能需要额外处理，目前返回Buffer`);
            return buffer;
        }
    } catch (error) {
        console.error('❌ 音频解码失败:', error.message);
        throw new Error(`音频解码失败: ${error.message}`);
    }
}

// 合并多声道为单声道
function mergeChannels(channels) {
    if (channels.length === 1) {
        return channels[0];
    }
    
    const length = channels[0].length;
    const merged = new Float32Array(length);
    
    for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels.length; ch++) {
            sum += channels[ch][i];
        }
        merged[i] = sum / channels.length;
    }
    
    return merged;
}

// 重采样音频数据
function resampleAudio(audioData, originalRate, targetRate) {
    if (originalRate === targetRate) {
        return audioData;
    }
    
    const ratio = originalRate / targetRate;
    const newLength = Math.floor(audioData.length / ratio);
    const resampled = new Float32Array(newLength);
    
    for (let i = 0; i < newLength; i++) {
        const index = i * ratio;
        const indexFloor = Math.floor(index);
        const indexCeil = Math.min(indexFloor + 1, audioData.length - 1);
        const frac = index - indexFloor;
        
        // 线性插值
        resampled[i] = audioData[indexFloor] * (1 - frac) + audioData[indexCeil] * frac;
    }
    
    return resampled;
}

// 手动WAV文件解析（备选方案）
function manualWavParse(buffer) {
    try {
        // WAV文件头部结构检查
        if (buffer.length < 44) {
            throw new Error('文件太小，不是有效的WAV文件');
        }
        
        // 检查RIFF标识
        if (buffer.readUInt32LE(0) !== 0x46464952) { // 'RIFF'
            throw new Error('不是有效的RIFF文件');
        }
        
        // 检查WAVE标识
        if (buffer.readUInt32LE(8) !== 0x45564157) { // 'WAVE'
            throw new Error('不是WAV格式文件');
        }
        
        // 读取音频格式信息
        const audioFormat = buffer.readUInt16LE(20);
        const numChannels = buffer.readUInt16LE(22);
        const sampleRate = buffer.readUInt32LE(24);
        const bitsPerSample = buffer.readUInt16LE(34);
        
        console.log(`📊 手动解析WAV: 格式=${audioFormat}, 声道=${numChannels}, 采样率=${sampleRate}Hz, 位深=${bitsPerSample}`);
        
        // 查找数据块
        let dataOffset = 36;
        while (dataOffset < buffer.length - 8) {
            const chunkId = buffer.readUInt32LE(dataOffset);
            const chunkSize = buffer.readUInt32LE(dataOffset + 4);
            
            if (chunkId === 0x61746164) { // 'data'
                break;
            }
            
            dataOffset += 8 + chunkSize;
        }
        
        if (dataOffset >= buffer.length - 8) {
            throw new Error('未找到音频数据块');
        }
        
        const audioData = buffer.subarray(dataOffset + 8, dataOffset + 8 + chunkSize);
        
        // 转换为Float32Array
        const floatData = new Float32Array(audioData.length / (bitsPerSample / 8));
        
        if (bitsPerSample === 16) {
            for (let i = 0; i < floatData.length; i++) {
                const sample = audioData.readInt16LE(i * 2);
                floatData[i] = sample / 32768.0;
            }
        } else if (bitsPerSample === 32) {
            for (let i = 0; i < floatData.length; i++) {
                const sample = audioData.readInt32LE(i * 4);
                floatData[i] = sample / 2147483648.0;
            }
        } else {
            throw new Error(`不支持的位深: ${bitsPerSample}`);
        }
        
        console.log(`📊 解析成功: 采样率=${sampleRate}Hz, 时长=${(floatData.length/sampleRate).toFixed(2)}s`);
        
        // 重采样到16kHz
        if (sampleRate !== 16000) {
            console.log(`🔄 重采样: ${sampleRate}Hz → 16000Hz`);
            return resampleAudio(floatData, sampleRate, 16000);
        }
        
        return floatData;
        
    } catch (error) {
        console.error('❌ 手动WAV解析失败:', error.message);
        throw error;
    }
}

// 启用本地模型，支持从本地文件系统加载
env.allowLocalModels = true;

// 设置模型目录优先级：先查找项目models目录，再查找默认缓存
const defaultCacheDir = path.join(__dirname, 'node_modules', '@xenova', 'transformers', '.cache', 'Xenova', 'whisper-tiny');
const projectModelsDir = path.join(__dirname, 'models');

// 选择可用的模型目录
let modelDir = null;
if (fs.existsSync(defaultCacheDir)) {
    modelDir = defaultCacheDir;
    console.log('📂 使用默认缓存模型目录:', modelDir);
} else if (fs.existsSync(projectModelsDir)) {
    modelDir = path.join(projectModelsDir, 'whisper-tiny');
    console.log('📂 使用项目模型目录:', modelDir);
} else {
    // 如果都不存在，创建项目models目录
    fs.mkdirSync(projectModelsDir, { recursive: true });
    env.allowLocalModels = false; // 退回到远程下载
    console.log('⚠️  未找到本地模型，将从远程下载');
}

if (modelDir) {
    env.localModelPath = modelDir;
    console.log('🎉 模型配置完成，将从本地加载:', modelDir);
}

// 设置镜像源和代理配置（作为备选）
if (process.env.HF_MIRROR_URL) {
    env.remoteHost = process.env.HF_MIRROR_URL;
    console.log('🌐 使用自定义镜像源:', env.remoteHost);
} else {
    env.remoteHost = 'https://cdn.jsdelivr.net';
    env.remotePath = '@huggingface/hub/transformers.js';
    console.log('🌐 备用远程源: jsdelivr CDN');
}

// 设置网络超时
if (process.env.HF_TIMEOUT) {
    env.fetchTimeout = parseInt(process.env.HF_TIMEOUT);
    console.log('⏰ 网络超时设置:', env.fetchTimeout + 'ms');
}

// 模型工厂类，确保只有一个模型实例
class WhisperPipelineFactory {
    static task = 'automatic-speech-recognition';
    static model = null;
    static quantized = null;
    static instance = null;

    constructor(tokenizer, model, quantized) {
        this.tokenizer = tokenizer;
        this.model = model;
        this.quantized = quantized;
    }

    static async getInstance(progressCallback = null) {
        if (this.instance === null) {
            console.log('🧠 正在加载 Whisper 模型...');
            this.instance = await pipeline(this.task, this.model, {
                quantized: this.quantized,
                progress_callback: progressCallback,
                
                // 对于中等模型，需要加载 no_attentions 版本以避免内存不足
                revision: this.model.includes('/whisper-medium') ? 'no_attentions' : 'main'
            });
            console.log('✅ Whisper 模型加载完成');
        }
        return this.instance;
    }

    static async dispose() {
        if (this.instance !== null) {
            await this.instance.dispose();
            this.instance = null;
        }
    }
}

// 音频转文本核心功能
export async function audioToText(audioPath, options = {}) {
    try {
        console.log('🚀 开始处理音频文件:', audioPath);
        
        // 检查文件是否存在
        if (!fs.existsSync(audioPath)) {
            throw new Error(`音频文件不存在: ${audioPath}`);
        }
        
        // 获取文件信息
        const stats = fs.statSync(audioPath);
        console.log(`📁 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // 检查音频格式
        const ext = path.extname(audioPath).toLowerCase();
        const supportedFormats = ['.wav', '.mp3', '.mp4', '.m4a', '.flac', '.ogg', '.webm'];
        
        if (!supportedFormats.includes(ext)) {
            console.log(`⚠️  警告: 文件格式 ${ext} 可能不被支持，建议使用: ${supportedFormats.join(', ')}`);
        }
        
        // 设置默认选项
        const defaultOptions = {
            model: 'Xenova/whisper-tiny',
            quantized: false,
            multilingual: true,
            subtask: 'transcribe',
            language: 'zh', // 中文
            progress_callback: (data) => {
                if (data.status === 'initiate') {
                    console.log(`📥 正在下载: ${data.file}`);
                } else if (data.status === 'progress') {
                    console.log(`⏳ 下载进度: ${data.file} - ${data.progress.toFixed(1)}%`);
                } else if (data.status === 'done') {
                    console.log(`✅ 下载完成: ${data.file}`);
                }
            }
        };
        
        const config = { ...defaultOptions, ...options };
        
        // 检查是否是 Distil Whisper 模型
        const isDistilWhisper = config.model.startsWith('distil-whisper/');
        
        let modelName = config.model;
        if (!isDistilWhisper && !config.multilingual) {
            modelName += '.en';
        }
        
        // 管理模型实例
        const factory = WhisperPipelineFactory;
        if (factory.model !== modelName || factory.quantized !== config.quantized) {
            // 如果模型不同，释放之前的实例
            if (factory.instance !== null) {
                await factory.dispose();
            }
            factory.model = modelName;
            factory.quantized = config.quantized;
        }
        
        console.log('🎯 正在加载语音识别模型:', modelName);
        console.log('📊 配置:', {
            quantized: config.quantized,
            multilingual: config.multilingual,
            language: config.language,
            subtask: config.subtask
        });
        
        // 加载转录模型
        const transcriber = await factory.getInstance(config.progress_callback);
        
        // 读取和解码音频文件
        console.log('🔧 正在读取音频文件...');
        const audioData = await decodeAudioFile(audioPath);
        
        // 计算时间精度
        const timePrecision = transcriber.processor.feature_extractor.config.chunk_length / 
                             transcriber.model.config.max_source_positions;
        
        console.log('🎤 正在进行语音识别...');
        console.log(`📏 分块长度: ${isDistilWhisper ? 20 : 30}s`);
        console.log(`📐 步长: ${isDistilWhisper ? 3 : 5}s`);
        
        // 执行转录 - 传递Float32Array数据
        const output = await transcriber(audioData, {
            // Greedy 搜索
            top_k: 0,
            do_sample: false,
            
            // 滑动窗口
            chunk_length_s: isDistilWhisper ? 20 : 30,
            stride_length_s: isDistilWhisper ? 3 : 5,
            
            // 语言和任务
            language: config.language,
            task: config.subtask,
            
            // 返回时间戳
            return_timestamps: true,
            force_full_sequences: false,
            
            // 进度回调
            callback_function: (item) => {
                const lastChunk = item[0];
                if (lastChunk && lastChunk.output_token_ids) {
                    console.log(`🎵 处理进度: ${(lastChunk.output_token_ids.length / 5000 * 100).toFixed(1)}%`);
                }
            }
        });
        
        console.log('✅ 语音识别完成！');
        
        // 格式化结果
        const result = {
            text: traditionalToSimplified(output.text),
            chunks: output.chunks || [],
            language: output.language || config.language,
            duration: output.duration || 0,
            task: config.subtask,
            model: modelName,
            timestamp: new Date().toISOString(),
            confidence: calculateConfidence(output.chunks || [])
        };
        
        // 如果检测到繁体字，转换为简体并记录
        if (output.text !== result.text) {
            console.log('🔄 检测到繁体字，已转换为简体中文');
        }
        
        return result;
        
    } catch (error) {
        console.error('❌ 音频处理出错:', error.message);
        
        // 尝试释放模型实例
        try {
            await WhisperPipelineFactory.dispose();
        } catch (disposeError) {
            console.error('⚠️  释放模型实例时出错:', disposeError.message);
        }
        
        throw error;
    }
}

// 批量处理音频文件
export async function batchAudioToText(audioPaths, options = {}) {
    const results = [];
    
    console.log(`📂 开始批量处理 ${audioPaths.length} 个音频文件...\n`);
    
    for (let i = 0; i < audioPaths.length; i++) {
        const audioPath = audioPaths[i];
        console.log(`--- 处理文件 ${i + 1}/${audioPaths.length}: ${audioPath} ---`);
        
        try {
            const result = await audioToText(audioPath, options);
            results.push({
                file: audioPath,
                success: true,
                text: result.text,
                duration: result.duration,
                confidence: result.confidence,
                language: result.language,
                timestamp: result.timestamp
            });
            console.log(`✅ 文件 ${i + 1} 处理成功\n`);
        } catch (error) {
            results.push({
                file: audioPath,
                success: false,
                error: error.message
            });
            console.log(`❌ 文件 ${i + 1} 处理失败: ${error.message}\n`);
        }
    }
    
    return results;
}

// 加载简繁体转换配置
import { promises as fs } from 'fs';
import path from 'path';

let TRADITIONAL_TO_SIMPLIFIED_MAPPING = {};
let mappingLoaded = false;

// 同步加载简繁体映射表
function loadTraditionalMappingSync() {
    try {
        const configPath = path.join(process.cwd(), 'config', 'traditional-to-simplified.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        TRADITIONAL_TO_SIMPLIFIED_MAPPING = config.mappings || {};
        mappingLoaded = true;
        console.log('✅ 简繁体转换配置加载成功');
    } catch (error) {
        console.warn('⚠️  简繁体转换配置文件加载失败，使用默认映射:', error.message);
        // 默认映射表
        TRADITIONAL_TO_SIMPLIFIED_MAPPING = {
            '準備': '准备',
            '說': '说',
            '認': '认',
            '為': '为',
            '與': '与',
            '這': '这',
            '時': '时',
            '間': '间',
            '會': '会',
            '國': '国'
        };
        mappingLoaded = true;
    }
}

// 模块加载时立即初始化映射表
loadTraditionalMappingSync();

// 繁体转简体
function traditionalToSimplified(text) {
    if (!text) return text;
    
    // 确保映射表已加载
    if (!mappingLoaded) {
        loadTraditionalMappingSync();
    }
    
    let simplified = text;
    for (const [traditional, simplifiedChar] of Object.entries(TRADITIONAL_TO_SIMPLIFIED_MAPPING)) {
        simplified = simplified.replace(new RegExp(traditional, 'g'), simplifiedChar);
    }
    
    return simplified;
}

// 计算置信度
function calculateConfidence(chunks) {
    if (!chunks || chunks.length === 0) return 0.8;
    
    const totalConfidence = chunks.reduce((sum, chunk) => {
        return sum + (chunk.avg_logprob || -0.5);
    }, 0);
    
    return Math.max(0.1, Math.min(1.0, (totalConfidence / chunks.length + 1) / 2));
}

// 获取支持的模型列表
export function getSupportedModels() {
    return [
        'Xenova/whisper-tiny',        // 最小模型，速度最快
        'Xenova/whisper-base',        // 基础模型
        'Xenova/whisper-small',       // 小模型
        'Xenova/whisper-medium',      // 中等模型
        'Xenova/whisper-large',       // 大模型，准确度最高
        'distil-whisper/distil-whisper-tiny',
        'distil-whisper/distil-whisper-base',
        'distil-whisper/distil-whisper-small',
        'distil-whisper/distil-whisper-medium'
    ];
}

// 获取支持的语言列表
export function getSupportedLanguages() {
    return [
        { code: 'auto', name: '自动检测' },
        { code: 'zh', name: '中文' },
        { code: 'en', name: 'English' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' },
        { code: 'fr', name: 'Français' },
        { code: 'de', name: 'Deutsch' },
        { code: 'es', name: 'Español' },
        { code: 'it', name: 'Italiano' },
        { code: 'pt', name: 'Português' },
        { code: 'ru', name: 'Русский' },
        { code: 'ar', name: 'العربية' }
    ];
}

// 清理资源
export async function cleanup() {
    await WhisperPipelineFactory.dispose();
    console.log('🧹 模型资源已清理');
}

// 示例用法
async function main() {
    try {
        console.log('🎤 Whisper 音频转文本演示');
        console.log('=' .repeat(50));
        
        // 检查是否有测试音频文件
        const testFiles = [
            './test-audio.wav',
            './test-audio.mp3',
            './sample.wav'
        ];
        
        let foundFile = null;
        for (const file of testFiles) {
            if (fs.existsSync(file)) {
                foundFile = file;
                break;
            }
        }
        
        if (!foundFile) {
            console.log('⚠️  未找到测试音频文件');
            return;
        }
        
        // 转录音频文件
        const result = await audioToText(foundFile, {
            language: 'zh',
            model: 'Xenova/whisper-tiny'
        });
        
        console.log('\n📝 转录结果:');
        console.log('=' .repeat(30));
        console.log('📄 文本:', result.text);
        console.log('🌐 语言:', result.language);
        console.log('⏱️  时长:', `${result.duration}秒`);
        console.log('🎯 置信度:', `${(result.confidence * 100).toFixed(1)}%`);
        console.log('📊 模型:', result.model);
        console.log('🕐 时间戳:', result.timestamp);
        
        if (result.chunks && result.chunks.length > 0) {
            console.log('\n⏰ 时间轴分段:');
            result.chunks.forEach((chunk, index) => {
                const start = chunk.timestamp[0].toFixed(1);
                const end = chunk.timestamp[1].toFixed(1);
                console.log(`${index + 1}. [${start}s - ${end}s]: ${chunk.text}`);
            });
        }
        
    } catch (error) {
        console.error('❌ 演示失败:', error.message);
    } finally {
        await cleanup();
    }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}