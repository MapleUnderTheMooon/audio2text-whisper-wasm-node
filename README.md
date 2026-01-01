# Whisper WASM Node.js 语音识别服务器

基于 @xenova/transformers 的 Node.js 语音识别服务器，提供 REST API 和 WebSocket 接口，支持实时音频转文本处理。

## 🎯 项目特点

- ✅ **REST API 接口**: 提供完整的 HTTP API 接口
- ✅ **WebSocket 支持**: 支持实时音频流处理
- ✅ **多语言支持**: 支持中文、英文、日文等多种语言
- ✅ **多种音频格式**: 支持 WAV, MP3, MP4, M4A, FLAC, OGG, WEBM
- ✅ **批量处理**: 支持同时处理多个音频文件
- ✅ **时间戳**: 提供准确的时间戳信息
- ✅ **翻译功能**: 支持音频内容翻译
- ✅ **文件上传**: 支持拖拽上传音频文件
- ✅ **Web 界面**: 提供简洁的 Web 操作界面

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 下载模型

在启动服务器之前，需要先下载Whisper模型：

```bash
# 下载默认模型（whisper-tiny）
node download_model.js

# 检查模型状态
npm run check-model
```

### 3. 启动服务器

```bash
# 启动开发服务器
npm run dev

# 启动生产服务器
npm start

# 快速演示
npm run quick

# 多进程模式启动（推荐，充分利用多核CPU）
npm run start:cluster
```

### 3. 访问服务

服务器启动后，您可以：

- **Web 界面**: http://localhost:3000 - 上传音频文件进行转录
- **REST API**: http://localhost:3000/api/transcribe - 直接 API 调用
- **WebSocket**: ws://localhost:3000 - 实时音频流处理

### 4. API 使用示例

#### 转录音频文件
```bash
curl -X POST -F "audio=@your-audio.wav" http://localhost:3000/api/transcribe
```

#### 获取支持的语言
```bash
curl http://localhost:3000/api/languages
```

#### 获取支持的模型
```bash
curl http://localhost:3000/api/models
```

## 📖 API 文档

### REST API 接口

#### 1. 转录音频文件

**端点**: `POST /api/transcribe`

**参数**:
- `audio` (multipart/form-data): 音频文件
- `language` (query): 语言设置 (默认: auto)
- `model` (query): 模型选择 (默认: tiny)
- `task` (query): 任务类型 (transcribe/translate)
- `return_timestamps` (query): 是否返回时间戳 (默认: true)

**示例**:
```bash
curl -X POST \
  -F "audio=@audio.wav" \
  -F "language=zh" \
  -F "task=transcribe" \
  http://localhost:3000/api/transcribe
```

**响应**:
```json
{
  "success": true,
  "text": "转录的文本内容",
  "chunks": [
    {
      "timestamp": [0.0, 5.0],
      "text": "这段话的文本内容"
    }
  ],
  "language": "zh",
  "duration": 12.5
}
```

#### 2. 批量转录

**端点**: `POST /api/batch-transcribe`

**参数**:
- `files` (multipart/form-data[]): 多个音频文件
- `language` (query): 语言设置

**示例**:
```bash
curl -X POST \
  -F "files=@audio1.wav" \
  -F "files=@audio2.mp3" \
  -F "language=auto" \
  http://localhost:3000/api/batch-transcribe
```

#### 3. 获取支持的语言

**端点**: `GET /api/languages`

**示例**:
```bash
curl http://localhost:3000/api/languages
```

#### 4. 获取支持的模型

**端点**: `GET /api/models`

**示例**:
```bash
curl http://localhost:3000/api/models
```

#### 5. 服务器状态

**端点**: `GET /api/status`

**示例**:
```bash
curl http://localhost:3000/api/status
```

### WebSocket 接口

**端点**: `ws://localhost:3000`

**消息格式**:

发送音频数据:
```javascript
{
  "type": "audio",
  "data": "base64_encoded_audio_data",
  "format": "wav"
}
```

接收转录结果:
```javascript
{
  "type": "result",
  "text": "转录的文本",
  "chunks": [...],
  "language": "zh"
}
```

### JavaScript 客户端示例

```javascript
// REST API 调用
async function transcribeAudio(file) {
    const formData = new FormData();
    formData.append('audio', file);
    formData.append('language', 'zh');
    
    const response = await fetch('http://localhost:3000/api/transcribe', {
        method: 'POST',
        body: formData
    });
    
    return await response.json();
}

// WebSocket 连接
const ws = new WebSocket('ws://localhost:3000');

ws.onopen = () => {
    console.log('WebSocket 连接已建立');
};

ws.onmessage = (event) => {
    const result = JSON.parse(event.data);
    if (result.type === 'result') {
        console.log('转录结果:', result.text);
    }
};

// 发送音频数据
function sendAudioData(audioBuffer) {
    ws.send(JSON.stringify({
        type: 'audio',
        data: btoa(String.fromCharCode(...new Uint8Array(audioBuffer))),
        format: 'wav'
    }));
}
```

## 🛠️ 技术架构

