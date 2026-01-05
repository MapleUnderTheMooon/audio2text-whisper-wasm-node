// ==UserScript==
// @name         简单视频字幕生成Demo
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  简单的视频字幕生成脚本，对接本地后端服务
// @author       You
// @match        https://www.douyin.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('简单视频字幕生成Demo脚本已加载');

    // 配置后端服务地址
    const API_ENDPOINT = 'http://localhost:3000/api/transcribe';
    const RECORDING_DURATION = 3000; // 录制时长：3秒（测试用）

    // 创建字幕容器（优化版）
    function createSubtitleContainer() {
        console.log('创建/复用字幕容器');
        
        // 检查是否已经存在字幕容器
        let existingContainer = document.getElementById('simple-subtitle-container');
        let existingSubtitle = document.getElementById('simple-subtitle-text');
        
        // 如果已经存在，直接返回
        if (existingContainer && existingSubtitle) {
            console.log('复用现有字幕容器');
            // 确保可见
            existingContainer.style.opacity = '1';
            existingContainer.style.zIndex = '999999';
            existingSubtitle.style.opacity = '1';
            return { container: existingContainer, subtitle: existingSubtitle };
        }
        
        // 创建新的字幕容器
        console.log('创建新字幕容器');
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
        
        console.log('字幕容器创建完成，已添加到DOM');
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

    // 录制视频音频（直接获取音频流版本）
    async function recordVideoAudio(video, duration) {
        return new Promise(async (resolve, reject) => {
            console.log('开始获取音频流，视频:', video, '时长:', duration);
            
            // 检查视频是否正在播放
            if (video.paused) {
                console.warn('视频已暂停，无法获取音频流');
                reject(new Error('视频已暂停，请先播放视频'));
                return;
            }
            
            try {
                // 1. 获取视频流（包含音频）
                const videoStream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
                if (!videoStream) {
                    console.error('无法获取视频流');
                    reject(new Error('无法获取视频流，请检查浏览器支持'));
                    return;
                }
                
                console.log('获取视频流成功:', videoStream);
                
                // 2. 从视频流中提取音频轨道
                const audioTracks = videoStream.getAudioTracks();
                if (audioTracks.length === 0) {
                    console.error('视频流中没有音频轨道');
                    reject(new Error('视频没有音频轨道'));
                    return;
                }
                
                console.log('找到音频轨道:', audioTracks.length, '个');
                
                // 3. 创建仅包含音频的流
                const audioStream = new MediaStream(audioTracks);
                
                // 4. 配置MediaRecorder
                const mediaRecorder = new MediaRecorder(audioStream, {
                    mimeType: 'audio/webm;codecs=opus' // 使用WebM格式，opus编码
                });
                
                const audioChunks = [];
                
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };
                
                mediaRecorder.onstop = () => {
                    console.log('录制停止，音频数据块数:', audioChunks.length);
                    
                    if (audioChunks.length === 0) {
                        console.error('没有录制到音频数据');
                        reject(new Error('没有录制到音频数据'));
                        return;
                    }
                    
                    // 合并音频块
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    console.log('录制完成，音频大小:', audioBlob.size);
                    resolve(audioBlob);
                };
                
                mediaRecorder.onerror = (error) => {
                    console.error('MediaRecorder错误:', error);
                    reject(new Error(`MediaRecorder错误: ${error.message}`));
                };
                
                // 5. 开始录制
                mediaRecorder.start();
                console.log('MediaRecorder开始录制');
                
                // 6. 设置录制时长
                setTimeout(() => {
                    if (mediaRecorder.state === 'recording') {
                        console.log('停止录制');
                        mediaRecorder.stop();
                    }
                }, duration);
                
                // 7. 添加超时保护
                setTimeout(() => {
                    if (mediaRecorder.state === 'recording') {
                        console.error('录制超时，强制停止');
                        mediaRecorder.stop();
                        reject(new Error('录制超时'));
                    }
                }, duration + 5000);
                
            } catch (error) {
                console.error('获取音频流出错:', error);
                reject(new Error(`获取音频流失败: ${error.message}`));
            }
        });
    }
    
    // 发送音频到后端服务
    async function sendToBackend(audioBlob) {
        try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'audio.webm');
            formData.append('language', 'zh');
            formData.append('task', 'transcribe');
            
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('发送到后端失败:', error);
            throw error;
        }
    }

    // 显示字幕（优化版）
    function showSubtitle(text, subtitleElement) {
        console.log('显示字幕:', text);
        
        // 确保subtitleElement有效
        if (!subtitleElement) {
            console.error('subtitleElement无效，无法显示字幕');
            return;
        }
        
        // 确保元素存在于DOM中
        if (!subtitleElement.parentNode) {
            console.error('字幕元素已被移除');
            return;
        }
        
        // 显示字幕
        subtitleElement.textContent = text;
        subtitleElement.style.opacity = '1';
        
        // 确保容器可见
        const container = subtitleElement.parentNode;
        container.style.opacity = '1';
        container.style.zIndex = '999999';
        
        console.log('字幕显示完成');
    }

    // 主函数
    async function main() {
        console.log('开始视频字幕生成Demo');
        
        // 创建字幕容器
        const { subtitle } = createSubtitleContainer();
        
        // 获取当前视频
        const video = getCurrentVideo();
        if (!video) {
            console.error('未找到视频元素');
            showSubtitle('未找到视频元素', subtitle);
            return;
        }
        
        console.log('找到视频元素:', video);
        showSubtitle('正在准备录制音频...', subtitle);
        
        try {
            // 录制9秒音频
            console.log('开始录制9秒音频...');
            showSubtitle('正在录制音频...', subtitle);
            
            const audioBlob = await recordVideoAudio(video, RECORDING_DURATION);
            console.log('音频录制完成，大小:', audioBlob.size);
            
            // 发送到后端
            console.log('发送音频到后端...');
            showSubtitle('正在识别字幕...', subtitle);
            
            const result = await sendToBackend(audioBlob);
            console.log('后端返回结果类型:', typeof result);
            console.log('后端返回结果详细:', JSON.stringify(result, null, 2));
            
            // 显示字幕
            if (result) {
                console.log('result存在，检查success字段');
                if (result.success) {
                    console.log('识别成功，检查text字段');
                    if (result.text) {
                        console.log('text字段存在，准备显示:', result.text);
                        // 直接显示结果
                        showSubtitle(result.text, subtitle);
                    } else if (result.data && result.data.text) {
                        console.log('data.text字段存在，准备显示:', result.data.text);
                        // 显示嵌套在data中的text
                        showSubtitle(result.data.text, subtitle);
                    } else if (result.chunks && result.chunks.length > 0) {
                        console.log('使用chunks字段显示字幕');
                        // 如果有chunks字段，拼接所有文本
                        const fullText = result.chunks.map(chunk => chunk.text).join(' ');
                        showSubtitle(fullText, subtitle);
                    } else {
                        console.log('没有可用的text或chunks字段');
                        showSubtitle('识别成功，但没有返回文本', subtitle);
                    }
                } else {
                    console.log('识别失败:', result.error || '未知错误');
                    showSubtitle(`识别失败: ${result.error || '未知错误'}`, subtitle);
                }
            } else {
                console.log('后端返回结果为空');
                showSubtitle('后端返回结果为空', subtitle);
            }
            
        } catch (error) {
            console.error('处理失败:', error);
            showSubtitle('处理失败: ' + error.message, subtitle);
        }
    }

    // 创建开始按钮
    function createStartButton() {
        const button = document.createElement('button');
        button.textContent = '生成字幕';
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
        `;
        
        button.addEventListener('click', () => {
            main();
        });
        
        document.body.appendChild(button);
    }

    // 页面加载完成后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createStartButton);
    } else {
        createStartButton();
    }

})();