// ==UserScript==
// @name         实时视频字幕生成Demo
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  实时视频字幕生成脚本，支持连续捕获和音频增强
// @author       You
// @match        https://www.douyin.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('实时视频字幕生成Demo脚本已加载');

    // 配置后端服务地址
    const API_ENDPOINT = 'http://localhost:3000/api/transcribe';
    
    // 配置参数
    const CONFIG = {
        recordingChunkDuration: 1000, // 每1秒生成一个音频块
        processInterval: 5000, // 每5秒处理一次音频
        bufferSize: 30, // 保持30秒的音频缓冲区
        enableAudioEnhancement: true, // 启用音频增强
        mediaRecorderOptions: {
            mimeType: 'audio/webm;codecs=opus',
            bitsPerSecond: 128000 // 提高比特率，改善音频质量
        },
        audioContextOptions: {
            sampleRate: 44100 // 使用较高的采样率
        }
    };

    // 状态管理
    let currentState = {
        videoElement: null, // 当前视频元素
        videoId: null, // 当前视频唯一标识
        mediaRecorder: null, // 当前MediaRecorder实例
        audioContext: null, // Web Audio上下文
        sourceNode: null, // 音频源节点
        processorNode: null, // 音频处理节点
        audioStream: null, // 当前音频流
        audioBuffer: [], // 音频数据缓冲区
        processTimer: null, // 处理定时器
        isRecording: false, // 录制状态
        subtitleElement: null, // 字幕元素
        containerElement: null, // 容器元素
        mutationObserver: null, // DOM突变观察器
        subtitles: new Map(), // 字幕缓存，键为视频ID
        videoSwitchTimeout: null // 视频切换防抖定时器
    };

    // 日志工具
    const logger = {
        debug: (...args) => {
            // 启用调试日志
            console.log('[DEBUG]', ...args);
        },
        info: (...args) => {
            console.log('[INFO]', ...args);
        },
        error: (...args) => {
            console.error('[ERROR]', ...args);
        }
    };

    // 音频增强处理器
    class AudioEnhancer {
        constructor(audioContext) {
            this.audioContext = audioContext;
            this.nodes = {
                source: null,
                compressor: null,
                gain: null,
                equalizer: [],
                // 移除默认的destination连接，避免音频自动播放
            };
            this.setupAudioGraph();
        }

        setupAudioGraph() {
            // 创建压缩器 - 动态范围压缩
            this.nodes.compressor = this.audioContext.createDynamicsCompressor();
            this.nodes.compressor.threshold.value = -40; // 阈值
            this.nodes.compressor.knee.value = 30; // 膝盖宽度
            this.nodes.compressor.ratio.value = 12; // 压缩比
            this.nodes.compressor.attack.value = 0.003; // 启动时间
            this.nodes.compressor.release.value = 0.25; // 释放时间

            // 创建增益节点 - 音量控制
            this.nodes.gain = this.audioContext.createGain();
            this.nodes.gain.gain.value = 1.0;

            // 创建EQ节点 - 增强语音频率
            // 低频削减
            const lowCut = this.audioContext.createBiquadFilter();
            lowCut.type = 'highpass';
            lowCut.frequency.value = 300;
            lowCut.Q.value = 0.707;
            
            // 中频增强
            const midBoost = this.audioContext.createBiquadFilter();
            midBoost.type = 'peaking';
            midBoost.frequency.value = 1500;
            midBoost.Q.value = 1.0;
            midBoost.gain.value = 3.0;
            
            // 高频增强
            const highBoost = this.audioContext.createBiquadFilter();
            highBoost.type = 'peaking';
            highBoost.frequency.value = 3000;
            highBoost.Q.value = 1.0;
            highBoost.gain.value = 2.0;
            
            this.nodes.equalizer = [lowCut, midBoost, highBoost];
        }

        // 修改connect方法，只连接到指定的destination，不默认连接到扬声器
        connect(source, destination) {
            if (!destination) {
                throw new Error('必须提供destination参数');
            }
            
            this.nodes.source = source;
            
            // 连接音频处理链
            let current = source;
            current.connect(this.nodes.compressor);
            current = this.nodes.compressor;
            
            // 连接EQ节点
            for (const eqNode of this.nodes.equalizer) {
                current.connect(eqNode);
                current = eqNode;
            }
            
            current.connect(this.nodes.gain);
            this.nodes.gain.connect(destination); // 只连接到指定的destination
        }

        disconnect() {
            if (this.nodes.source) {
                this.nodes.source.disconnect();
            }
            if (this.nodes.gain) {
                this.nodes.gain.disconnect();
            }
        }

        createMediaStreamDestination() {
            return this.audioContext.createMediaStreamDestination();
        }
    }

    // 创建字幕容器（优化版）
    function createSubtitleContainer() {
        logger.debug('创建/复用字幕容器');
        
        // 检查是否已经存在字幕容器
        let existingContainer = document.getElementById('simple-subtitle-container');
        let existingSubtitle = document.getElementById('simple-subtitle-text');
        
        // 如果已经存在，直接返回
        if (existingContainer && existingSubtitle) {
            logger.debug('复用现有字幕容器');
            // 确保可见
            existingContainer.style.opacity = '1';
            existingContainer.style.zIndex = '999999';
            existingSubtitle.style.opacity = '1';
            return { container: existingContainer, subtitle: existingSubtitle };
        }
        
        // 创建新的字幕容器
        logger.debug('创建新字幕容器');
        const container = document.createElement('div');
        container.id = 'simple-subtitle-container';
        container.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 999999;
            max-width: 80%;
            text-align: center;
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.3s ease;
            background: transparent;
        `;
        
        const subtitle = document.createElement('div');
        subtitle.id = 'simple-subtitle-text';
        subtitle.style.cssText = `
            display: inline-block;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 30px;
            font-size: 24px;
            font-weight: bold;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
            opacity: 1;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
            line-height: 1.5;
            min-width: 100px;
            min-height: 20px;
        `;
        
        container.appendChild(subtitle);
        document.body.appendChild(container);
        
        logger.debug('字幕容器创建完成，已添加到DOM');
        return { container, subtitle };
    }

    // 获取当前视频元素
    function getCurrentVideo() {
        const videos = document.querySelectorAll('video');
        return Array.from(videos).find(video => 
            video.offsetParent !== null && 
            video.videoWidth > 0 && 
            video.videoHeight > 0
        ) || null;
    }

    // 生成视频唯一标识
    function generateVideoId(videoElement) {
        if (!videoElement) return null;
        
        // 使用视频的src或其他属性生成唯一标识
        const src = videoElement.src || '';
        const currentTime = Math.floor(videoElement.currentTime);
        const videoRect = videoElement.getBoundingClientRect();
        
        // 组合多个属性生成唯一ID
        const idString = `${src}-${currentTime}-${videoRect.width}-${videoRect.height}`;
        return btoa(idString).substring(0, 20); // 生成简短的Base64 ID
    }

    // 清理资源
    function cleanupResources() {
        logger.debug('清理资源...');
        
        // 停止视频切换防抖定时器
        if (currentState.videoSwitchTimeout) {
            clearTimeout(currentState.videoSwitchTimeout);
            currentState.videoSwitchTimeout = null;
        }
        
        // 停止录制
        if (currentState.mediaRecorder && currentState.mediaRecorder.state !== 'inactive') {
            try {
                currentState.mediaRecorder.stop();
            } catch (e) {
                logger.error('停止MediaRecorder失败:', e);
            }
        }
        
        // 关闭音频流
        if (currentState.audioStream) {
            currentState.audioStream.getTracks().forEach(track => {
                try {
                    track.stop();
                } catch (e) {
                    logger.error('停止音频轨道失败:', e);
                }
            });
        }
        
        // 关闭音频上下文
        if (currentState.audioContext) {
            try {
                currentState.audioContext.close();
            } catch (e) {
                logger.error('关闭AudioContext失败:', e);
            }
        }
        
        // 清除缓冲区
        currentState.audioBuffer = [];
        
        // 重置状态 - 保留processTimer
        currentState.mediaRecorder = null;
        currentState.audioContext = null;
        currentState.sourceNode = null;
        currentState.processorNode = null;
        currentState.audioStream = null;
        // 保留currentState.processTimer，不清除它
        currentState.isRecording = false;
        
        logger.debug('资源清理完成');
    }

    // 初始化音频捕获
    async function initAudioCapture(videoElement) {
        logger.info('=== 开始初始化音频捕获 ===');
        logger.info('视频元素:', {
            src: videoElement.src,
            readyState: videoElement.readyState,
            paused: videoElement.paused,
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight
        });
        
        // 清理旧资源
        logger.debug('清理旧资源...');
        cleanupResources();
        
        try {
            logger.debug('=== 步骤1: 获取视频流 ===');
            // 1. 获取视频流（包含音频）
            const captureMethod = videoElement.captureStream ? 'captureStream()' : videoElement.mozCaptureStream ? 'mozCaptureStream()' : 'none';
            logger.debug('使用的捕获方法:', captureMethod);
            
            const videoStream = videoElement.captureStream ? videoElement.captureStream() : videoElement.mozCaptureStream();
            if (!videoStream) {
                throw new Error('无法获取视频流，捕获方法可能不被支持');
            }
            
            logger.debug('视频流获取成功:', {
                active: videoStream.active,
                id: videoStream.id
            });
            
            logger.debug('=== 步骤2: 提取音频轨道 ===');
            // 2. 从视频流中提取音频轨道
            const audioTracks = videoStream.getAudioTracks();
            logger.debug('找到音频轨道:', audioTracks.length, '个');
            
            if (audioTracks.length === 0) {
                throw new Error('视频流中没有音频轨道');
            }
            
            logger.debug('音频轨道详情:', audioTracks.map(track => ({
                id: track.id,
                kind: track.kind,
                label: track.label,
                enabled: track.enabled,
                muted: track.muted
            })));
            
            logger.debug('=== 步骤3: 创建Web Audio上下文 ===');
            // 3. 创建Web Audio上下文
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            logger.debug('使用的AudioContext:', AudioContextClass.name);
            
            currentState.audioContext = new AudioContextClass(CONFIG.audioContextOptions);
            logger.debug('AudioContext创建成功:', {
                sampleRate: currentState.audioContext.sampleRate,
                state: currentState.audioContext.state
            });
            
            logger.debug('=== 步骤4: 创建音频源节点 ===');
            // 4. 创建音频源节点
            const audioMediaStream = new MediaStream(audioTracks);
            currentState.sourceNode = currentState.audioContext.createMediaStreamSource(audioMediaStream);
            logger.debug('音频源节点创建成功');
            
            logger.debug('=== 步骤5-7: 设置音频处理链 ===');
            // 5. 创建音频增强器
            const enhancer = new AudioEnhancer(currentState.audioContext);
            
            // 6. 创建MediaStreamDestination用于录制处理后的音频
            const enhancedStreamDest = enhancer.createMediaStreamDestination();
            
            // 7. 连接音频处理链 - 只连接处理后的音频到录制目标
            // 不将音频连接到扬声器，避免重复播放
            enhancer.connect(currentState.sourceNode, enhancedStreamDest);
            logger.debug('音频处理链设置完成');
            
            logger.debug('=== 步骤8: 获取最终音频流 ===');
            // 8. 获取增强后的音频流
            const finalAudioStream = enhancedStreamDest.stream;
            currentState.audioStream = finalAudioStream;
            
            logger.debug('最终音频流:', {
                active: finalAudioStream.active,
                tracks: finalAudioStream.getTracks().length
            });
            
            logger.debug('=== 步骤9: 配置MediaRecorder ===');
            // 9. 配置MediaRecorder进行连续录制
            currentState.mediaRecorder = new MediaRecorder(finalAudioStream, CONFIG.mediaRecorderOptions);
            
            logger.debug('MediaRecorder创建成功:', {
                mimeType: currentState.mediaRecorder.mimeType,
                state: currentState.mediaRecorder.state
            });
            
            logger.debug('=== 步骤10: 设置事件处理 ===');
            // 10. 设置数据可用事件处理
            currentState.mediaRecorder.ondataavailable = (event) => {
                logger.debug('=== MediaRecorder数据可用事件 ===');
                logger.debug('事件数据:', {
                    size: event.data.size,
                    type: event.data.type
                });
                
                if (event.data.size > 0) {
                    logger.debug('收到有效音频数据块，大小:', event.data.size, '字节');
                    currentState.audioBuffer.push(event.data);
                    logger.debug('当前音频缓冲区大小:', currentState.audioBuffer.length, '块');
                    
                    // 限制缓冲区大小
                    if (currentState.audioBuffer.length > CONFIG.bufferSize) {
                        const removedChunk = currentState.audioBuffer.shift();
                        logger.debug('缓冲区超出限制，移除最旧数据块，大小:', removedChunk.size, '字节');
                    }
                } else {
                    logger.debug('收到空音频数据块，跳过');
                }
            };
            
            currentState.mediaRecorder.onstop = () => {
                logger.info('MediaRecorder停止事件触发');
                currentState.isRecording = false;
                logger.info('录制状态更新为:', currentState.isRecording);
            };
            
            currentState.mediaRecorder.onerror = (error) => {
                logger.error('MediaRecorder错误事件:', error);
                currentState.isRecording = false;
                logger.info('录制状态更新为:', currentState.isRecording);
            };
            
            logger.debug('=== 步骤11: 开始录制 ===');
            // 11. 开始录制
            logger.debug('录制状态初始值:', currentState.isRecording);
            logger.debug('MediaRecorder状态:', currentState.mediaRecorder.state);
            
            currentState.mediaRecorder.start(CONFIG.recordingChunkDuration);
            currentState.isRecording = true;
            
            logger.info('录制状态更新为:', currentState.isRecording);
            logger.info('MediaRecorder状态更新为:', currentState.mediaRecorder.state);
            
            logger.info('MediaRecorder开始连续录制');
            logger.info('录制配置:', {
                chunkDuration: CONFIG.recordingChunkDuration,
                mimeType: currentState.mediaRecorder.mimeType,
                state: currentState.mediaRecorder.state,
                isRecording: currentState.isRecording
            });
            
            logger.info('=== 音频捕获初始化完成 ===');
            return true;
            
        } catch (error) {
            logger.error('初始化音频捕获失败:', error);
            logger.error('错误堆栈:', error.stack);
            cleanupResources();
            return false;
        }
    }
    
    // 发送音频到后端服务
    async function sendToBackend(audioBlob, videoId) {
        logger.debug('=== 进入sendToBackend函数 ===');
        logger.debug('API地址:', API_ENDPOINT);
        logger.debug('视频ID:', videoId);
        
        // 检查audioBlob的有效性
        if (!audioBlob || !(audioBlob instanceof Blob)) {
            logger.error('无效的音频Blob:', typeof audioBlob);
            throw new Error('无效的音频数据');
        }
        
        logger.debug('音频Blob:', {
            size: audioBlob.size,
            type: audioBlob.type,
            instanceOfBlob: audioBlob instanceof Blob
        });
        
        // 检查音频大小
        if (audioBlob.size === 0) {
            logger.error('音频数据大小为0，无法发送');
            throw new Error('无效的音频数据：大小为0');
        }
        
        try {
            const formData = new FormData();
            formData.append('audio', audioBlob, `audio-${videoId}.webm`);
            formData.append('language', 'zh');
            formData.append('subtask', 'transcribe');
            
            logger.debug('创建FormData成功，包含字段:', {
                audio: formData.has('audio'),
                language: formData.has('language'),
                subtask: formData.has('subtask')
            });
            
            logger.debug('=== 发起fetch请求 ===');
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                body: formData
            });
            
            logger.debug('=== fetch请求完成 ===');
            logger.debug('响应状态:', response.status, response.statusText);
            logger.debug('响应头:', Object.fromEntries(response.headers));
            
            if (!response.ok) {
                const errorText = await response.text();
                logger.error('HTTP错误详情:', errorText);
                throw new Error(`HTTP错误! 状态: ${response.status}, 详情: ${errorText}`);
            }
            
            const responseJson = await response.json();
            logger.debug('响应JSON:', JSON.stringify(responseJson, null, 2));
            
            logger.debug('=== 退出sendToBackend函数 ===');
            return responseJson;
        } catch (error) {
            logger.error('发送到后端失败:', error);
            logger.error('错误堆栈:', error.stack);
            throw error;
        }
    }

    // 处理音频数据
    async function processAudioData() {
        logger.debug('=== 进入processAudioData函数 ===');
        logger.debug('当前录制状态:', currentState.isRecording);
        logger.debug('音频缓冲区大小:', currentState.audioBuffer.length);
        
        if (currentState.audioBuffer.length === 0) {
            logger.debug('音频缓冲区为空，跳过处理');
            return;
        }
        
        if (!currentState.isRecording) {
            logger.debug('录制已停止，跳过处理');
            return;
        }
        
        // 检查是否有足够的音频数据
        if (currentState.audioBuffer.length < 3) { // 至少需要3个音频块
            logger.debug('音频数据块数不足（当前:', currentState.audioBuffer.length, '，需要:', 3, '），跳过处理');
            return;
        }
        
        // 复制当前缓冲区并清空
        const audioChunks = [...currentState.audioBuffer];
        currentState.audioBuffer = [];
        
        try {
            // 合并音频块
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            logger.debug('合并后的音频大小:', audioBlob.size, '字节');
            
            // 检查音频大小
            if (audioBlob.size < 1024) { // 至少需要1KB的音频数据
                logger.debug('音频数据太小（当前:', audioBlob.size, '字节，需要:', 1024, '字节），跳过处理');
                return;
            }
            
            // 发送到后端
            logger.info('=== 开始调用后端服务 ===');
            logger.info('调用后端API:', API_ENDPOINT);
            logger.info('视频ID:', currentState.videoId);
            logger.info('音频数据:', {
                chunks: audioChunks.length,
                size: audioBlob.size,
                type: audioBlob.type
            });
            
            const result = await sendToBackend(audioBlob, currentState.videoId);
            
            logger.info('=== 后端调用完成 ===');
            logger.debug('后端返回结果:', JSON.stringify(result, null, 2));
            
            // 处理识别结果
            if (result && result.success) {
                let text = '';
                if (result.text) {
                    text = result.text;
                } else if (result.data && result.data.text) {
                    text = result.data.text;
                } else if (result.chunks && result.chunks.length > 0) {
                    text = result.chunks.map(chunk => chunk.text).join(' ');
                }
                
                if (text) {
                    logger.info('识别到文本:', text);
                    
                    // 保存到字幕缓存
                    currentState.subtitles.set(currentState.videoId, text);
                    
                    // 显示字幕
                    updateSubtitle();
                } else {
                    logger.info('识别成功但未返回文本');
                    // 不显示空字幕
                }
            } else {
                logger.error('识别失败:', result?.error || '未知错误');
            }
            
        } catch (error) {
            logger.error('处理音频数据失败:', error);
            logger.error('错误堆栈:', error.stack);
        }
        
        logger.debug('=== 退出processAudioData函数 ===');
    }

    // 更新字幕
    function updateSubtitle() {
        if (!currentState.subtitleElement) {
            return;
        }
        
        const text = currentState.subtitles.get(currentState.videoId) || '';
        logger.debug('更新字幕，视频ID:', currentState.videoId, '文本:', text);
        
        // 确保元素存在于DOM中
        if (!currentState.subtitleElement.parentNode) {
            logger.error('字幕元素已被移除');
            return;
        }
        
        // 显示字幕
        currentState.subtitleElement.textContent = text;
        currentState.subtitleElement.style.opacity = '1';
        
        // 确保容器可见
        if (currentState.containerElement) {
            currentState.containerElement.style.opacity = '1';
            currentState.containerElement.style.zIndex = '999999';
        }
    }

    // 切换到新视频
    async function switchToVideo(newVideoElement) {
        logger.info('=== 进入switchToVideo函数 ===');
        
        if (!newVideoElement) {
            logger.error('新视频元素无效');
            return;
        }
        
        // 生成新视频ID
        const newVideoId = generateVideoId(newVideoElement);
        logger.info('新视频ID:', newVideoId);
        
        // 检查是否是同一视频
        if (currentState.videoId === newVideoId) {
            logger.info('同一视频，无需切换');
            return;
        }
        
        // 更新当前视频信息
        logger.info('更新当前视频信息...');
        currentState.videoElement = newVideoElement;
        currentState.videoId = newVideoId;
        
        // 初始化音频捕获
        logger.info('调用initAudioCapture初始化音频捕获...');
        const captureSuccess = await initAudioCapture(newVideoElement);
        if (!captureSuccess) {
            logger.error('初始化音频捕获失败，录制状态:', currentState.isRecording);
            return;
        }
        
        logger.info('初始化音频捕获成功，录制状态:', currentState.isRecording);
        
        // 更新字幕显示
        updateSubtitle();
        
        logger.info('=== 切换视频完成 ===');
    }

    // 切换到新视频（防抖版本）
    function switchToVideoDebounced(newVideoElement) {
        logger.info('=== 进入switchToVideoDebounced函数 ===');
        logger.info('新视频元素:', newVideoElement ? '有效' : '无效');
        
        // 清除之前的防抖定时器
        if (currentState.videoSwitchTimeout) {
            logger.debug('清除之前的防抖定时器');
            clearTimeout(currentState.videoSwitchTimeout);
        }
        
        // 设置新的防抖定时器，延迟500ms
        currentState.videoSwitchTimeout = setTimeout(() => {
            logger.info('=== 防抖定时器触发，调用switchToVideo ===');
            switchToVideo(newVideoElement);
        }, 500);
        
        logger.info('防抖定时器设置完成，延迟: 500 ms');
    }

    // 监控视频变化
    function monitorVideoChanges() {
        logger.info('启动视频变化监控...');
        
        // 创建DOM突变观察器
        currentState.mutationObserver = new MutationObserver((mutations) => {
            // 检查是否有视频相关的变化
            const hasVideoChange = mutations.some(mutation => {
                // 检查是否包含视频元素
                const hasVideoNode = Array.from(mutation.addedNodes).some(node => 
                    node.tagName === 'VIDEO' || (node instanceof Element && node.querySelector('video'))
                );
                
                // 检查是否移除了视频元素
                const hasVideoRemoved = Array.from(mutation.removedNodes).some(node => 
                    node.tagName === 'VIDEO' || (node instanceof Element && node.querySelector('video'))
                );
                
                return hasVideoNode || hasVideoRemoved;
            });
            
            if (hasVideoChange) {
                const newVideo = getCurrentVideo();
                if (newVideo && newVideo !== currentState.videoElement) {
                    switchToVideoDebounced(newVideo);
                }
            }
        });
        
        // 配置观察器 - 减少敏感度
        const observerConfig = {
            childList: true,
            subtree: true,
            // 只观察可能包含视频的主要容器
            // 对于抖音，主要内容通常在特定容器中
            // 可以根据实际情况调整
        };
        
        // 开始观察
        currentState.mutationObserver.observe(document.body, observerConfig);
    }

    // 主初始化函数
    async function init() {
        logger.info('初始化实时字幕系统...');
        
        // 创建字幕容器
        const { container, subtitle } = createSubtitleContainer();
        currentState.containerElement = container;
        currentState.subtitleElement = subtitle;
        
        // 获取初始视频
        const initialVideo = getCurrentVideo();
        if (initialVideo) {
            // 不使用await，因为switchToVideoDebounced返回的是定时器ID而非Promise
            switchToVideoDebounced(initialVideo);
        }
        
        // 启动视频监控
        monitorVideoChanges();
        
        // 确保定时器只启动一次
        if (!currentState.processTimer) {
            // 启动定时处理
            currentState.processTimer = setInterval(processAudioData, CONFIG.processInterval);
            logger.debug('启动音频处理定时器，间隔:', CONFIG.processInterval, 'ms');
        }
        
        // 定期检查录制状态，确保录制正常运行
        setInterval(() => {
            logger.debug('=== 录制状态定期检查 ===');
            logger.debug('当前录制状态:', currentState.isRecording);
            logger.debug('当前视频元素:', currentState.videoElement ? '存在' : '不存在');
            
            // 如果录制已停止且有视频元素，尝试重新启动
            if (currentState.isRecording === false && currentState.videoElement) {
                logger.info('录制已停止，尝试重新启动...');
                switchToVideoDebounced(currentState.videoElement);
            }
        }, 10000); // 每10秒检查一次
        
        logger.info('实时字幕系统初始化完成');
    }

    // 创建控制按钮
    function createControlButton() {
        const button = document.createElement('button');
        button.textContent = '实时字幕: 关闭';
        button.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 99999;
            padding: 12px 24px;
            font-size: 16px;
            font-weight: bold;
            background: #ff4d4f;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.3s ease;
        `;
        
        let isEnabled = false;
        
        button.addEventListener('click', () => {
            isEnabled = !isEnabled;
            
            if (isEnabled) {
                button.textContent = '实时字幕: 开启';
                button.style.background = '#1890ff';
                init(); // 初始化字幕系统
            } else {
                button.textContent = '实时字幕: 关闭';
                button.style.background = '#ff4d4f';
                
                // 清理资源
                cleanupResources();
                
                // 断开DOM观察器
                if (currentState.mutationObserver) {
                    currentState.mutationObserver.disconnect();
                    currentState.mutationObserver = null;
                }
                
                // 清空字幕
                if (currentState.subtitleElement) {
                    currentState.subtitleElement.textContent = '';
                    currentState.subtitleElement.style.opacity = '0';
                }
                
                // 隐藏容器
                if (currentState.containerElement) {
                    currentState.containerElement.style.opacity = '0';
                }
                
                logger.info('实时字幕系统已关闭');
            }
        });
        
        document.body.appendChild(button);
    }

    // 页面加载完成后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            createControlButton();
        });
    } else {
        createControlButton();
    }

})();