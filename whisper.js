import fs from 'fs';
import path from 'path';
import { pipeline, env } from '@xenova/transformers';
import { fileURLToPath } from 'url';
import WavDecoder from 'wav-decoder';
import { sify } from 'chinese-conv';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// 解决 __dirname 问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 使用 chinese-conv 库进行简繁体转换
// 繁体转简体
function traditionalToSimplified(text) {
    if (!text) return text;
    
    try {
        // 使用 chinese-conv 库的 sify 函数进行转换
        // sify = Simplify (traditional to simplified)
        return sify(text);
    } catch (error) {
        console.error('❌ 简繁体转换失败:', error.message);
        // 如果转换失败，返回原始文本
        return text;
    }
}

// 音频文件解码函数（从文件路径）
async function decodeAudioFile(audioPath) {
    try {
        const ext = path.extname(audioPath).toLowerCase();
        const buffer = fs.readFileSync(audioPath);
        
        return await decodeAudioBuffer(buffer, ext);
    } catch (error) {
        console.error('❌ 音频解码失败:', error.message);
        throw new Error(`音频解码失败: ${error.message}`);
    }
}

// 从内存缓冲区解码音频数据
async function decodeAudioBuffer(buffer, ext = null, mimetype = null) {
    try {
        // 如果没有提供扩展名，尝试从 mimetype 推断
        if (!ext && mimetype) {
            if (mimetype.includes('wav')) {
                ext = '.wav';
            } else if (mimetype.includes('mp3')) {
                ext = '.mp3';
            } else if (mimetype.includes('mp4') || mimetype.includes('mpeg4')) {
                ext = '.mp4';
            } else if (mimetype.includes('m4a')) {
                ext = '.m4a';
            } else if (mimetype.includes('flac')) {
                ext = '.flac';
            } else if (mimetype.includes('ogg')) {
                ext = '.ogg';
            } else if (mimetype.includes('webm')) {
                ext = '.webm';
            }
        }
        
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
        } else if (ext === '.webm' || mimetype.includes('webm')) {
            // 处理 WebM/Opus 格式
            console.log(`📊 WebM文件信息: 大小=${(buffer.length / 1024).toFixed(2)}KB, MIME类型=${mimetype}`);
            
            // 验证WebM文件完整性
            if (!validateWebM(buffer)) {
                console.warn(`⚠️  警告: 可能不是有效的WebM文件，尝试继续处理...`);
            }
            
            console.log(`🔄 开始解码 WebM/Opus 格式...`);
            
            try {
                // 使用 FFmpeg 解码 WebM 文件
                const audioData = await decodeWebMWithFFmpeg(buffer);
                console.log(`✅ WebM 解码成功，采样率=16000Hz, 时长=${(audioData.length/16000).toFixed(2)}s`);
                return audioData;
            } catch (ffmpegError) {
                console.error(`⚠️  FFmpeg 解码失败: ${ffmpegError.message}`);
                console.log(`🔄 尝试使用 opus-decoder 解码...`);
                
                try {
                    // 尝试使用 opus-decoder 作为备选方案
                    const audioData = await decodeWebMWithOpusDecoder(buffer);
                    console.log(`✅ Opus 解码成功，采样率=16000Hz, 时长=${(audioData.length/16000).toFixed(2)}s`);
                    return audioData;
                } catch (opusError) {
                    console.error(`❌ Opus 解码也失败: ${opusError.message}`);
                    throw new Error(`WebM 解码失败: ${ffmpegError.message}, ${opusError.message}`);
                }
            }
        } else {
            // 对于其他格式，直接返回Buffer
            console.log(`📊 ${ext || '未知'}格式文件信息: 大小=${(buffer.length / 1024).toFixed(2)}KB, MIME类型=${mimetype}`);
            console.log(`🎯 格式已识别，直接传递给Whisper处理`);
            return buffer;
        }
    } catch (error) {
        console.error('❌ 音频缓冲解码失败:', error.message);
        throw new Error(`音频缓冲解码失败: ${error.message}`);
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

// 评估音频质量
function evaluateAudioQuality(audioData) {
    // 优化：避免在大音频数据上进行昂贵的操作
    // 只处理前10秒音频数据（16000Hz * 10s = 160000 samples）
    const maxSamples = 16000 * 10;
    const sampleData = audioData.length > maxSamples ? 
        audioData.slice(0, maxSamples) : audioData;
    
    // 计算均方根（RMS）音量
    let sum = 0;
    for (let i = 0; i < sampleData.length; i++) {
        sum += sampleData[i] * sampleData[i];
    }
    const rms = Math.sqrt(sum / sampleData.length);
    
    // 计算峰值音量
    let peak = 0;
    for (let i = 0; i < sampleData.length; i++) {
        const absSample = Math.abs(sampleData[i]);
        if (absSample > peak) {
            peak = absSample;
        }
    }
    
    // 简单评估：检测音量、信噪比等
    const isLowQuality = rms < 0.01; // 音量过低
    const isLowPeak = peak < 0.1;    // 峰值过低
    
    return {
        rms,
        peak,
        isLowQuality,
        isLowPeak,
        qualityScore: Math.min(1.0, Math.max(0.0, rms * 10)) // 0-1 质量评分
    };
}

// 根据音频质量调整预处理参数
function getPreprocessingParams(audioQuality) {
    if (audioQuality.isLowQuality || audioQuality.isLowPeak) {
        return {
            noiseReduction: "afftdn=nf=-30", // 更强的降噪
            volume: "volume=3",            // 更大的增益
            compression: "dynaudnorm=f=200"  // 更强的动态压缩
        };
    }
    return {
        noiseReduction: "afftdn=nf=-20", // 标准降噪
        volume: "volume=1.5",            // 适度增益
        compression: "dynaudnorm"        // 标准动态压缩
    };
}

// 使用 FFmpeg 解码 WebM 文件
async function decodeWebMWithFFmpeg(buffer) {
    let inputPath = null;
    let outputPath = null;
    let inputFileHandle = null;
    let outputFileHandle = null;
    
    try {
        // 检查是否有 ffmpeg 可用
        let ffmpegPath = 'ffmpeg';
        try {
            await execAsync('ffmpeg -version');
        } catch (e) {
            // 尝试使用 ffmpeg-static
            try {
                const ffmpegStatic = await import('ffmpeg-static');
                if (ffmpegStatic.default) {
                    ffmpegPath = ffmpegStatic.default;
                    console.log('📦 使用 ffmpeg-static');
                }
            } catch (staticError) {
                throw new Error('未找到 FFmpeg，请安装 ffmpeg 或 ffmpeg-static');
            }
        }
        
        // 获取 FFmpeg 的完整路径（避免短路径）
        try {
            if (fs.existsSync(ffmpegPath)) {
                ffmpegPath = fs.realpathSync(ffmpegPath);
            }
        } catch (realpathError) {
            console.warn('⚠️  无法获取 FFmpeg 完整路径，使用原始路径');
        }
        
        // 创建临时文件
        const tempDir = tmpdir();
        const uuid = randomUUID();
        inputPath = path.join(tempDir, `input_${uuid}.webm`);
        outputPath = path.join(tempDir, `output_${uuid}.wav`);
        
        // 使用 resolve 获取完整路径（避免短路径格式）
        inputPath = path.resolve(inputPath);
        outputPath = path.resolve(outputPath);
        
        // 写入输入文件并同步到磁盘
        console.log(`📝 写入临时文件: ${inputPath}`);
        inputFileHandle = fs.openSync(inputPath, 'w');
        fs.writeSync(inputFileHandle, buffer);
        fs.fsyncSync(inputFileHandle); // 确保数据写入磁盘
        fs.closeSync(inputFileHandle);
        inputFileHandle = null;
        
        // 验证文件已写入
        if (!fs.existsSync(inputPath)) {
            throw new Error('临时输入文件创建失败');
        }
        
        // 使用 FFmpeg 转换为 WAV 格式（16kHz, 单声道, PCM）
        // 在 Windows 上，路径需要特殊处理
        const isWindows = process.platform === 'win32';
        
        // 转义路径中的特殊字符，使用双引号包裹
        const escapePath = (filePath) => {
            // 在 Windows 上，路径中的反斜杠需要转义
            if (isWindows) {
                // 将反斜杠转换为正斜杠，或者保持反斜杠但正确转义
                return filePath.replace(/\\/g, '/');
            }
            return filePath;
        };
        
        const inputPathEscaped = escapePath(inputPath);
        const outputPathEscaped = escapePath(outputPath);
        const ffmpegPathEscaped = escapePath(ffmpegPath);
        
        // 构建命令，使用双引号包裹所有路径
        // 简化：移除可能不兼容的滤镜，确保基本功能正常
        const command = `"${ffmpegPathEscaped}" -i "${inputPathEscaped}" -ar 16000 -ac 1 -f wav -acodec pcm_s16le -y "${outputPathEscaped}"`;
        
        console.log('🔄 正在使用 FFmpeg 转换 WebM 文件...');
        console.log(`📋 FFmpeg 路径: ${ffmpegPathEscaped}`);
        console.log(`📋 输入文件: ${inputPathEscaped}`);
        console.log(`📋 输出文件: ${outputPathEscaped}`);
        
        try {
            const { stdout, stderr } = await execAsync(command, {
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                encoding: 'utf8'
            });
            
            if (stderr && !stderr.includes('Stream mapping') && !stderr.includes('Output')) {
                console.warn('⚠️  FFmpeg 警告:', stderr.substring(0, 200));
            }
        } catch (execError) {
            // 提供更详细的错误信息
            const errorMsg = execError.message || execError.toString();
            const errorDetails = execError.stderr || execError.stdout || '';
            console.error('❌ FFmpeg 执行失败:');
            console.error('   命令:', command);
            console.error('   错误:', errorMsg);
            if (errorDetails) {
                console.error('   详情:', errorDetails.substring(0, 500));
            }
            throw new Error(`FFmpeg 转换失败: ${errorMsg}`);
        }
        
        // 等待输出文件生成
        let retries = 10;
        while (!fs.existsSync(outputPath) && retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            retries--;
        }
        
        if (!fs.existsSync(outputPath)) {
            throw new Error('FFmpeg 输出文件未生成');
        }
        
        // 读取转换后的 WAV 文件
        const wavBuffer = fs.readFileSync(outputPath);
        
        if (wavBuffer.length === 0) {
            throw new Error('FFmpeg 输出文件为空');
        }
        
        // 使用 WavDecoder 解码 WAV 数据
        const decoded = await WavDecoder.decode(wavBuffer);
        
        // 转换为 Float32Array（单声道）
        let audioData = decoded.channelData.length > 1 
            ? mergeChannels(decoded.channelData)
            : decoded.channelData[0];
        
        // 确保采样率为 16kHz
        if (decoded.sampleRate !== 16000) {
            console.log(`🔄 重采样: ${decoded.sampleRate}Hz → 16000Hz`);
            audioData = resampleAudio(audioData, decoded.sampleRate, 16000);
        }
        
        return audioData;
        
    } catch (error) {
        console.error('❌ FFmpeg 解码 WebM 失败:', error.message);
        if (error.stack) {
            console.error('   堆栈:', error.stack.split('\n').slice(0, 5).join('\n'));
        }
        throw error;
    } finally {
        // 清理临时文件
        try {
            if (inputFileHandle) {
                try {
                    fs.closeSync(inputFileHandle);
                } catch (e) {
                    // 忽略关闭错误
                }
            }
            if (inputPath && fs.existsSync(inputPath)) {
                fs.unlinkSync(inputPath);
            }
            if (outputPath && fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        } catch (cleanupError) {
            console.warn('⚠️  清理临时文件失败:', cleanupError.message);
        }
    }
}

// 使用 opus-decoder 解码 WebM 文件（备选方案）
// 注意：这个实现需要先解析 WebM 容器，目前作为备选方案
async function decodeWebMWithOpusDecoder(buffer) {
    // WebM 容器格式需要先解析才能提取 Opus 数据
    // 这个实现目前不支持直接解码 WebM 容器
    // 建议使用 FFmpeg 进行解码
    throw new Error('Opus 解码器需要先解析 WebM 容器，请使用 FFmpeg 进行解码');
}

// 验证WebM文件完整性
function validateWebM(buffer) {
    // 检查WebM文件头
    if (buffer.length < 4) {
        return false;
    }
    
    // WebM文件的魔术数字是0x1a45dfa3
    const webmSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    return buffer.subarray(0, 4).equals(webmSignature);
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

// WASM 性能优化配置
env.simd = true; // 启用 SIMD 支持，提升 WASM 执行速度
console.log('⚡ 已启用 WASM SIMD 支持');

env.wasmMemoryLimit = 1024; // 设置 WASM 内存限制为 1024 MB
console.log('📊 WASM 内存限制设置为:', env.wasmMemoryLimit + 'MB');

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
            console.log('📦 模型名称:', this.model);
            console.log('🔢 量化选项:', this.quantized);
            
            this.instance = await pipeline(this.task, this.model, {
                quantized: this.quantized,
                progress_callback: progressCallback,
                
                // 关键修复：明确指定模型类型为 whisper，避免系统错误选择 CTC 架构
                model_type: 'whisper',
                
                // 对于中等模型，需要加载 no_attentions 版本以避免内存不足
                revision: this.model.includes('/whisper-medium') ? 'no_attentions' : 'main'
            });
            console.log('✅ Whisper 模型加载完成');
        }
        return this.instance;
    }

    static async dispose() {
        if (this.instance !== null) {
            try {
                await this.instance.dispose();
                console.log('🗑️  模型实例已释放');
            } catch (error) {
                console.error('❌ 释放模型实例失败:', error.message);
            } finally {
                this.instance = null;
                this.model = null;
                this.quantized = null;
                // 触发垃圾回收
                if (global.gc) {
                    global.gc();
                    console.log('🧹 已触发垃圾回收');
                }
            }
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
        
        // 处理模型名称，支持简写（如 base → Xenova/whisper-base）
        let modelName = config.model;
        
        // 如果是简写模型名称，添加完整前缀
        const modelShortNames = ['tiny', 'base', 'small', 'medium', 'large'];
        if (modelShortNames.includes(modelName)) {
            modelName = `Xenova/whisper-${modelName}`;
        }
        
        // 检查是否是 Distil Whisper 模型
        const isDistilWhisper = modelName.startsWith('distil-whisper/');
        
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
        
                // 评估音频质量
        const audioQuality = evaluateAudioQuality(audioData);
        console.log('📊 音频质量评估:', {
            rms: audioQuality.rms.toFixed(6),
            peak: audioQuality.peak.toFixed(6),
            qualityScore: audioQuality.qualityScore.toFixed(2),
            isLowQuality: audioQuality.isLowQuality,
            isLowPeak: audioQuality.isLowPeak
        });
        
        // 执行转录 - 确保传入正确的音频格式
        let output;
        
        // 构建转录配置
        const transcribeConfig = {
            // 根据音频质量调整解码策略
            top_k: audioQuality.isLowQuality ? 5 : 0,
            top_p: audioQuality.isLowQuality ? 0.9 : 1.0,
            temperature: audioQuality.isLowQuality ? 0.1 : 0.0,
            beam_size: audioQuality.isLowQuality ? 5 : 1,
            patience: audioQuality.isLowQuality ? 1.5 : 1.0,
            length_penalty: 1.0,
            
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
            },
            
            // 其他优化
            compression_ratio_threshold: 2.4,
            logprob_threshold: -1.0,
            no_speech_threshold: 0.6
        };
        
        try {
            let transcriptionInput = audioData;
            
            // 转换为合适的格式
            if (audioData instanceof Float32Array || audioData instanceof Float64Array) {
                // 如果已经是 Float32Array 或 Float64Array，直接使用
                console.log('🎯 音频数据已为 Float32Array 或 Float64Array，直接传递给 Whisper');
            } else if (audioData instanceof Buffer) {
                // 如果是 Buffer，将其转换为 ArrayBuffer 后使用
                console.log('🎯 音频数据为 Buffer，转换为 ArrayBuffer 后直接传递');
                transcriptionInput = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength);
            } else if (audioData instanceof ArrayBuffer) {
                // 如果是 ArrayBuffer，直接使用
                console.log('🎯 音频数据为 ArrayBuffer，直接传递');
            } else {
                // 其他情况，直接使用
                console.log('🎯 音频数据为其他类型，直接传递:', typeof audioData);
            }
            
            // 使用带有重试机制的转录函数
            output = await transcribeWithRetry(transcriber, transcriptionInput, transcribeConfig);
            
            // 如果重试后仍然没有结果，抛出错误
            if (!output) {
                throw new Error('所有转录尝试均失败，结果质量不满足要求');
            }
        } catch (transcribeError) {
            console.error('❌ 转录过程出错:', transcribeError.message);
            console.error('❌ 转录错误堆栈:', transcribeError.stack);
            throw transcribeError;
        }
        
        console.log('✅ 语音识别完成！');
        
        // 调试：查看 output 对象结构
        console.log('🔍 调试：output 对象:', JSON.stringify(output, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                const limited = {};
                for (const k of Object.keys(value).slice(0, 10)) {
                    limited[k] = value[k];
                }
                if (Object.keys(value).length > 10) {
                    limited['...'] = `${Object.keys(value).length - 10} more keys`;
                }
                return limited;
            }
            return value;
        }, 2));
        
        // 调试：查看 output.text
        console.log('🔍 调试：output.text:', typeof output.text, output.text);
        
        // 调试：查看 output.text 长度
        console.log('🔍 调试：output.text 长度:', output.text ? output.text.length : 0);
        
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
        
        // 调试：查看 result.text
        console.log('🔍 调试：result.text:', typeof result.text, result.text);
        console.log('🔍 调试：result.text 长度:', result.text ? result.text.length : 0);
        
        // 如果检测到繁体字，转换为简体并记录
        if (output.text !== result.text) {
            console.log('🔄 检测到繁体字，已转换为简体中文');
        }
        
        // 注意：不需要手动设置 audioData 和 output 为 null
        // JavaScript 垃圾回收器会自动处理不再引用的变量
        
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