### 核心技术栈
- **Node.js**: 运行时环境
- **@xenova/transformers**: Transformers.js 库，提供 Whisper WASM 实现
- **WebAssembly (WASM)**: 底层推理引擎

### 模型选择
项目支持多种 Whisper 模型，按性能和大小排序：

| 模型 | 大小 | 速度 | 精度 | 推荐用途 |
|------|------|------|------|----------|
| tiny | ~39 MB | 最快 | 较低 | 快速原型 |
| base | ~74 MB | 快 | 中等 | 一般用途 |
| small | ~244 MB | 中等 | 较高 | **推荐** |
| medium | ~769 MB | 慢 | 高 | 精确需求 |
| large | ~1550 MB | 最慢 | 最高 | 专业用途 |

### 文件结构

```
whisper-wasm-nodejs/
├── server.js                    # Express 服务器主入口
├── whisper.js                   # 核心语音识别功能
├── index.js                     # 索引文件
├── package.json                 # 项目配置和依赖
├── package-lock.json            # 依赖锁定文件
├── quick_start.js               # 快速开始脚本
├── examples.js                  # 使用示例代码
├── download_model.js            # 模型下载工具
├── README.md                    # 项目文档
└── node_modules/                # 依赖包目录
    └── @xenova/
        └── transformers/        # Whisper 模型缓存
            └── .cache/
                └── Xenova/
                    └── whisper-tiny/
```

## 📊 性能说明

### 硬件要求
- **内存**: 建议 4GB 以上
- **存储**: 模型文件需要 39MB-1.5GB（根据选择的模型）
- **CPU**: 支持 WASM 的现代处理器

### 处理速度
- **短音频** (< 30秒): 通常几秒内完成
- **长音频**: 按音频长度线性增长，支持分块处理
- **批量处理**: 支持并发处理，但建议控制并发数量

### 准确率
- **清晰语音**: 90%+ 准确率
- **噪音环境**: 70-85% 准确率
- **多语言**: 对主流语言支持良好

## 🔧 高级配置

### 自定义模型路径
```javascript
const { env } = require('@xenova/transformers');

// 设置本地模型路径
env.localModelPath = './custom-models';
env.allowLocalModels = true;
```

### 性能优化
```javascript
const result = await audioToText('./audio.wav', {
    // 优化设置
    chunk_length_s: 30,        // 增加分块长度提高速度
    stride_length_s: 5,        // 减少重叠提高速度
    return_timestamps: false,  // 禁用时间戳提高速度
    // 精度设置
    temperature: 0,            // 降低随机性
    repetition_penalty: 5,     // 减少重复
});
```

### 错误处理
```javascript
try {
    const result = await audioToText('./audio.wav');
    console.log(result.text);
} catch (error) {
    if (error.message.includes('模型下载')) {
        console.log('模型下载失败，请检查网络连接');
    } else if (error.message.includes('音频格式')) {
        console.log('不支持的音频格式');
    } else {
        console.log('未知错误:', error.message);
    }
}
```

## 🐛 常见问题

### Q: 模型下载失败怎么办？
A: 
1. 检查网络连接
2. 使用国内镜像源：`npm config set registry https://registry.npmmirror.com`
3. 手动下载模型到 `models/` 目录

### Q: 内存不足错误？
A: 
1. 选择更小的模型（如 tiny 或 base）
2. 减少 `chunk_length_s` 参数
3. 关闭其他占用内存的程序

### Q: 处理速度很慢？
A: 
1. 选择更小的模型
2. 调整 `chunk_length_s` 和 `stride_length_s` 参数
3. 禁用 `return_timestamps`

### Q: 识别准确率低？
A: 
1. 检查音频质量，确保清晰无噪音
2. 正确设置 `language` 参数
3. 使用更大的模型（如 small, medium, large）

## 📈 使用场景

- **会议记录**: 自动生成会议纪要
- **内容创作**: 将语音笔记转换为文字
- **语言学习**: 分析发音和语调
- **无障碍服务**: 为听障用户提供字幕
- **内容审核**: 批量分析音频内容
- **实时转录**: 直播、会议实时字幕
- **语音助手**: 集成到智能客服系统
- **教育培训**: 课程录音转文字笔记

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发设置
```bash
git clone <项目地址>
npm install

# 启动开发模式
npm run dev

# 运行测试
npm test

# 运行快速演示
npm run quick
```

### 可用的 npm 脚本
- `npm start` - 启动生产服务器
- `npm run dev` - 启动开发服务器（支持热重载）
- `npm run test` - 运行测试
- `npm run quick` - 快速演示
- `npm run check-model` - 检查模型状态
- `npm run build` - 构建项目

### 代码风格
- 使用 ES6+ 模块化语法
- 添加适当的注释和日志
- 遵循 RESTful API 设计原则
- 确保向后兼容性

## 📄 许可证

MIT License

## 🙏 致谢

- [OpenAI Whisper](https://github.com/openai/whisper) - 原始模型
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) - C++ 实现
- [@xenova/transformers](https://github.com/xenova/transformers.js) - JavaScript 绑定

## 📞 支持

如有问题，请提交 [Issue](../../issues) 或联系维护者。