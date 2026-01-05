// ==UserScript==
// @name         实时视频字幕生成（Web Audio API版）
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  使用Web Audio API直接从视频缓冲区捕获实时音频，实现真正的实时字幕
// @author       You
// @match        https://www.douyin.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('实时视频字幕生成脚本已加载（Web Audio API版）');

    // 配置
    const CONFIG = {
        API_ENDPOINT: 'http://localhost:3000/api/transcribe',
        SAMPLE_RATE: 16000, // Whisper 使用的采样率
        BUFFER_SIZE: 4096, // ScriptProcessor 缓冲区大小 (约250ms@16kHz)
        ACCUMULATE_DURATION: 3, // 累积3秒音频后发送，平衡精度和延迟
        CACHE_DURATION: 60000, // 字幕缓存时长：60秒
        DELAY_MULTIPLIER: 1, // 延迟倍数，1表示完全抵消延迟，可调节
        SUBTITLE_BASE_DURATION: 5000, // 字幕基础显示时间（毫秒）
        SUBTITLE_CHAR_DURATION: 300 // 每个字符额外显示时间（毫秒）
    };

    // 核心状态管理
    let state = {
        videoElement: null, // 当前视频元素
        isRecording: false, // 录制状态
        isProcessing: false, // 是否正在处理音频（防止重复处理）
        audioContext: null, // AudioContext实例
        scriptProcessor: null, // ScriptProcessor节点
        sourceNode: null, // 媒体源节点
        audioAccumulator: [], // 累积的音频数据
        accumulatorSize: 0, // 累积的样本数量
        segmentStartTime: null, // 当前音频段开始时的视频时间
        subtitleElement: null, // 字幕元素
        containerElement: null, // 字幕容器
        subtitleCache: new Map(), // 字幕缓存
        subtitleQueue: [], // 字幕队列，存储待显示的字幕
        displayCheckInterval: null, // 字幕显示检查定时器
        lastProcessedTime: 0, // 上次处理时间
        isPlaying: false, // 视频播放状态
        delayMultiplier: 1, // 当前延迟倍数
        subtitleBaseDuration: 5000, // 字幕基础显示时间
        subtitleCharDuration: 300, // 每个字符额外显示时间
        audioQueue: [], // 音频数据队列
        maxQueueSize: 10, // 最大队列长度
        processingTimeout: null, // 处理超时定时器
        subtitleHideTimeout: null, // 字幕隐藏超时定时器
        lastSubtitleText: '', // 上次显示的字幕文本
        lastSubtitleTime: 0, // 上次显示字幕的时间
        isSameSubtitle: false // 是否是相同的字幕
    };

    // 日志工具
    const logger = {
        debug: (...args) => {
            console.log('[DEBUG]', ...args);
        },
        info: (...args) => {
            console.log('[INFO]', ...args);
        },
        error: (...args) => {
            console.error('[ERROR]', ...args);
        }
    };

    // 创建字幕容器
    function createSubtitleContainer() {
        logger.debug('创建字幕容器');

        // 检查是否已经存在
        let existingContainer = document.getElementById('realtime-subtitle-container');
        let existingSubtitle = document.getElementById('realtime-subtitle-text');

        if (existingContainer && existingSubtitle) {
            logger.debug('复用现有字幕容器');
            return { container: existingContainer, subtitle: existingSubtitle };
        }

        // 创建新的字幕容器
        const container = document.createElement('div');
        container.id = 'realtime-subtitle-container';
        container.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 999999;
            max-width: 80%;
            text-align: center;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
            background: transparent;
        `;

        const subtitle = document.createElement('div');
        subtitle.id = 'realtime-subtitle-text';
        subtitle.style.cssText = `
            display: inline-block;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 30px;
            font-size: 24px;
            font-weight: bold;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
            opacity: 0;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
            line-height: 1.5;
        `;

        container.appendChild(subtitle);
        document.body.appendChild(container);

        logger.debug('字幕容器创建完成');
        return { container, subtitle };
    }

    // 获取当前视频元素
    function getCurrentVideo() {
        const videos = document.querySelectorAll('video');
        return videos[0] || null; // 简单获取第一个视频
    }

    // Float32 转 Int16 PCM
    function floatTo16BitPCM(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    // 写入字符串到 DataView
    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    // 编码 WAV 格式
    function encodeWAV(int16Array, sampleRate) {
        const buffer = new ArrayBuffer(44 + int16Array.length * 2);
        const view = new DataView(buffer);

        // WAV 文件头
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + int16Array.length * 2, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // fmt chunk size
        view.setUint16(20, 1, true); // audio format (PCM)
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // byte rate
        view.setUint16(32, 2, true); // block align
        view.setUint16(34, 16, true); // bits per sample
        writeString(view, 36, 'data');
        view.setUint32(40, int16Array.length * 2, true);

        // 写入音频数据
        const offset = 44;
        for (let i = 0; i < int16Array.length; i++) {
            view.setInt16(offset + i * 2, int16Array[i], true);
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    // 获取自适应累积时长
    function getAdaptiveAccumulateDuration() {
        // 根据队列长度动态调整累积时长
        const baseDuration = CONFIG.ACCUMULATE_DURATION;
        const queueFactor = Math.min(state.audioQueue.length * 0.5, 2); // 最多增加2秒
        return baseDuration + queueFactor;
    }

    // 将音频加入处理队列
    function queueAudioForProcessing() {
        // 将当前累积的音频数据加入队列
        const audioData = {
            data: [...state.audioAccumulator], // 深拷贝
            segmentStartTime: state.segmentStartTime,
            timestamp: Date.now()
        };

        // 如果队列未满，加入队列
        if (state.audioQueue.length < state.maxQueueSize) {
            state.audioQueue.push(audioData);
            logger.debug(`音频已加入队列，队列长度: ${state.audioQueue.length}`);
        } else {
            logger.warn('队列已满，丢弃最早的音频数据');
            // 使用先进先出策略，丢弃最旧的数据
            state.audioQueue.shift();
            state.audioQueue.push(audioData);
        }

        // 清空当前累积缓冲区
        state.audioAccumulator = [];
        state.accumulatorSize = 0;
        state.segmentStartTime = null;

        // 如果没有正在处理的任务，立即处理队列中的音频
        if (!state.isProcessing) {
            processQueuedAudio();
        }
    }

    // 处理队列中的下一个音频
    function processNextAudio() {
        // 使用 setTimeout(0) 实现非阻塞处理
        setTimeout(() => {
            processQueuedAudio();
        }, 0);
    }

    // 累积音频数据
    function accumulateAudioData(float32Array) {
        // 如果是新的累积周期，记录开始时间
        if (state.audioAccumulator.length === 0) {
            state.segmentStartTime = state.videoElement.currentTime;
            logger.debug('新的音频段开始，视频时间:', state.segmentStartTime.toFixed(2));
        }

        logger.debug('accumulateAudioData 被调用，输入样本数:', float32Array.length);

        // 将 Float32 转换为 Int16 PCM
        const int16Array = floatTo16BitPCM(float32Array);

        // 累积到缓冲区
        state.audioAccumulator.push(int16Array);
        state.accumulatorSize += int16Array.length;

        // 使用自适应累积时长
        const adaptiveDuration = getAdaptiveAccumulateDuration();
        const accumulatedDuration = state.accumulatorSize / CONFIG.SAMPLE_RATE;
        logger.debug(`累积进度: ${accumulatedDuration.toFixed(2)}秒 / ${adaptiveDuration.toFixed(2)}秒 (队列长度: ${state.audioQueue.length})`);

        // 达到目标时长后加入队列
        if (accumulatedDuration >= adaptiveDuration) {
            logger.info('✅ 达到自适应累积时长，加入处理队列');
            queueAudioForProcessing();
        }
    }

    // 异步处理队列中的音频
    async function processQueuedAudio() {
        if (state.isProcessing || state.audioQueue.length === 0) {
            return;
        }

        state.isProcessing = true;

        // 设置处理超时（5秒）
        state.processingTimeout = setTimeout(() => {
            logger.warn('音频处理超时，强制结束');
            state.isProcessing = false;
            processNextAudio();
        }, 5000);

        try {
            // 从队列取出音频数据
            const audioTask = state.audioQueue.shift();
            const segmentEndTime = state.videoElement.currentTime;

            logger.debug('开始处理队列中的音频');

            // 合并音频数据
            const totalLength = audioTask.data.reduce((sum, arr) => sum + arr.length, 0);
            const mergedArray = new Int16Array(totalLength);
            let offset = 0;

            for (const arr of audioTask.data) {
                mergedArray.set(arr, offset);
                offset += arr.length;
            }

            // 编码为 WAV 格式
            const wavBlob = encodeWAV(mergedArray, CONFIG.SAMPLE_RATE);

            logger.debug('发送 WAV 音频，大小:', wavBlob.size, '字节');

            // 发送到后端
            const result = await sendToBackend(wavBlob);

            if (result && result.success) {
                let text = result.text || result.data?.text || '';

                // 验证和处理后端返回的文本，处理null时间戳问题
                if (text) {
                    // 清理重复的单字符文本（如"小小小"）
                    const cleanedText = text.replace(/(.)\1{2,}/g, '$1');

                    // 如果文本被清理了，记录警告
                    if (cleanedText !== text) {
                        logger.warn('检测到重复字符，已清理:', `原始: "${text}" -> 清理后: "${cleanedText}"`);
                    }

                    // 使用清理后的文本
                    text = cleanedText;

                    logger.info('识别到文本:', text);

                    // 保存字幕到队列
                    const subtitle = {
                        text,
                        startTime: audioTask.segmentStartTime,
                        endTime: segmentEndTime
                    };
                    state.subtitleQueue.push(subtitle);
                    logger.debug('字幕已加入队列:', subtitle);

                    // 兼容旧的缓存方式
                    saveSubtitleToCache({ text, timestamp: Date.now() });
                } else {
                    logger.warn('后端返回空文本，可能存在时间戳问题');
                }
            }

        } catch (error) {
            logger.error('处理队列音频失败:', error);
        } finally {
            // 清理超时定时器
            if (state.processingTimeout) {
                clearTimeout(state.processingTimeout);
                state.processingTimeout = null;
            }

            state.isProcessing = false;
            logger.debug('音频处理完成，处理下一个队列项');

            // 处理队列中的下一个音频
            processNextAudio();
        }
    }

    // 处理实时音频数据（保留向后兼容）
    async function processRealTimeAudio() {
        if (state.audioAccumulator.length === 0 || state.isProcessing) {
            if (state.isProcessing) {
                logger.debug('正在处理中，跳过本次请求');
            }
            return;
        }

        state.isProcessing = true;
        const segmentEndTime = state.videoElement.currentTime;
        logger.debug('开始处理音频，防止重复处理');

        try {
            // 合并所有累积的音频数据
            const totalLength = state.audioAccumulator.reduce((sum, arr) => sum + arr.length, 0);
            const mergedArray = new Int16Array(totalLength);
            let offset = 0;

            for (const arr of state.audioAccumulator) {
                mergedArray.set(arr, offset);
                offset += arr.length;
            }

            // 编码为 WAV 格式
            const wavBlob = encodeWAV(mergedArray, CONFIG.SAMPLE_RATE);

            logger.debug('发送 WAV 音频，大小:', wavBlob.size, '字节');

            // 发送到后端
            const result = await sendToBackend(wavBlob);

            if (result && result.success) {
                let text = result.text || result.data?.text || '';

                // 验证和处理后端返回的文本，处理null时间戳问题
                if (text) {
                    // 清理重复的单字符文本（如"小小小"）
                    const cleanedText = text.replace(/(.)\1{2,}/g, '$1');

                    // 如果文本被清理了，记录警告
                    if (cleanedText !== text) {
                        logger.warn('检测到重复字符，已清理:', `原始: "${text}" -> 清理后: "${cleanedText}"`);
                    }

                    // 使用清理后的文本
                    text = cleanedText;

                    logger.info('识别到文本:', text);
                    // 保存字幕和对应的时间范围
                    const subtitle = {
                        text,
                        startTime: state.segmentStartTime,
                        endTime: segmentEndTime
                    };
                    state.subtitleQueue.push(subtitle);
                    logger.debug('字幕已加入队列:', subtitle);

                    // 兼容旧的缓存方式
                    saveSubtitleToCache({ text, timestamp: Date.now() });
                } else {
                    logger.warn('后端返回空文本，可能存在时间戳问题');
                }
            }

        } catch (error) {
            logger.error('处理实时音频失败:', error);
        } finally {
            // 清空累积缓冲区
            state.audioAccumulator = [];
            state.accumulatorSize = 0;
            state.segmentStartTime = null;
            state.isProcessing = false;
            logger.debug('音频处理完成，缓冲区已清空');
        }

        // 更新最后处理时间
        state.lastProcessedTime = Date.now();
    }

    // 发送音频到后端
    async function sendToBackend(audioBlob) {
        logger.debug('发送音频到后端');

        try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'audio.wav');
            formData.append('language', 'zh');
            formData.append('subtask', 'transcribe');

            const response = await fetch(CONFIG.API_ENDPOINT, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP错误! 状态: ${response.status}, 详情: ${errorText}`);
            }

            const result = await response.json();

            // 检查响应中的时间戳问题
            if (result.chunks) {
                for (const chunkId in result.chunks) {
                    const chunk = result.chunks[chunkId];
                    if (chunk.timestamp) {
                        // 检查时间戳是否为null
                        if (chunk.timestamp[1] === null) {
                            logger.warn('检测到null时间戳，可能导致处理延迟:', chunk);
                        }
                    }
                }
            }

            return result;

        } catch (error) {
            logger.error('发送到后端失败:', error);
            throw error;
        }
    }

    // 保存字幕到缓存
    function saveSubtitleToCache(text) {
        const currentTime = state.videoElement.currentTime;
        const cacheKey = Math.floor(currentTime / 5) * 5; // 每5秒一个缓存键

        state.subtitleCache.set(cacheKey, text);
        logger.debug('字幕已缓存，键:', cacheKey, '文本:', text);

        // 清理过期缓存
        const now = Date.now();
        for (const [key, cacheItem] of state.subtitleCache.entries()) {
            if (now - cacheItem.timestamp > CONFIG.CACHE_DURATION) {
                state.subtitleCache.delete(key);
            }
        }
    }

    // 显示字幕
    function showSubtitle(text) {
        if (!state.subtitleElement) {
            logger.error('没有字幕元素，无法显示字幕');
            return;
        }

        // 清除之前的隐藏定时器
        if (state.subtitleHideTimeout) {
            clearTimeout(state.subtitleHideTimeout);
            state.subtitleHideTimeout = null;
        }

        // 如果是相同的字幕，不重置显示时间
        if (state.lastSubtitleText === text) {
            state.isSameSubtitle = true;
            logger.debug('相同字幕，保持显示');
            return;
        }

        // 新字幕，更新显示内容
        state.lastSubtitleText = text;
        state.isSameSubtitle = false;
        state.subtitleElement.textContent = text;
        state.subtitleElement.style.opacity = '1';
        state.containerElement.style.opacity = '1';
        state.lastSubtitleTime = Date.now();

        // 设置字幕显示时间：文本越长，显示时间越长
        const baseTime = state.subtitleBaseDuration;
        const textLength = text.length;
        const extraTime = textLength * state.subtitleCharDuration;
        const displayTime = Math.min(baseTime + extraTime, 15000); // 最多显示15秒

        logger.debug(`字幕显示时间: ${displayTime}ms (文本长度: ${textLength})`);

        // 设置自动隐藏定时器
        state.subtitleHideTimeout = setTimeout(() => {
            hideSubtitle();
        }, displayTime);
    }

    // 隐藏字幕
    function hideSubtitle() {
        if (state.subtitleElement && state.subtitleElement.style.opacity !== '0') {
            state.subtitleElement.style.opacity = '0';
            state.containerElement.style.opacity = '0';

            // 清除隐藏定时器
            if (state.subtitleHideTimeout) {
                clearTimeout(state.subtitleHideTimeout);
                state.subtitleHideTimeout = null;
            }

            // 清理状态
            state.lastSubtitleText = '';
            state.isSameSubtitle = false;

            logger.debug('隐藏字幕');
        }
    }

    // 启动字幕显示检查器
    function startSubtitleDisplayChecker() {
        if (state.displayCheckInterval) {
            logger.debug('字幕显示检查器已在运行');
            return;
        }

        logger.info('启动字幕显示检查器');
        state.displayCheckInterval = setInterval(() => {
            if (!state.videoElement || !state.isPlaying) {
                hideSubtitle();
                return;
            }

            const currentTime = state.videoElement.currentTime;
            // 计算延迟后的时间：累积时长(3秒) + 估计处理时间(1秒) = 4秒
            // 乘以延迟倍数，实现用户可调节的同步效果
            const baseDelay = CONFIG.ACCUMULATE_DURATION + 1; // 4秒基础延迟
            const delayedTime = currentTime - (baseDelay * state.delayMultiplier);

            // 找到延迟后时间应该显示的字幕
            const currentSubtitle = state.subtitleQueue.find(sub =>
                delayedTime >= sub.startTime && delayedTime <= sub.endTime
            );

            if (currentSubtitle) {
                // 只有在新字幕或当前字幕已隐藏时才调用showSubtitle
                if (!state.isSameSubtitle || state.subtitleElement.style.opacity === '0') {
                    showSubtitle(currentSubtitle.text);
                }
            } else {
                // 如果没有匹配的字幕且当前有字幕显示，则隐藏
                if (state.subtitleElement && state.subtitleElement.style.opacity !== '0') {
                    hideSubtitle();
                }
            }

            // 清理过期的字幕（保留最近20秒的字幕）
            state.subtitleQueue = state.subtitleQueue.filter(sub =>
                sub.endTime > currentTime - 20
            );

        }, 100); // 每100ms检查一次
    }

    // 停止字幕显示检查器
    function stopSubtitleDisplayChecker() {
        if (state.displayCheckInterval) {
            clearInterval(state.displayCheckInterval);
            state.displayCheckInterval = null;
            logger.info('字幕显示检查器已停止');
        }
    }

    // 初始化音频捕获
    async function initAudioCapture() {
        if (!state.videoElement) {
            logger.error('没有视频元素，无法初始化音频捕获');
            return;
        }

        logger.info('初始化实时音频捕获');

        try {
            logger.debug('开始初始化音频捕获');

            // 获取视频流（不影响原音频播放）
            const videoStream = state.videoElement.captureStream ?
                state.videoElement.captureStream() :
                state.videoElement.mozCaptureStream();

            if (!videoStream) {
                throw new Error('无法获取视频流');
            }

            logger.debug('视频流获取成功');

            // 提取音频轨道
            const audioTracks = videoStream.getAudioTracks();
            logger.debug('音频轨道数量:', audioTracks.length);
            if (audioTracks.length > 0) {
                logger.debug('音频轨道状态 - enabled:', audioTracks[0].enabled, 'muted:', audioTracks[0].muted);
            }

            if (audioTracks.length === 0) {
                throw new Error('视频流中没有音频轨道');
            }

            // 创建音频流
            const audioStream = new MediaStream(audioTracks);

            // 创建 AudioContext，设置采样率为 16kHz
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: CONFIG.SAMPLE_RATE
            });

            logger.debug('AudioContext 创建成功，状态:', state.audioContext.state);

            // 等待 AudioContext 就绪
            if (state.audioContext.state === 'suspended') {
                await state.audioContext.resume();
                logger.debug('AudioContext 已恢复');
            }

            // 从音频流创建源（不干扰原视频音频）
            state.sourceNode = state.audioContext.createMediaStreamSource(audioStream);
            logger.debug('MediaStreamSource 创建成功');

            // 创建 ScriptProcessor
            state.scriptProcessor = state.audioContext.createScriptProcessor(
                CONFIG.BUFFER_SIZE,  // 输入缓冲区大小
                1,                  // 输入通道数 (单声道)
                1                   // 输出通道数
            );

            logger.debug('ScriptProcessor 创建成功，缓冲区大小:', CONFIG.BUFFER_SIZE);

            // 提前设置 isRecording，确保 onaudioprocess 可以处理数据
            state.isRecording = true;
            logger.debug('isRecording 已设置为 true');

            // 处理实时音频
            state.scriptProcessor.onaudioprocess = (e) => {
                if (!state.isRecording) {
                    logger.debug('onaudioprocess 触发但 isRecording=false，跳过');
                    return;
                }

                const audioData = e.inputBuffer.getChannelData(0); // Float32Array
                logger.debug('🎵 onaudioprocess 触发，音频样本数:', audioData.length);
                accumulateAudioData(audioData);
            };

            // 连接音频节点
            // ScriptProcessor 必须连接到某个输出才会触发 onaudioprocess
            // 我们使用一个增益为 0 的 GainNode 来避免实际输出音频
            const silentGain = state.audioContext.createGain();
            silentGain.gain.value = 0; // 静音输出

            state.sourceNode.connect(state.scriptProcessor);
            state.scriptProcessor.connect(silentGain);
            silentGain.connect(state.audioContext.destination);

            logger.debug('音频节点连接完成: sourceNode -> scriptProcessor -> silentGain -> destination');

            logger.info('实时音频捕获已启动，等待音频数据...');

        } catch (error) {
            logger.error('初始化实时音频捕获失败:', error);
            logger.error('错误堆栈:', error.stack);
        }
    }

    // 停止音频捕获
    function stopAudioCapture() {
        state.isRecording = false;

        // 处理剩余的队列数据
        if (state.audioQueue.length > 0) {
            logger.info(`停止捕获时，队列中还有 ${state.audioQueue.length} 个音频段待处理`);

            // 处理剩余的音频数据
            while (state.audioQueue.length > 0) {
                setTimeout(() => {
                    processQueuedAudio();
                }, 0);
            }
        }

        // 处理当前累积的音频数据
        if (state.audioAccumulator.length > 0) {
            logger.info('停止捕获时，还有未处理的累积音频，加入队列');
            queueAudioForProcessing();
        }

        // 清理超时定时器
        if (state.processingTimeout) {
            clearTimeout(state.processingTimeout);
            state.processingTimeout = null;
        }

        if (state.scriptProcessor) {
            state.scriptProcessor.disconnect();
            state.scriptProcessor = null;
        }

        if (state.sourceNode) {
            state.sourceNode.disconnect();
            state.sourceNode = null;
        }

        if (state.audioContext) {
            state.audioContext.close();
            state.audioContext = null;
        }

        // 清空累积缓冲区
        state.audioAccumulator = [];
        state.accumulatorSize = 0;

        logger.info('实时音频捕获已停止');
    }

    // 视频播放事件处理
    function handleVideoPlay() {
        logger.info('视频开始播放，启动字幕生成');
        state.isPlaying = true;

        // 初始化音频捕获
        initAudioCapture();

        // 启动字幕显示检查器
        startSubtitleDisplayChecker();
    }

    // 视频暂停事件处理
    function handleVideoPause() {
        logger.info('视频暂停，停止字幕生成');
        state.isPlaying = false;

        // 停止音频捕获
        stopAudioCapture();

        // 停止字幕显示检查器
        stopSubtitleDisplayChecker();

        // 隐藏字幕
        hideSubtitle();
    }

    // 初始化字幕系统
    function initSubtitleSystem() {
        logger.info('初始化字幕系统');

        // 创建字幕容器
        const { container, subtitle } = createSubtitleContainer();
        state.containerElement = container;
        state.subtitleElement = subtitle;

        // 获取视频元素
        state.videoElement = getCurrentVideo();
        if (!state.videoElement) {
            logger.error('未找到视频元素');
            return;
        }

        // 添加视频事件监听
        state.videoElement.addEventListener('play', handleVideoPlay);
        state.videoElement.addEventListener('pause', handleVideoPause);

        // 检查视频是否已经在播放
        if (!state.videoElement.paused && !state.videoElement.ended) {
            logger.info('视频已在播放中，直接启动字幕生成');
            handleVideoPlay();
        }

        logger.info('字幕系统初始化完成');
    }

    // 清理资源
    function cleanup() {
        logger.info('清理资源');

        // 停止字幕显示检查器
        stopSubtitleDisplayChecker();

        // 停止音频捕获
        stopAudioCapture();

        // 清空音频队列和累积器
        state.audioQueue = [];
        state.audioAccumulator = [];
        state.accumulatorSize = 0;
        state.segmentStartTime = null;

        // 清空字幕队列
        state.subtitleQueue = [];

        // 清理超时定时器
        if (state.processingTimeout) {
            clearTimeout(state.processingTimeout);
            state.processingTimeout = null;
        }

        // 清理字幕隐藏定时器
        if (state.subtitleHideTimeout) {
            clearTimeout(state.subtitleHideTimeout);
            state.subtitleHideTimeout = null;
        }

        // 重置字幕状态
        state.lastSubtitleText = '';
        state.isSameSubtitle = false;
        state.lastSubtitleTime = 0;

        // 移除视频事件监听
        if (state.videoElement) {
            state.videoElement.removeEventListener('play', handleVideoPlay);
            state.videoElement.removeEventListener('pause', handleVideoPause);
        }

        logger.info('资源清理完成');
    }

    // 创建字幕显示时间调节面板
    function createSubtitleDurationPanel() {
        // 检查是否已存在
        if (document.getElementById('subtitle-duration-panel')) {
            return document.getElementById('subtitle-duration-panel');
        }

        const panel = document.createElement('div');
        panel.id = 'subtitle-duration-panel';
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 99999;
            background: rgba(255, 255, 255, 0.95);
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
            min-width: 250px;
            backdrop-filter: blur(10px);
            transition: all 0.3s ease;
        `;

        const title = document.createElement('div');
        title.textContent = '字幕显示时间设置';
        title.style.cssText = `
            font-size: 16px;
            font-weight: bold;
            color: #333;
            margin-bottom: 15px;
            text-align: center;
            border-bottom: 1px solid #eee;
            padding-bottom: 10px;
        `;

        // 基础显示时间调节
        const baseDurationContainer = document.createElement('div');
        baseDurationContainer.style.cssText = `
            margin-bottom: 15px;
        `;

        const baseDurationLabel = document.createElement('div');
        baseDurationLabel.textContent = '基础显示时间';
        baseDurationLabel.style.cssText = `
            font-size: 13px;
            color: #555;
            margin-bottom: 5px;
        `;

        const baseDurationValue = document.createElement('div');
        baseDurationValue.id = 'base-duration-value';
        baseDurationValue.textContent = `${state.subtitleBaseDuration / 1000} 秒`;
        baseDurationValue.style.cssText = `
            font-size: 11px;
            color: #777;
            margin-bottom: 8px;
            text-align: right;
        `;

        const baseDurationSlider = document.createElement('input');
        baseDurationSlider.type = 'range';
        baseDurationSlider.id = 'base-duration-slider';
        baseDurationSlider.min = '2000';
        baseDurationSlider.max = '10000';
        baseDurationSlider.step = '500';
        baseDurationSlider.value = state.subtitleBaseDuration;
        baseDurationSlider.style.cssText = `
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #ddd;
            outline: none;
            cursor: pointer;
        `;

        // 每个字符额外时间调节
        const charDurationContainer = document.createElement('div');
        charDurationContainer.style.cssText = `
            margin-bottom: 15px;
        `;

        const charDurationLabel = document.createElement('div');
        charDurationLabel.textContent = '字符额外时间';
        charDurationLabel.style.cssText = `
            font-size: 13px;
            color: #555;
            margin-bottom: 5px;
        `;

        const charDurationValue = document.createElement('div');
        charDurationValue.id = 'char-duration-value';
        charDurationValue.textContent = `${state.subtitleCharDuration} 毫秒/字符`;
        charDurationValue.style.cssText = `
            font-size: 11px;
            color: #777;
            margin-bottom: 8px;
            text-align: right;
        `;

        const charDurationSlider = document.createElement('input');
        charDurationSlider.type = 'range';
        charDurationSlider.id = 'char-duration-slider';
        charDurationSlider.min = '100';
        charDurationSlider.max = '1000';
        charDurationSlider.step = '50';
        charDurationSlider.value = state.subtitleCharDuration;
        charDurationSlider.style.cssText = `
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #ddd;
            outline: none;
            cursor: pointer;
        `;

        // 预览区域
        const previewContainer = document.createElement('div');
        previewContainer.style.cssText = `
            margin-top: 15px;
            padding: 12px;
            background: rgba(0, 0, 0, 0.05);
            border-radius: 8px;
        `;

        const previewLabel = document.createElement('div');
        previewLabel.textContent = '示例预览';
        previewLabel.style.cssText = `
            font-size: 12px;
            color: #666;
            margin-bottom: 8px;
        `;

        const previewText = document.createElement('div');
        previewText.textContent = '这是字幕文本示例';
        previewText.style.cssText = `
            font-size: 14px;
            color: #333;
            text-align: center;
        `;

        const previewDuration = document.createElement('div');
        previewDuration.id = 'preview-duration';
        previewDuration.style.cssText = `
            font-size: 11px;
            color: #999;
            text-align: center;
            margin-top: 5px;
        `;

        // 更新预览
        function updatePreview() {
            const text = '这是字幕文本示例';
            const displayTime = Math.min(
                state.subtitleBaseDuration + text.length * state.subtitleCharDuration,
                15000
            );
            previewDuration.textContent = `预计显示时间: ${(displayTime / 1000).toFixed(1)}秒`;
        }

        // 事件监听器
        baseDurationSlider.addEventListener('input', (e) => {
            state.subtitleBaseDuration = parseInt(e.target.value);
            baseDurationValue.textContent = `${state.subtitleBaseDuration / 1000} 秒`;
            updatePreview();
        });

        charDurationSlider.addEventListener('input', (e) => {
            state.subtitleCharDuration = parseInt(e.target.value);
            charDurationValue.textContent = `${state.subtitleCharDuration} 毫秒/字符`;
            updatePreview();
        });

        // 组装面板
        baseDurationContainer.appendChild(baseDurationLabel);
        baseDurationContainer.appendChild(baseDurationValue);
        baseDurationContainer.appendChild(baseDurationSlider);

        charDurationContainer.appendChild(charDurationLabel);
        charDurationContainer.appendChild(charDurationValue);
        charDurationContainer.appendChild(charDurationSlider);

        previewContainer.appendChild(previewLabel);
        previewContainer.appendChild(previewText);
        previewContainer.appendChild(previewDuration);

        panel.appendChild(title);
        panel.appendChild(baseDurationContainer);
        panel.appendChild(charDurationContainer);
        panel.appendChild(previewContainer);

        document.body.appendChild(panel);

        // 初始化预览
        updatePreview();

        return panel;
    }

    // 创建控制按钮
    function createControlButton() {
        const button = document.createElement('button');
        button.textContent = '开启字幕';
        button.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 99999;
            padding: 12px 24px;
            font-size: 16px;
            font-weight: bold;
            background: #1890ff;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.3s ease;
        `;

        const settingsButton = document.createElement('button');
        settingsButton.textContent = '⚙️';
        settingsButton.style.cssText = `
            position: fixed;
            top: 20px;
            right: 160px;
            z-index: 99999;
            padding: 8px 12px;
            font-size: 18px;
            background: rgba(255, 255, 255, 0.9);
            border: 1px solid #ddd;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
            color: #666;
        `;

        let isEnabled = false;
        let settingsPanel = null;
        let settingsVisible = false;

        // 设置按钮点击事件
        settingsButton.addEventListener('click', () => {
            settingsVisible = !settingsVisible;

            if (settingsVisible) {
                if (!settingsPanel) {
                    settingsPanel = createSubtitleDurationPanel();
                }
                settingsPanel.style.display = 'block';
                settingsButton.style.background = 'rgba(255, 255, 255, 0.95)';
                settingsButton.style.borderColor = '#1890ff';
                settingsButton.style.color = '#1890ff';
            } else {
                if (settingsPanel) {
                    settingsPanel.style.display = 'none';
                }
                settingsButton.style.background = 'rgba(255, 255, 255, 0.9)';
                settingsButton.style.borderColor = '#ddd';
                settingsButton.style.color = '#666';
            }
        });

        // 主按钮点击事件
        button.addEventListener('click', () => {
            isEnabled = !isEnabled;

            if (isEnabled) {
                button.textContent = '关闭字幕';
                button.style.background = '#ff4d4f';
                initSubtitleSystem();

                // 显示设置面板
                if (!settingsPanel) {
                    settingsPanel = createSubtitleDurationPanel();
                }
                settingsPanel.style.display = 'block';
                settingsVisible = true;

                // 更新设置按钮状态
                settingsButton.style.background = 'rgba(255, 255, 255, 0.95)';
                settingsButton.style.borderColor = '#1890ff';
                settingsButton.style.color = '#1890ff';
            } else {
                button.textContent = '开启字幕';
                button.style.background = '#1890ff';
                cleanup();

                // 隐藏字幕
                if (state.subtitleElement) {
                    state.subtitleElement.textContent = '';
                    state.subtitleElement.style.opacity = '0';
                }

                if (state.containerElement) {
                    state.containerElement.style.opacity = '0';
                }

                // 隐藏设置面板
                if (settingsPanel) {
                    settingsPanel.style.display = 'none';
                }
                settingsVisible = false;

                // 重置设置按钮状态
                settingsButton.style.background = 'rgba(255, 255, 255, 0.9)';
                settingsButton.style.borderColor = '#ddd';
                settingsButton.style.color = '#666';

                // 重置延迟倍数
                state.delayMultiplier = 1;
            }
        });

        document.body.appendChild(settingsButton);
        document.body.appendChild(button);
    }

    // 页面加载完成后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlButton);
    } else {
        createControlButton();
    }

})();
