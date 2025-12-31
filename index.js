#!/usr/bin/env node

const { audioToText, batchAudioToText, main } = require('./whisper');

// 命令行参数解析
const args = process.argv.slice(2);
const command = args[0];
const audioFile = args[1];

async function runCommand() {
    switch (command) {
        case 'transcribe':
        case 't':
            if (!audioFile) {
                console.error('❌ 请提供音频文件路径');
                console.log('用法: node index.js transcribe <音频文件路径>');
                process.exit(1);
            }
            
            try {
                const result = await audioToText(audioFile, {
                    language: 'auto', // 自动检测语言
                    task: 'transcribe'
                });
                
                console.log('\n📝 识别结果:');
                console.log('=' .repeat(50));
                console.log(result.text);
                
                if (result.chunks) {
                    console.log('\n⏰ 时间戳:');
                    result.chunks.forEach((chunk, index) => {
                        console.log(`${index + 1}. [${chunk.timestamp[0].toFixed(1)}s - ${chunk.timestamp[1].toFixed(1)}s]: ${chunk.text}`);
                    });
                }
            } catch (error) {
                console.error('❌ 转录失败:', error.message);
                process.exit(1);
            }
            break;

        case 'batch':
        case 'b':
            if (!audioFile) {
                console.error('❌ 请提供音频文件列表');
                console.log('用法: node index.js batch <音频文件1> <音频文件2> ...');
                process.exit(1);
            }
            
            try {
                const files = args.slice(1);
                const results = await batchAudioToText(files);
                
                console.log('\n📊 批量处理结果:');
                console.log('=' .repeat(50));
                
                results.forEach((result, index) => {
                    console.log(`\n文件 ${index + 1}: ${result.file}`);
                    if (result.success) {
                        console.log('✅ 成功');
                        console.log(`文本: ${result.text}`);
                    } else {
                        console.log('❌ 失败:', result.error);
                    }
                });
            } catch (error) {
                console.error('❌ 批量处理失败:', error.message);
                process.exit(1);
            }
            break;

        case 'demo':
        case 'd':
            await main();
            break;

        case 'help':
        case 'h':
            showHelp();
            break;

        default:
            if (!command) {
                // 默认运行演示
                await main();
            } else {
                console.error(`❌ 未知命令: ${command}`);
                showHelp();
                process.exit(1);
            }
            break;
    }
}

function showHelp() {
    console.log(`
🎤 Whisper 音频转文本工具 (Node.js + WASM)

用法:
  node index.js [命令] [参数]

命令:
  transcribe <音频文件>    转录音频文件 (别名: t)
  batch <音频文件...>      批量处理多个音频文件 (别名: b)
  demo                    运行演示 (别名: d)
  help                    显示帮助信息 (别名: h)

示例:
  node index.js transcribe ./audio.wav
  node index.js t ./audio.mp3
  node index.js batch ./file1.wav ./file2.mp3 ./file3.m4a
  node index.js demo

支持的音频格式: WAV, MP3, MP4, M4A, FLAC, OGG
    `);
}

// 运行命令
runCommand().catch(error => {
    console.error('💥 程序异常:', error);
    process.exit(1);
});