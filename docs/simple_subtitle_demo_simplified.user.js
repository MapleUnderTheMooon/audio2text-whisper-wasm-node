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
        SUBTITLE_CHAR_DURATION: 300, // 每个字符额外显示时间（毫秒）
        MAX_BUFFER_SIZE: 50 * 1024 * 1024 // 最大缓冲区大小：50MB
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
        maxQueueSize: 5, // 最大队列长度（减少到5个，防止积压）
        processingTimeout: null, // 处理超时定时器
        queueCleanupTimeout: null, // 队列清理定时器
        lastProcessTime: 0, // 上次成功处理时间
        processingFailures: 0, // 连续处理失败次数
        subtitleHideTimeout: null, // 字幕隐藏超时定时器
        lastSubtitleText: '', // 上次显示的字幕文本
        lastSubtitleTime: 0, // 上次显示字幕的时间
        isSameSubtitle: false, // 是否是相同的字幕
        notificationElement: null, // 通知元素
        notificationTimeout: null, // 通知隐藏定时器
        isEnabled: false, // 字幕功能是否启用
        isVideoPlaying: false // 视频是否正在播放
    };

    // 缓冲区管理
    const bufferManager = {
        // 检查并清理缓冲区（FIFO策略）
        checkAndCleanupBuffer() {
            const currentSize = calculateAudioDataSize(state.audioAccumulator);
            const maxSize = CONFIG.MAX_BUFFER_SIZE;

            // 如果未超过限制，无需清理
            if (currentSize <= maxSize) {
                return false;
            }

            logger.warn(`缓冲区超限: ${formatFileSize(currentSize)} > ${formatFileSize(maxSize)}，开始FIFO清理`);

            // 计算需要删除多少个音频块才能回到限制以内
            // 目标是保留75%的限制大小，给后续数据留出空间
            const targetSize = Math.floor(maxSize * 0.75);
            let accumulatedSize = 0;
            let itemsToRemove = 0;

            // 计算需要删除多少项
            for (let i = 0; i < state.audioAccumulator.length; i++) {
                const itemSize = state.audioAccumulator[i].length * 2; // Int16Array每个元素2字节
                if (accumulatedSize + itemSize > targetSize) {
                    break;
                }
                accumulatedSize += itemSize;
                itemsToRemove = i + 1;
            }

            // 执行FIFO删除
            if (itemsToRemove > 0 && itemsToRemove < state.audioAccumulator.length) {
                const removedCount = state.audioAccumulator.length - itemsToRemove;
                state.audioAccumulator = state.audioAccumulator.slice(itemsToRemove);
                state.accumulatorSize -= removedCount * (state.audioAccumulator[0]?.length || 0);

                // 如果有段开始时间，更新为第一个保留项的开始时间
                if (state.audioAccumulator.length > 0) {
                    // 估算被删除的时间段
                    const removedDuration = (removedCount * CONFIG.BUFFER_SIZE) / CONFIG.SAMPLE_RATE;
                    state.segmentStartTime = state.videoElement.currentTime - removedDuration;
                } else {
                    state.segmentStartTime = null;
                }

                logger.warn(`FIFO清理完成: 删除了 ${removedCount} 个音频块，当前大小: ${formatFileSize(calculateAudioDataSize(state.audioAccumulator))}`);
                return true;
            }

            return false;
        }
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
        },
        warn: (...args) => {
            console.warn('[WARN]', ...args);
        }
    };

    // 系统状态监控
    const systemMonitor = {
        startTime: Date.now(),
        lastCheckTime: Date.now(),
        memoryWarnings: 0,

        // 检查系统状态
        checkStatus() {
            const now = Date.now();
            const memoryUsage = performance.memory ?
                performance.memory.usedJSHeapSize / 1024 / 1024 : 0;

            // 检查缓冲区使用率
            const bufferSize = calculateAudioDataSize(state.audioAccumulator);
            const bufferUsagePercent = (bufferSize / CONFIG.MAX_BUFFER_SIZE) * 100;

            // 如果缓冲区使用超过80%，发出警告
            if (bufferUsagePercent > 80) {
                logger.warn(`⚠️ 缓冲区使用过高: ${bufferUsagePercent.toFixed(1)}% (${formatFileSize(bufferSize)})`);

                // 如果缓冲区使用超过90%，强制清理
                if (bufferUsagePercent > 90) {
                    logger.error('🚨 缓冲区严重超载，强制清理');
                    bufferManager.checkAndCleanupBuffer();
                }
            }

            // 如果内存使用超过100MB且超过1分钟没有成功处理，发出警告
            if (memoryUsage > 100 &&
                (state.lastProcessTime === 0 || now - state.lastProcessTime > 60000)) {
                this.memoryWarnings++;
                logger.warn(`⚠️ 内存使用警告: ${memoryUsage.toFixed(2)}MB, 成功处理时间: ${state.lastProcessTime ? new Date(state.lastProcessTime).toLocaleTimeString() : '无'}`);

                // 如果连续3次内存警告，强制清理
                if (this.memoryWarnings >= 3) {
                    this.forceCleanup();
                }
            }

            // 每30秒输出一次系统状态（更频繁的监控）
            if (now - this.lastCheckTime > 30000) {
                this.logStatus();
                this.lastCheckTime = now;
            }
        },

        // 记录系统状态
        logStatus() {
            const runtime = (Date.now() - this.startTime) / 1000;
            const memoryUsage = performance.memory ?
                performance.memory.usedJSHeapSize / 1024 / 1024 : 0;
            const bufferSize = calculateAudioDataSize(state.audioAccumulator);
            const maxBufferSize = CONFIG.MAX_BUFFER_SIZE;
            const bufferUsage = (bufferSize / maxBufferSize * 100).toFixed(1);

            logger.info(`📊 系统状态 - 运行时间: ${runtime.toFixed(0)}s, 内存: ${memoryUsage.toFixed(2)}MB, 队列: ${state.audioQueue.length}, 失败: ${state.processingFailures}, 缓冲区: ${formatFileSize(bufferSize)} (${bufferUsage}%)`);
        },

        // 强制清理
        forceCleanup() {
            logger.error('🚨 强制清理系统资源');

            // 隐藏用户通知
            hideUserNotification();

            // 清空音频队列
            const queueLength = state.audioQueue.length;
            state.audioQueue = [];

            // 重置状态
            state.processingFailures = 0;
            state.isProcessing = false;

            // 清理定时器
            if (state.processingTimeout) {
                clearTimeout(state.processingTimeout);
                state.processingTimeout = null;
            }

            if (state.queueCleanupTimeout) {
                clearTimeout(state.queueCleanupTimeout);
                state.queueCleanupTimeout = null;
            }

            // 清理字幕队列
            state.subtitleQueue = [];

            // 隐藏字幕
            hideSubtitle();

            logger.warn(`✅ 强制清理完成 - 清空了 ${queueLength} 个音频项`);

            // 重置警告计数
            this.memoryWarnings = 0;
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

        // 启动队列清理定时器（如果尚未启动）
        scheduleQueueCleanup();
    }

    // 调度队列清理
    function scheduleQueueCleanup() {
        // 清理已存在的定时器
        if (state.queueCleanupTimeout) {
            clearTimeout(state.queueCleanupTimeout);
        }

        // 10秒后清理队列
        state.queueCleanupTimeout = setTimeout(() => {
            cleanupStaleQueueItems();
        }, 10000);
    }

    // 清理过期的队列项
    function cleanupStaleQueueItems() {
        const now = Date.now();
        const originalLength = state.audioQueue.length;

        // 清理超过15秒未处理的音频项
        state.audioQueue = state.audioQueue.filter(item =>
            now - item.timestamp < 15000
        );

        // 如果清理了项目，记录日志
        if (state.audioQueue.length < originalLength) {
            logger.warn(`清理了 ${originalLength - state.audioQueue.length} 个过期音频项，当前队列长度: ${state.audioQueue.length}`);

            // 如果清理后队列仍然很长，可能是后端有问题，重置失败计数并强制清空
            if (state.audioQueue.length > 3) {
                logger.error('检测到严重积压，强制清空队列');
                state.audioQueue = [];
                state.processingFailures = 0;
            }
        }

        // 如果还有队列项，重新调度清理
        if (state.audioQueue.length > 0) {
            scheduleQueueCleanup();
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

        // 音频增强处理
        const enhancedData = enhanceAudio(float32Array);

        // 将增强后的 Float32 转换为 Int16 PCM
        const int16Array = floatTo16BitPCM(enhancedData);

        // 累积到缓冲区
        state.audioAccumulator.push(int16Array);
        state.accumulatorSize += int16Array.length;

        // 检查并清理缓冲区（FIFO策略）
        const currentBufferSize = calculateAudioDataSize(state.audioAccumulator);
        logger.debug(`当前缓冲区大小: ${formatFileSize(currentBufferSize)}`);

        // 如果缓冲区超过限制，进行FIFO清理
        if (currentBufferSize > CONFIG.MAX_BUFFER_SIZE) {
            bufferManager.checkAndCleanupBuffer();
        }

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

        // 设置处理超时（3秒，缩短超时时间）
        state.processingTimeout = setTimeout(() => {
            handleProcessingTimeout();
        }, 3000);

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

                    // 重置失败计数
                    state.processingFailures = 0;
                    state.lastProcessTime = Date.now();
                } else {
                    logger.warn('后端返回空文本，可能存在时间戳问题');
                    state.processingFailures++;
                }
            }

        } catch (error) {
            logger.error('处理队列音频失败:', error);
            state.processingFailures++;
        } finally {
            // 清理超时定时器
            if (state.processingTimeout) {
                clearTimeout(state.processingTimeout);
                state.processingTimeout = null;
            }

            state.isProcessing = false;
            logger.debug('音频处理完成，处理下一个队列项');

            // 检查是否需要清理队列
            checkAndHandleQueuePressure();

            // 检查系统状态
            systemMonitor.checkStatus();

            // 处理队列中的下一个音频
            processNextAudio();
        }
    }

    // 处理超时情况
    function handleProcessingTimeout() {
        logger.warn('音频处理超时');

        // 增加失败计数
        state.processingFailures++;

        // 如果连续失败3次，认为后端有问题，清空队列
        if (state.processingFailures >= 3) {
            logger.error('连续多次处理失败，清空队列以防止积压');
            const queueLength = state.audioQueue.length;
            state.audioQueue = [];
            state.processingFailures = 0;
            logger.warn(`已清空 ${queueLength} 个未处理的音频项`);
        } else {
            logger.warn(`处理失败次数: ${state.processingFailures}/3`);
        }

        state.isProcessing = false;
        processNextAudio();
    }

    // 检查并处理队列压力
    function checkAndHandleQueuePressure() {
        const now = Date.now();

        // 如果队列过长，且最近没有成功处理过
        if (state.audioQueue.length > 3 &&
            (state.lastProcessTime === 0 || now - state.lastProcessTime > 10000)) {
            logger.warn('检测到队列压力过大，清空队列');
            state.audioQueue = [];
            state.processingFailures = 0;
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

    // 创建通知容器
    function createNotificationContainer() {
        // 检查是否已经存在
        let existingNotification = document.getElementById('subtitle-notification');
        if (existingNotification) {
            return existingNotification;
        }

        // 创建新的通知容器
        const notification = document.createElement('div');
        notification.id = 'subtitle-notification';
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 1000000;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            color: white;
            opacity: 0;
            transition: opacity 0.3s ease;
            pointer-events: none;
            max-width: 300px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        `;

        document.body.appendChild(notification);
        return notification;
    }

    // 显示用户通知
    function showUserNotification(message, type = 'info') {
        // 创建或获取通知元素
        if (!state.notificationElement) {
            state.notificationElement = createNotificationContainer();
        }

        // 清除之前的定时器
        if (state.notificationTimeout) {
            clearTimeout(state.notificationTimeout);
        }

        // 设置通知样式和内容
        state.notificationElement.textContent = message;

        switch (type) {
            case 'warning':
                state.notificationElement.style.background = 'rgba(255, 152, 0, 0.95)'; // 橙色
                break;
            case 'error':
                state.notificationElement.style.background = 'rgba(244, 67, 54, 0.95)'; // 红色
                break;
            case 'success':
                state.notificationElement.style.background = 'rgba(76, 175, 80, 0.95)'; // 绿色
                break;
            case 'info':
            default:
                state.notificationElement.style.background = 'rgba(33, 150, 243, 0.95)'; // 蓝色
                break;
        }

        // 显示通知
        state.notificationElement.style.opacity = '1';

        // 3秒后自动隐藏
        state.notificationTimeout = setTimeout(() => {
            hideUserNotification();
        }, 3000);
    }

    // 隐藏用户通知
    function hideUserNotification() {
        if (state.notificationElement && state.notificationElement.style.opacity !== '0') {
            state.notificationElement.style.opacity = '0';

            if (state.notificationTimeout) {
                clearTimeout(state.notificationTimeout);
                state.notificationTimeout = null;
            }
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
            // 检查视频是否存在和播放状态
            if (!state.videoElement) {
                hideSubtitle();
                showUserNotification('未检测到视频元素', 'warning');
                return;
            }

            // 如果视频暂停，隐藏字幕并显示提示
            if (state.videoElement.paused || state.videoElement.ended) {
                if (state.isPlaying) {
                    hideSubtitle();
                    showUserNotification('视频已暂停，字幕功能已暂停', 'info');
                    state.isPlaying = false;
                }
                return;
            }

            // 如果视频在播放但状态未更新，更新状态
            if (!state.isPlaying) {
                state.isPlaying = true;
                logger.info('检测到视频播放，恢复字幕功能');
                hideUserNotification();
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

    // 计算音频数据内存占用（字节）
    function calculateAudioDataSize(audioData) {
        // audioData 是 Int16Array 的数组
        let totalSize = 0;
        for (const array of audioData) {
            // Int16Array 每个元素占2字节
            totalSize += array.length * 2;
        }
        return totalSize;
    }

    // 格式化字节大小为可读字符串
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // ========== 音频增强辅助 ==========

    // 预加重滤波（增强高频，提升语音清晰度）
    function preEmphasis(audioData, alpha = 0.97) {
        const emphasized = new Float32Array(audioData.length);
        emphasized[0] = audioData[0]; // 第一个样本保持不变

        for (let i = 1; i < audioData.length; i++) {
            emphasized[i] = audioData[i] - alpha * audioData[i - 1];
        }

        // 计算高频增益
        const highFreqEnergy = emphasized.slice(emphasized.length / 2)
            .reduce((sum, val) => sum + val * val, 0);
        const originalEnergy = audioData.slice(audioData.length / 2)
            .reduce((sum, val) => sum + val * val, 0);

        const highFreqGain = originalEnergy > 0 ? highFreqEnergy / originalEnergy : 1;

        console.log(`🌊 预加重滤波: 高频增益 ${highFreqGain.toFixed(2)} (α=${alpha})`);

        return emphasized;
    }

    // 计算音频的 RMS 值
    function calculateRMS(audioData) {
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        return Math.sqrt(sum / audioData.length);
    }

    // 音量标准化
    function normalizeAudio(audioData) {
        const currentRMS = calculateRMS(audioData);
        // 目标 RMS 为 0.1（约 -20dB）
        const targetRMS = 0.1;

        // 计算增益，限制在合理范围内
        let gain = targetRMS / currentRMS;
        gain = Math.max(0.5, Math.min(3.0, gain)); // 限制增益在 0.5-3.0 之间

        // 应用增益
        const normalized = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            normalized[i] = audioData[i] * gain;
        }

        // 检查削波
        const peak = Math.max(...normalized.map(Math.abs));
        if (peak > 0.95) {
            // 防止削波，降低增益
            const safeGain = 0.95 / peak;
            for (let i = 0; i < normalized.length; i++) {
                normalized[i] *= safeGain;
            }
        }

        console.log(`🔊 音量标准化: ${currentRMS.toFixed(4)} → ${calculateRMS(normalized).toFixed(4)} (增益: ${gain.toFixed(2)})`);

        return normalized;
    }

    // 简单的带通滤波器
    function bandPassFilter(audioData) {
        const sampleRate = CONFIG.SAMPLE_RATE;
        const lowCut = 80;    // 低频截止
        const highCut = 3800; // 高频截止

        // 归一化频率
        const low = 2 * Math.PI * lowCut / sampleRate;
        const high = 2 * Math.PI * highCut / sampleRate;

        // 简单的 IIR 滤波实现
        const filtered = new Float32Array(audioData.length);

        // 低通部分
        let y1_lp = 0, y2_lp = 0;
        const alpha1 = Math.exp(-high);
        for (let i = 0; i < audioData.length; i++) {
            y1_lp = alpha1 * y1_lp + (1 - alpha1) * audioData[i];
            y2_lp = alpha1 * y2_lp + (1 - alpha1) * y1_lp;
            filtered[i] = y2_lp;
        }

        // 高通部分
        let y1_hp = 0, y2_hp = 0;
        const alpha2 = Math.exp(-low);
        for (let i = 0; i < audioData.length; i++) {
            y1_hp = alpha2 * y1_hp + (1 - alpha2) * filtered[i];
            y2_hp = alpha2 * y2_hp + (1 - alpha2) * y1_hp;
            filtered[i] = filtered[i] - y2_hp;
        }

        console.log(`🎚️  带通滤波: ${lowCut}Hz-${highCut}Hz`);

        return filtered;
    }

    // 音频增强处理
    function enhanceAudio(audioData) {
        // 1. 预加重滤波（增强高频）
        let enhanced = preEmphasis(audioData);

        // 2. 音量标准化
        enhanced = normalizeAudio(enhanced);

        // 3. 带通滤波
        enhanced = bandPassFilter(enhanced);

        // 4. 计算最终指标
        const finalRMS = calculateRMS(enhanced);
        const peak = Math.max(...enhanced.map(Math.abs));

        console.log(`✅ 音频增强完成`);
        console.log(`   - RMS: ${finalRMS.toFixed(4)} (${(20 * Math.log10(finalRMS)).toFixed(1)}dB)`);
        console.log(`   - 峰值: ${(peak * 100).toFixed(1)}%`);

        return enhanced;
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
    function stopAudioCapture(isVideoPaused = false) {
        state.isRecording = false;

        // 如果是视频暂停导致的停止，直接清空所有数据，不处理剩余项
        if (isVideoPaused) {
            logger.info('视频暂停，清空所有音频数据');

            // 清空音频队列
            if (state.audioQueue.length > 0) {
                logger.debug(`视频暂停，丢弃 ${state.audioQueue.length} 个队列中的音频段`);
                state.audioQueue = [];
            }

            // 清空累积缓冲区
            if (state.audioAccumulator.length > 0) {
                logger.debug('视频暂停，清空累积的音频数据');
                state.audioAccumulator = [];
                state.accumulatorSize = 0;
                state.segmentStartTime = null;
            }
        } else {
            // 正常停止时的处理（如关闭页面）
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
        state.isVideoPlaying = true;

        // 如果字幕已启用，启动字幕系统
        if (state.isEnabled) {
            // 初始化音频捕获
            initAudioCapture();

            // 启动字幕显示检查器
            startSubtitleDisplayChecker();

            // 更新按钮状态
            updateButtonText();
        }
    }

    // 视频暂停事件处理
    function handleVideoPause() {
        logger.info('视频暂停，停止字幕生成');
        state.isPlaying = false;
        state.isVideoPlaying = false;

        // 停止音频捕获（视频暂停时不处理剩余数据）
        stopAudioCapture(true);

        // 停止字幕显示检查器
        stopSubtitleDisplayChecker();

        // 隐藏字幕
        hideSubtitle();

        // 如果字幕已启用，更新按钮状态并显示提示
        if (state.isEnabled) {
            updateButtonText();
            showUserNotification('视频已暂停，字幕功能已暂停', 'info');
        }
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
        } else {
            logger.info('视频当前暂停，等待用户播放视频');
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

        // 隐藏用户通知
        hideUserNotification();

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

        // 清理队列清理定时器
        if (state.queueCleanupTimeout) {
            clearTimeout(state.queueCleanupTimeout);
            state.queueCleanupTimeout = null;
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

    // 更新按钮文本
    function updateButtonText() {
        const button = document.getElementById('subtitle-control-button');
        if (!button) return;

        if (!state.isEnabled) {
            button.textContent = '开启字幕';
            button.style.background = '#1890ff';
        } else {
            if (state.isVideoPlaying) {
                button.textContent = '关闭字幕';
                button.style.background = '#ff4d4f';
            } else {
                button.textContent = '视频暂停';
                button.style.background = '#faad14'; // 黄色表示暂停状态
            }
        }
    }

    // 创建控制按钮
    function createControlButton() {
        const button = document.createElement('button');
        button.id = 'subtitle-control-button';
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
            state.isEnabled = !state.isEnabled;

            if (state.isEnabled) {
                updateButtonText();
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
                updateButtonText();
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

        // 添加视频状态监听，实时更新按钮
        const checkVideoState = () => {
            if (state.videoElement && state.isEnabled) {
                const isCurrentlyPlaying = !state.videoElement.paused && !state.videoElement.ended;
                if (isCurrentlyPlaying !== state.isVideoPlaying) {
                    state.isVideoPlaying = isCurrentlyPlaying;
                    updateButtonText();
                }
            }
        };

        // 每500ms检查一次视频状态
        setInterval(checkVideoState, 500);

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
