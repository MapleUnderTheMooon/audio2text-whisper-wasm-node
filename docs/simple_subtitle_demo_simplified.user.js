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
        DELAY_MULTIPLIER: 1 // 延迟倍数，1表示完全抵消延迟，可调节
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
        delayMultiplier: 1 // 当前延迟倍数
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

        // 计算累积的音频时长
        const accumulatedDuration = state.accumulatorSize / CONFIG.SAMPLE_RATE;
        logger.debug(`累积进度: ${state.accumulatorSize} 样本 = ${accumulatedDuration.toFixed(2)}秒 / ${CONFIG.ACCUMULATE_DURATION}秒`);

        // 达到目标时长后发送
        if (accumulatedDuration >= CONFIG.ACCUMULATE_DURATION) {
            logger.info('✅ 达到累积时长，准备发送到后端');
            processRealTimeAudio();
        }
    }

    // 处理实时音频数据
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
                if (text) {
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

            return await response.json();

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

        state.subtitleElement.textContent = text;
        state.subtitleElement.style.opacity = '1';
        state.containerElement.style.opacity = '1';

        logger.debug('显示字幕:', text);
    }

    // 隐藏字幕
    function hideSubtitle() {
        if (state.subtitleElement && state.subtitleElement.style.opacity !== '0') {
            state.subtitleElement.style.opacity = '0';
            state.containerElement.style.opacity = '0';
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
                showSubtitle(currentSubtitle.text);
            } else {
                hideSubtitle();
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

        // 清空字幕队列
        state.subtitleQueue = [];

        // 移除视频事件监听
        if (state.videoElement) {
            state.videoElement.removeEventListener('play', handleVideoPlay);
            state.videoElement.removeEventListener('pause', handleVideoPause);
        }

        logger.info('资源清理完成');
    }

    // 创建延迟倍数调节控件
    function createDelaySlider() {
        // 检查是否已存在
        if (document.getElementById('delay-slider-container')) {
            return document.getElementById('delay-slider-container');
        }

        const container = document.createElement('div');
        container.id = 'delay-slider-container';
        container.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 99999;
            background: rgba(255, 255, 255, 0.95);
            padding: 15px 20px;
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-width: 200px;
            backdrop-filter: blur(10px);
        `;

        const label = document.createElement('div');
        label.textContent = '字幕延迟调节';
        label.style.cssText = `
            font-size: 14px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        `;

        const valueDisplay = document.createElement('div');
        valueDisplay.id = 'delay-value-display';
        valueDisplay.textContent = '当前倍数: 1.00x';
        valueDisplay.style.cssText = `
            font-size: 12px;
            color: #666;
            margin-bottom: 8px;
        `;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'delay-multiplier-slider';
        slider.min = '0.5';
        slider.max = '2.0';
        slider.step = '0.05';
        slider.value = '1.0';
        slider.style.cssText = `
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #ddd;
            outline: none;
            cursor: pointer;
        `;

        const infoText = document.createElement('div');
        infoText.textContent = '数值越小，字幕越超前';
        infoText.style.cssText = `
            font-size: 11px;
            color: #999;
            text-align: center;
            margin-top: 5px;
        `;

        slider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            state.delayMultiplier = value;
            valueDisplay.textContent = `当前倍数: ${value.toFixed(2)}x`;
            logger.debug('延迟倍数已更新:', value);
        });

        container.appendChild(label);
        container.appendChild(valueDisplay);
        container.appendChild(slider);
        container.appendChild(infoText);

        document.body.appendChild(container);

        return container;
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

        let isEnabled = false;
        let sliderContainer = null;

        button.addEventListener('click', () => {
            isEnabled = !isEnabled;

            if (isEnabled) {
                button.textContent = '关闭字幕';
                button.style.background = '#ff4d4f';
                initSubtitleSystem();
                // 显示延迟调节滑块
                sliderContainer = createDelaySlider();
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

                // 移除延迟调节滑块
                if (sliderContainer) {
                    sliderContainer.remove();
                    sliderContainer = null;
                }

                // 重置延迟倍数
                state.delayMultiplier = 1;
            }
        });

        document.body.appendChild(button);
    }

    // 页面加载完成后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlButton);
    } else {
        createControlButton();
    }

})();
