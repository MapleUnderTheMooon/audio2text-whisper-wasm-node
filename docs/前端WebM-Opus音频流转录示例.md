# 前端 WebM/Opus 音频流转录示例

## 概述

本示例展示了如何使用前端录音 API 录制 WebM/Opus 格式的音频流，并将其上传到 Whisper WASM 服务器进行转录。

## 浏览器兼容性

| 浏览器 | 支持情况 |
|--------|----------|
| Chrome | ✅ 支持 |
| Firefox | ✅ 支持 |
| Safari | ✅ 支持 |
| Edge | ✅ 支持 |

## 1. 基本 HTML 示例

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebM/Opus 音频转录示例</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }
        h1 {
            color: #333;
            text-align: center;
        }
        .controls {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin: 20px 0;
        }
        button {
            padding: 10px 20px;
            font-size: 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            background-color: #007bff;
            color: white;
            transition: background-color 0.3s;
        }
        button:hover {
            background-color: #0056b3;
        }
        button:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            margin: 20px 0;
            font-weight: bold;
        }
        .result {
            margin-top: 20px;
            padding: 15px;
            background-color: #f8f9fa;
            border-radius: 5px;
            white-space: pre-wrap;
        }
        #recordingTime {
            text-align: center;
            font-size: 18px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>WebM/Opus 音频转录示例</h1>
        
        <div class="status" id="status">准备就绪</div>
        <div id="recordingTime">00:00</div>
        
        <div class="controls">
            <button id="startBtn">开始录音</button>
            <button id="stopBtn" disabled>停止录音</button>
            <button id="uploadBtn" disabled>上传转录</button>
        </div>
        
        <div class="result">
            <h3>转录结果：</h3>
            <div id="transcriptionResult">请先录音，然后点击上传按钮</div>
        </div>
    </div>

    <script>
        // DOM 元素
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        const uploadBtn = document.getElementById('uploadBtn');
        const status = document.getElementById('status');
        const recordingTime = document.getElementById('recordingTime');
        const transcriptionResult = document.getElementById('transcriptionResult');

        // 录音相关变量
        let mediaRecorder;
        let audioChunks = [];
        let recordingStartTime;
        let timerInterval;

        // API 配置
        const API_URL = 'http://localhost:3000/api/transcribe';

        // 格式化时间
        function formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }

        // 更新录音时间
        function updateRecordingTime() {
            const now = new Date();
            const seconds = Math.floor((now - recordingStartTime) / 1000);
            recordingTime.textContent = formatTime(seconds);
        }

        // 开始录音
        async function startRecording() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                
                // 创建 MediaRecorder，指定使用 WebM/Opus 格式
                mediaRecorder = new MediaRecorder(stream, {
                    mimeType: 'audio/webm;codecs=opus'
                });

                // 记录开始时间
                recordingStartTime = new Date();
                timerInterval = setInterval(updateRecordingTime, 1000);

                // 监听数据可用事件
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };

                // 开始录音
                mediaRecorder.start();

                // 更新 UI
                startBtn.disabled = true;
                stopBtn.disabled = false;
                uploadBtn.disabled = true;
                status.textContent = '正在录音...';
                transcriptionResult.textContent = '正在录音...';

            } catch (error) {
                console.error('录音失败:', error);
                status.textContent = '录音失败，请检查麦克风权限';
            }
        }

        // 停止录音
        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }

            // 清除定时器
            clearInterval(timerInterval);

            // 停止所有音轨
            mediaRecorder.stream.getTracks().forEach(track => track.stop());

            // 更新 UI
            startBtn.disabled = false;
            stopBtn.disabled = true;
            uploadBtn.disabled = false;
            status.textContent = '录音已停止，点击上传按钮进行转录';
            transcriptionResult.textContent = '录音已停止，点击上传按钮进行转录';
        }

        // 上传并转录
        async function uploadAndTranscribe() {
            if (audioChunks.length === 0) {
                status.textContent = '没有录音数据，请先录音';
                return;
            }

            status.textContent = '正在上传并转录...';
            transcriptionResult.textContent = '正在处理...';
            uploadBtn.disabled = true;

            try {
                // 创建 Blob 对象
                const audioBlob = new Blob(audioChunks, {
                    type: 'audio/webm;codecs=opus'
                });

                // 创建 FormData
                const formData = new FormData();
                formData.append('audio', audioBlob, 'recording.webm');
                formData.append('language', 'zh'); // 指定中文
                formData.append('model', 'Xenova/whisper-tiny'); // 使用 tiny 模型

                // 发送请求
                const response = await fetch(API_URL, {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    throw new Error(`HTTP 错误! 状态: ${response.status}`);
                }

                // 解析响应
                const result = await response.json();

                if (result.success) {
                    status.textContent = '转录完成';
                    transcriptionResult.textContent = result.data.text;
                } else {
                    status.textContent = '转录失败';
                    transcriptionResult.textContent = `错误: ${result.error}`;
                }

            } catch (error) {
                console.error('转录失败:', error);
                status.textContent = '转录失败';
                transcriptionResult.textContent = `错误: ${error.message}`;
            } finally {
                uploadBtn.disabled = false;
            }
        }

        // 重置录音
        function resetRecording() {
            audioChunks = [];
            recordingTime.textContent = '00:00';
            status.textContent = '准备就绪';
            transcriptionResult.textContent = '请先录音，然后点击上传按钮';
        }

        // 事件监听
        startBtn.addEventListener('click', () => {
            resetRecording();
            startRecording();
        });

        stopBtn.addEventListener('click', stopRecording);

        uploadBtn.addEventListener('click', uploadAndTranscribe);
    </script>
</body>
</html>
```

## 2. JavaScript 示例

```javascript
/**
 * 前端 WebM/Opus 音频转录示例
 */

class AudioTranscriber {
    constructor(apiUrl = 'http://localhost:3000/api/transcribe') {
        this.apiUrl = apiUrl;
        this.mediaRecorder = null;
        this.audioChunks = [];
    }

    /**
     * 请求麦克风权限并开始录音
     */
    async startRecording() {
        try {
            // 请求麦克风权限
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // 创建 MediaRecorder，指定使用 WebM/Opus 格式
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            // 清空之前的录音数据
            this.audioChunks = [];

            // 监听数据可用事件
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            // 开始录音
            this.mediaRecorder.start();
            console.log('开始录音');

        } catch (error) {
            console.error('录音失败:', error);
            throw error;
        }
    }

    /**
     * 停止录音
     */
    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
            console.log('停止录音');
        }

        // 停止所有音轨
        if (this.mediaRecorder?.stream) {
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    }

    /**
     * 上传音频并获取转录结果
     * @param {Object} options - 转录选项
     * @returns {Promise<Object>} 转录结果
     */
    async transcribe(options = {}) {
        if (this.audioChunks.length === 0) {
            throw new Error('没有录音数据，请先录音');
        }

        try {
            // 创建 Blob 对象
            const audioBlob = new Blob(this.audioChunks, {
                type: 'audio/webm;codecs=opus'
            });

            // 创建 FormData
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            
            // 添加选项
            if (options.language) {
                formData.append('language', options.language);
            }
            if (options.model) {
                formData.append('model', options.model);
            }
            if (options.performance_mode) {
                formData.append('performance_mode', options.performance_mode);
            }

            // 发送请求
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP 错误! 状态: ${response.status}`);
            }

            // 解析并返回结果
            const result = await response.json();
            return result;

        } catch (error) {
            console.error('转录失败:', error);
            throw error;
        }
    }
}

// 使用示例
async function exampleUsage() {
    const transcriber = new AudioTranscriber();
    
    // 1. 开始录音
    await transcriber.startRecording();
    
    // 2. 录音 5 秒后停止
    setTimeout(async () => {
        transcriber.stopRecording();
        
        // 3. 上传并转录
        const result = await transcriber.transcribe({
            language: 'zh',
            performance_mode: 'balanced'
        });
        
        console.log('转录结果:', result.data.text);
    }, 5000);
}

// 调用示例函数
// exampleUsage();
```

## 3. React 组件示例

```jsx
import React, { useState, useRef } from 'react';

const AudioTranscriber = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [transcription, setTranscription] = useState('');
    const [status, setStatus] = useState('准备就绪');
    
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const timerRef = useRef(null);
    const startTimeRef = useRef(0);

    // 格式化时间
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // 开始录音
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            const mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });
            
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];
            startTimeRef.current = Date.now();
            
            // 监听数据可用事件
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };
            
            // 开始录音
            mediaRecorder.start();
            setIsRecording(true);
            setStatus('正在录音...');
            setTranscription('');
            
            // 启动计时器
            timerRef.current = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
                setRecordingTime(elapsed);
            }, 1000);
            
        } catch (error) {
            console.error('录音失败:', error);
            setStatus('录音失败，请检查麦克风权限');
        }
    };

    // 停止录音
    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            
            // 停止所有音轨
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
            
            // 清除计时器
            clearInterval(timerRef.current);
            
            setIsRecording(false);
            setStatus('录音已停止，点击上传按钮进行转录');
        }
    };

    // 上传并转录
    const uploadAndTranscribe = async () => {
        if (audioChunksRef.current.length === 0) {
            setStatus('没有录音数据，请先录音');
            return;
        }
        
        setIsUploading(true);
        setStatus('正在上传并转录...');
        setTranscription('正在处理...');
        
        try {
            // 创建 Blob 对象
            const audioBlob = new Blob(audioChunksRef.current, {
                type: 'audio/webm;codecs=opus'
            });
            
            // 创建 FormData
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            formData.append('language', 'zh');
            formData.append('model', 'Xenova/whisper-tiny');
            
            // 发送请求
            const response = await fetch('http://localhost:3000/api/transcribe', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`HTTP 错误! 状态: ${response.status}`);
            }
            
            // 解析响应
            const result = await response.json();
            
            if (result.success) {
                setStatus('转录完成');
                setTranscription(result.data.text);
            } else {
                setStatus('转录失败');
                setTranscription(`错误: ${result.error}`);
            }
            
        } catch (error) {
            console.error('转录失败:', error);
            setStatus('转录失败');
            setTranscription(`错误: ${error.message}`);
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div style={{
            maxWidth: '800px',
            margin: '0 auto',
            padding: '20px',
            fontFamily: 'Arial, sans-serif'
        }}>
            <h1>React 音频转录组件</h1>
            
            <div style={{ margin: '20px 0' }}>
                <div style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '10px' }}>
                    {formatTime(recordingTime)}
                </div>
                
                <div style={{ marginBottom: '10px', color: '#666' }}>
                    {status}
                </div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                        onClick={startRecording}
                        disabled={isRecording || isUploading}
                        style={{
                            padding: '10px 20px',
                            fontSize: '16px',
                            backgroundColor: '#007bff',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: 'pointer'
                        }}
                    >
                        开始录音
                    </button>
                    
                    <button
                        onClick={stopRecording}
                        disabled={!isRecording || isUploading}
                        style={{
                            padding: '10px 20px',
                            fontSize: '16px',
                            backgroundColor: '#dc3545',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: 'pointer'
                        }}
                    >
                        停止录音
                    </button>
                    
                    <button
                        onClick={uploadAndTranscribe}
                        disabled={isRecording || isUploading || audioChunksRef.current.length === 0}
                        style={{
                            padding: '10px 20px',
                            fontSize: '16px',
                            backgroundColor: '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: 'pointer'
                        }}
                    >
                        上传转录
                    </button>
                </div>
            </div>
            
            <div style={{
                marginTop: '20px',
                padding: '15px',
                backgroundColor: '#f8f9fa',
                borderRadius: '5px'
            }}>
                <h3>转录结果：</h3>
                <p>{transcription}</p>
            </div>
        </div>
    );
};

export default AudioTranscriber;
```

## 4. 注意事项

### 4.1 CORS 配置

如果前端和后端不在同一域名下，需要确保后端已配置 CORS 支持。当前项目已启用 CORS 中间件：

```javascript
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    credentials: true
}));
```

### 4.2 性能考虑

- 使用 `Xenova/whisper-tiny` 模型可以获得最快的转录速度
- 对于需要更高准确率的场景，可以使用 `Xenova/whisper-small` 或更大的模型
- 可以通过 `performance_mode` 参数调整性能和准确率的平衡

### 4.3 错误处理

- 确保处理各种错误情况，包括网络错误、服务器错误等
- 提供友好的错误提示给用户
- 添加重试机制，提高可靠性

## 5. API 响应格式

```json
{
    "success": true,
    "data": {
        "text": "转录的文本内容",
        "chunks": [
            {
                "text": "片段文本",
                "start": 0.0,
                "end": 5.0
            }
        ],
        "language": "zh",
        "duration": 10.5,
        "task": "transcribe",
        "model": "Xenova/whisper-tiny",
        "timestamp": "2026-01-01T12:00:00.000Z",
        "confidence": 0.95,
        "processingTime": 1234
    }
}
```

## 6. 故障排除

### 6.1 录音失败

- 检查浏览器是否支持 WebM/Opus 格式
- 确保已授予麦克风权限
- 检查浏览器控制台是否有错误信息

### 6.2 转录失败

- 检查服务器是否正在运行
- 确保 API URL 配置正确
- 检查服务器日志是否有错误信息
- 确保音频文件大小不超过服务器限制（当前为 50MB）

### 6.3 转录结果不准确

- 尝试使用更大的模型，如 `Xenova/whisper-small` 或 `Xenova/whisper-medium`
- 调整 `performance_mode` 为 `accuracy`
- 确保音频质量良好，减少背景噪音

## 7. 扩展功能

### 7.1 实时转录

当前示例是先录音后转录，您可以扩展为实时转录：

1. 将录音数据分块发送到服务器
2. 服务器返回实时转录结果
3. 前端实时更新转录文本

### 7.2 多种语言支持

可以添加语言选择功能，允许用户选择转录语言：

```javascript
<select id="languageSelect">
    <option value="zh">中文</option>
    <option value="en">英语</option>
    <option value="ja">日语</option>
    <option value="ko">韩语</option>
    <!-- 其他语言 -->
</select>
```

### 7.3 模型选择

可以添加模型选择功能，允许用户根据需求选择不同大小的模型：

```javascript
<select id="modelSelect">
    <option value="Xenova/whisper-tiny">Tiny（最快）</option>
    <option value="Xenova/whisper-small">Small（平衡）</option>
    <option value="Xenova/whisper-medium">Medium（更准确）</option>
    <option value="Xenova/whisper-large">Large（最准确）</option>
</select>
```

## 总结

本示例提供了详细的前端代码，展示了如何使用 WebM/Opus 格式进行音频录制和转录。您可以根据自己的需求进行修改和扩展，实现更复杂的功能。

如果您有任何问题或建议，欢迎提交 Issue 或 Pull Request。

---

**更新时间**：2026-01-01  
**版本**：1.0  
**作者**：Whisper WASM 团队