// 从内存缓冲区处理音频数据
export async function audioFromBuffer(audioBuffer, options = {}) {
    try {
        // 检查传入的数据
        if (!audioBuffer) {
            throw new Error('没有提供音频数据');
        }
        
        console.log('🚀 开始处理内存中的音频数据');
        console.log(`📁 数据大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
        
        // 获取文件信息（如果有）
        const filename = options.filename || '内存中的音频';
        const mimetype = options.mimetype || 'application/octet-stream';
        const ext = options.ext || path.extname(filename).toLowerCase();
        
        console.log(`📄 原始文件名: ${filename}`);
        console.log(`🎭 MIME类型: ${mimetype}`);
        
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
        
        // 处理模型名称，支持简写（如 base → Xenova/whisper-base）
        let modelName = config.model;
        
        // 如果是简写模型名称，添加完整前缀
        const modelShortNames = ['tiny', 'base', 'small', 'medium', 'large'];
        if (modelShortNames.includes(modelName)) {
            modelName = `Xenova/whisper-${modelName}`;
        }
        
        // 检查是否是 Distil Whisper 模型
        const isDistilWhisper = modelName.startsWith('distil-whisper/');
        
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
        
        // 解码音频缓冲区
        console.log('🔧 正在解码音频数据...');
        const audioData = await decodeAudioBuffer(audioBuffer, ext, mimetype);
        
        // 计算时间精度
        const timePrecision = transcriber.processor.feature_extractor.config.chunk_length / 
                             transcriber.model.config.max_source_positions;
        
        console.log('🎤 正在进行语音识别...');
        console.log(`📏 分块长度: ${isDistilWhisper ? 20 : 30}s`);
        console.log(`📐 步长: ${isDistilWhisper ? 3 : 5}s`);
        
        // 评估音频质量
        const audioQuality = evaluateAudioQuality(audioData);
        console.log('📊 音频质量评估:', {
            rms: audioQuality.rms.toFixed(6),
            peak: audioQuality.peak.toFixed(6),
            qualityScore: audioQuality.qualityScore.toFixed(2),
            isLowQuality: audioQuality.isLowQuality,
            isLowPeak: audioQuality.isLowPeak
        });
        
        // 执行转录 - 确保传入正确的音频格式
        let output;
        
        // 优化：根据音频质量调整解码参数
        const transcribeConfig = {
            // 根据音频质量调整解码策略
            top_k: audioQuality.isLowQuality ? 5 : 0,
            top_p: audioQuality.isLowQuality ? 0.9 : 1.0,
            temperature: audioQuality.isLowQuality ? 0.1 : 0.0,
            beam_size: audioQuality.isLowQuality ? 5 : 1,
            patience: audioQuality.isLowQuality ? 1.5 : 1.0,
            length_penalty: 1.0,
            
            // 滑动窗口
            chunk_length_s: isDistilWhisper ? 20 : 30,
            stride_length_s: isDistilWhisper ? 3 : 5,
            
            // 语言和任务
            language: config.language,
            task: config.subtask,
            
            // 返回时间戳
            return_timestamps: true,
            
            // 其他优化
            compression_ratio_threshold: 2.4,
            logprob_threshold: -1.0,
            no_speech_threshold: 0.6
        };
        
        try {
            let transcriptionInput = audioData;
            
            // 转换为合适的格式
            if (audioData instanceof Float32Array || audioData instanceof Float64Array) {
                // 如果已经是 Float32Array 或 Float64Array，直接使用
                console.log('🎯 音频数据已为 Float32Array 或 Float64Array，直接传递给 Whisper');
            } else if (audioData instanceof Buffer) {
                // 如果是 Buffer，将其转换为 ArrayBuffer 后使用
                console.log('🎯 音频数据为 Buffer，转换为 ArrayBuffer 后直接传递');
                transcriptionInput = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength);
            } else if (audioData instanceof ArrayBuffer) {
                // 如果是 ArrayBuffer，直接使用
                console.log('🎯 音频数据为 ArrayBuffer，直接传递');
            } else {
                // 其他情况，直接使用
                console.log('🎯 音频数据为其他类型，直接传递:', typeof audioData);
            }
            
            // 使用带有重试机制的转录函数
            output = await transcribeWithRetry(transcriber, transcriptionInput, transcribeConfig);
            
            // 如果重试后仍然没有结果，抛出错误
            if (!output) {
                throw new Error('所有转录尝试均失败，结果质量不满足要求');
            }
        } catch (transcribeError) {
            console.error('❌ 转录过程出错:', transcribeError.message);
            console.error('❌ 转录错误堆栈:', transcribeError.stack);
            throw transcribeError;
        }
        
        console.log('✅ 语音识别完成！');
        
        // 调试：查看 output 对象结构
        console.log('🔍 调试：output 对象:', JSON.stringify(output, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                const limited = {};
                for (const k of Object.keys(value).slice(0, 10)) {
                    limited[k] = value[k];
                }
                if (Object.keys(value).length > 10) {
                    limited['...'] = `${Object.keys(value).length - 10} more keys`;
                }
                return limited;
            }
            return value;
        }, 2));
        
        // 调试：查看 output.text
        console.log('🔍 调试：output.text:', typeof output.text, output.text);
        
        // 调试：查看 output.text 长度
        console.log('🔍 调试：output.text 长度:', output.text ? output.text.length : 0);
        
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
        
        // 调试：查看 result.text
        console.log('🔍 调试：result.text:', typeof result.text, result.text);
        console.log('🔍 调试：result.text 长度:', result.text ? result.text.length : 0);
        
        // 如果检测到繁体字，转换为简体并记录
        if (output.text !== result.text) {
            console.log('🔄 检测到繁体字，已转换为简体中文');
        }
        
        // 注意：不需要手动设置 audioData 和 output 为 null
        // JavaScript 垃圾回收器会自动处理不再引用的变量
        
        return result;
        
    } catch (error) {
        console.error('❌ 音频缓冲区处理出错:', error.message);
        
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

// 批量处理内存中的音频缓冲区
export async function batchAudioFromBuffers(audioBuffers, options = []) {
    if (!Array.isArray(audioBuffers)) {
        throw new Error('需要提供音频缓冲区数组');
    }
    
    // 如果没有提供单独的选项数组，则对所有音频应用相同的选项
    if (!Array.isArray(options) || options.length === 0) {
        options = Array(audioBuffers.length).fill({});
    }
    
    // 确保选项数组长度与音频缓冲区数组匹配
    if (options.length !== audioBuffers.length) {
        throw new Error(`选项数组长度(${options.length})与音频缓冲区数组长度(${audioBuffers.length})不匹配`);
    }
    
    const results = [];
    
    console.log(`📂 开始批量处理 ${audioBuffers.length} 个音频缓冲区...\n`);
    
    for (let i = 0; i < audioBuffers.length; i++) {
        const audioBuffer = audioBuffers[i];
        const bufferOptions = options[i];
        const filename = bufferOptions.filename || `内存中的音频${i+1}`;
        
        console.log(`--- 处理缓冲区 ${i + 1}/${audioBuffers.length}: ${filename} ---`);
        
        try {
            const result = await audioFromBuffer(audioBuffer, bufferOptions);
            results.push({
                index: i,
                filename: filename,
                success: true,
                text: result.text,
                duration: result.duration,
                confidence: result.confidence,
                language: result.language,
                timestamp: result.timestamp
            });
            console.log(`✅ 缓冲区 ${i + 1} 处理成功\n`);
        } catch (error) {
            results.push({
                index: i,
                filename: filename,
                success: false,
                error: error.message
            });
            console.log(`❌ 缓冲区 ${i + 1} 处理失败: ${error.message}\n`);
        }
    }
    
    return results;
}



// 计算置信度
function calculateConfidence(chunks) {
    if (!chunks || chunks.length === 0) return 0.8;
    
    const totalConfidence = chunks.reduce((sum, chunk) => {
        return sum + (chunk.avg_logprob || -0.5);
    }, 0);
    
    return Math.max(0.1, Math.min(1.0, (totalConfidence / chunks.length + 1) / 2));
}

// 验证转录结果质量
function validateTranscription(result) {
    if (!result) {
        return false;
    }
    
    // 检查是否有文本输出
    const hasText = result.text && result.text.trim().length > 0;
    if (!hasText) {
        return false;
    }
    
    // 放宽验证标准：只检查是否有文本，不检查置信度和长度
    return true;
}

// 带有重试机制的转录函数
async function transcribeWithRetry(transcriber, audioData, config, maxRetries = 2) {
    let attempt = 0;
    let result = null;
    
    // 复制原始配置，避免修改原始对象
    const originalConfig = { ...config };
    
    while (attempt <= maxRetries && !result) {
        try {
            console.log(`📝 转录尝试 ${attempt + 1}/${maxRetries + 1}`);
            
            // 每次尝试使用新的配置对象
            const attemptConfig = { ...originalConfig };
            
            // 根据尝试次数调整参数
            if (attempt > 0) {
                console.log(`🔧 调整解码参数，尝试第 ${attempt + 1} 次`);
                // 只调整必要的参数，避免冲突
                attemptConfig.temperature = 0.2;
                attemptConfig.beam_size = 5;
                attemptConfig.patience = 1.0;
            }
            
            // 执行转录
            result = await transcriber(audioData, attemptConfig);
            
            // 验证转录结果（放宽验证标准）
            if (result && result.text && result.text.trim().length > 0) {
                const confidence = result.confidence || calculateConfidence(result.chunks || []);
                console.log(`✅ 转录尝试 ${attempt + 1} 成功，置信度: ${confidence.toFixed(3)}`);
                return result;
            } else {
                console.log(`⚠️  转录尝试 ${attempt + 1} 结果质量不高，尝试调整参数重试...`);
                // 重置结果
                result = null;
            }
        } catch (error) {
            console.error(`❌ 转录尝试 ${attempt + 1} 失败:`, error.message);
            
            // 如果是参数冲突错误，直接返回当前结果
            if (error.message.includes('Cannot specify')) {
                console.log(`⚠️  参数冲突，直接返回当前结果`);
                return result;
            }
        }
        
        attempt++;
    }
    
    return result;
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