// 使用示例 1: 基本音频转文本
const { audioToText } = require('./whisper');

async function basicExample() {
    try {
        console.log('🎤 基本音频转文本示例\n');
        
        const result = await audioToText('./test-audio.wav', {
            language: 'zh',        // 中文
            task: 'transcribe',    // 转录任务
            chunk_length_s: 30,    // 30秒分块
            stride_length_s: 5     // 5秒重叠
        });
        
        console.log('📝 转录结果:');
        console.log(result.text);
        
        // 如果有时间戳信息
        if (result.chunks) {
            console.log('\n⏰ 时间戳信息:');
            result.chunks.forEach((chunk, index) => {
                const [start, end] = chunk.timestamp;
                console.log(`${index + 1}. [${start.toFixed(1)}s - ${end.toFixed(1)}s]: ${chunk.text}`);
            });
        }
        
    } catch (error) {
        console.error('❌ 转录失败:', error.message);
    }
}

// 使用示例 2: 批量处理音频文件
const { batchAudioToText } = require('./whisper');

async function batchExample() {
    try {
        console.log('📁 批量音频处理示例\n');
        
        const audioFiles = [
            './audio1.wav',
            './audio2.mp3',
            './audio3.m4a'
        ];
        
        const results = await batchAudioToText(audioFiles, {
            language: 'auto',      // 自动检测语言
            task: 'transcribe'
        });
        
        console.log('📊 处理结果:');
        results.forEach((result, index) => {
            console.log(`\n--- 文件 ${index + 1}: ${result.file} ---`);
            if (result.success) {
                console.log('✅ 转录成功');
                console.log('📝 内容:', result.text);
            } else {
                console.log('❌ 转录失败:', result.error);
            }
        });
        
    } catch (error) {
        console.error('❌ 批量处理失败:', error.message);
    }
}

// 使用示例 3: 多语言支持
async function multilingualExample() {
    try {
        console.log('🌍 多语言音频转文本示例\n');
        
        // 英文音频
        const englishResult = await audioToText('./english-audio.wav', {
            language: 'en',
            task: 'transcribe'
        });
        
        console.log('🇺🇸 英文转录:');
        console.log(englishResult.text);
        
        // 日文音频
        const japaneseResult = await audioToText('./japanese-audio.wav', {
            language: 'ja',
            task: 'transcribe'
        });
        
        console.log('\n🇯🇵 日文转录:');
        console.log(japaneseResult.text);
        
    } catch (error) {
        console.error('❌ 多语言转录失败:', error.message);
    }
}

// 使用示例 4: 实时流式处理 (模拟)
async function streamingExample() {
    try {
        console.log('🔄 模拟实时流式转录示例\n');
        
        // 这里演示如何处理长音频的分块转录
        const longAudioFile = './long-audio.wav';
        
        const result = await audioToText(longAudioFile, {
            language: 'auto',
            task: 'transcribe',
            chunk_length_s: 30,        // 30秒分块
            stride_length_s: 5,        // 5秒重叠
            return_timestamps: true    // 返回时间戳
        });
        
        console.log('📝 长音频转录结果:');
        console.log('总时长:', Math.round(result.chunks[result.chunks.length - 1].timestamp[1]), '秒');
        console.log('段落数:', result.chunks.length);
        
        // 展示前几个片段
        console.log('\n前5个片段:');
        result.chunks.slice(0, 5).forEach((chunk, index) => {
            const [start, end] = chunk.timestamp;
            console.log(`${index + 1}. [${start.toFixed(1)}s - ${end.toFixed(1)}s]: ${chunk.text}`);
        });
        
    } catch (error) {
        console.error('❌ 流式转录失败:', error.message);
    }
}

// 使用示例 5: 翻译功能
async function translationExample() {
    try {
        console.log('🔄 音频转文本 + 翻译示例\n');
        
        const result = await audioToText('./chinese-audio.wav', {
            language: 'zh',           // 源语言：中文
            task: 'translate',        // 翻译任务（将非英文音频翻译为英文）
            return_timestamps: true
        });
        
        console.log('🇨🇳 中文音频 → 🇺🇸 英文翻译:');
        console.log(result.text);
        
        if (result.chunks) {
            console.log('\n⏰ 带时间戳的翻译结果:');
            result.chunks.forEach((chunk, index) => {
                const [start, end] = chunk.timestamp;
                console.log(`${index + 1}. [${start.toFixed(1)}s - ${end.toFixed(1)}s]: ${chunk.text}`);
            });
        }
        
    } catch (error) {
        console.error('❌ 翻译失败:', error.message);
    }
}

// 主函数：运行所有示例
async function runAllExamples() {
    console.log('🎯 Whisper 音频转文本使用示例集合');
    console.log('=' .repeat(60));
    
    // 注意：这些示例需要实际的音频文件才能运行
    // 这里只是展示API的使用方法
    
    console.log('\n📝 示例 1: 基本转录');
    await basicExample();
    
    console.log('\n📁 示例 2: 批量处理');
    await batchExample();
    
    console.log('\n🌍 示例 3: 多语言支持');
    await multilingualExample();
    
    console.log('\n🔄 示例 4: 长音频处理');
    await streamingExample();
    
    console.log('\n🔄 示例 5: 翻译功能');
    await translationExample();
    
    console.log('\n✨ 所有示例运行完成！');
    console.log('\n💡 提示:');
    console.log('   - 将实际的音频文件放在项目目录中');
    console.log('   - 修改示例中的文件路径为你的实际文件');
    console.log('   - 支持的格式: WAV, MP3, MP4, M4A, FLAC, OGG');
}

// 导出所有示例函数
module.exports = {
    basicExample,
    batchExample,
    multilingualExample,
    streamingExample,
    translationExample,
    runAllExamples
};

// 如果直接运行此文件
if (require.main === module) {
    runAllExamples().catch(error => {
        console.error('💥 示例运行出错:', error);
    });
}