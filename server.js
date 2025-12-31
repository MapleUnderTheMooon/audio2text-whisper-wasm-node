import express from 'express';
import cors from 'cors';
import multer from 'multer';
import morgan from 'morgan';
import helmet from 'helmet';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 导入 whisper 功能
import { audioToText, batchAudioToText, getSupportedModels, getSupportedLanguages, cleanup } from './whisper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 创建 uploads 目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer 用于文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // 生成唯一文件名
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB 限制
    },
    fileFilter: (req, file, cb) => {
        // 检查文件类型
        const allowedTypes = ['audio/', 'video/'];
        const allowedExtensions = ['.wav', '.mp3', '.mp4', '.m4a', '.flac', '.ogg', '.webm'];
        
        const ext = path.extname(file.originalname).toLowerCase();
        const isAllowed = allowedTypes.some(type => file.mimetype.startsWith(type)) ||
                         allowedExtensions.includes(ext);
        
        if (isAllowed) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型: ${file.mimetype}`), false);
        }
    }
});

// 中间件配置
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态文件服务
app.use('/uploads', express.static(uploadsDir));
app.use('/api/download', express.static(uploadsDir));

// API 路由

// 健康检查
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

// 获取支持的模型列表
app.get('/api/models', (req, res) => {
    try {
        const models = getSupportedModels();
        res.json({
            success: true,
            data: models
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 获取支持的语言列表
app.get('/api/languages', (req, res) => {
    try {
        const languages = getSupportedLanguages();
        res.json({
            success: true,
            data: languages
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 单个音频文件转文本
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        console.log('\n🎤 接收到音频转文本请求');
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: '请上传音频文件'
            });
        }

        const audioPath = req.file.path;
        const options = {
            model: req.body.model || 'Xenova/whisper-tiny',
            language: req.body.language || 'zh',
            quantized: req.body.quantized === 'true',
            subtask: req.body.subtask || 'transcribe'
        };

        console.log('📁 上传的文件:', req.file.originalname);
        console.log('🎯 使用模型:', options.model);
        console.log('🌍 语言设置:', options.language);

        // 记录开始时间
        const startTime = Date.now();

        // 执行转录
        const result = await audioToText(audioPath, {
            ...options,
            progress_callback: (data) => {
                if (data.status === 'initiate') {
                    console.log(`📥 正在下载: ${data.file}`);
                } else if (data.status === 'progress') {
                    console.log(`⏳ 下载进度: ${data.file} - ${data.progress.toFixed(1)}%`);
                } else if (data.status === 'done') {
                    console.log(`✅ 下载完成: ${data.file}`);
                }
            }
        });

        // 计算处理时间
        const processingTime = Date.now() - startTime;

        // 构建响应
        const response = {
            success: true,
            data: {
                ...result,
                processingTime,
                fileInfo: {
                    originalName: req.file.originalname,
                    size: req.file.size,
                    mimetype: req.file.mimetype,
                    path: req.file.path
                }
            }
        };

        console.log(`✅ 转录完成，耗时: ${(processingTime / 1000).toFixed(2)}s`);
        console.log(`📝 识别结果: ${result.text.substring(0, 100)}${result.text.length > 100 ? '...' : ''}`);

        res.json(response);

    } catch (error) {
        console.error('❌ 转录错误:', error);
        
        // 清理上传的文件
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            error: error.message,
            details: error.stack
        });
    }
});

// 批量音频转文本
app.post('/api/batch-transcribe', upload.array('audio', 10), async (req, res) => {
    try {
        console.log('\n📂 接收到批量转文本请求');
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: '请上传至少一个音频文件'
            });
        }

        const audioPaths = req.files.map(file => file.path);
        const options = {
            model: req.body.model || 'Xenova/whisper-tiny',
            language: req.body.language || 'zh',
            quantized: req.body.quantized === 'true',
            subtask: req.body.subtask || 'transcribe'
        };

        console.log(`📁 上传了 ${req.files.length} 个文件`);
        console.log('🎯 使用模型:', options.model);

        // 记录开始时间
        const startTime = Date.now();

        // 执行批量转录
        const results = await batchAudioToText(audioPaths, options);

        // 计算处理时间
        const processingTime = Date.now() - startTime;

        // 构建响应
        const response = {
            success: true,
            data: {
                results,
                summary: {
                    total: req.files.length,
                    successful: results.filter(r => r.success).length,
                    failed: results.filter(r => !r.success).length,
                    processingTime
                },
                fileInfo: req.files.map(file => ({
                    originalName: file.originalname,
                    size: file.size,
                    mimetype: file.mimetype,
                    path: file.path
                }))
            }
        };

        console.log(`✅ 批量转录完成，耗时: ${(processingTime / 1000).toFixed(2)}s`);
        console.log(`📊 成功: ${response.data.summary.successful}, 失败: ${response.data.summary.failed}`);

        res.json(response);

    } catch (error) {
        console.error('❌ 批量转录错误:', error);
        
        // 清理上传的文件
        if (req.files) {
            req.files.forEach(file => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
        }

        res.status(500).json({
            success: false,
            error: error.message,
            details: error.stack
        });
    }
});

// 本地文件转文本
app.post('/api/transcribe-file', async (req, res) => {
    try {
        const { filePath, options = {} } = req.body;

        if (!filePath) {
            return res.status(400).json({
                success: false,
                error: '请提供文件路径'
            });
        }

        // 转换为绝对路径
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);

        if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({
                success: false,
                error: `文件不存在: ${absolutePath}`
            });
        }

        console.log('\n📁 处理本地文件:', absolutePath);

        const startTime = Date.now();
        const result = await audioToText(absolutePath, options);
        const processingTime = Date.now() - startTime;

        const response = {
            success: true,
            data: {
                ...result,
                processingTime,
                filePath: absolutePath
            }
        };

        console.log(`✅ 本地文件转录完成，耗时: ${(processingTime / 1000).toFixed(2)}s`);
        res.json(response);

    } catch (error) {
        console.error('❌ 本地文件转录错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 清理模型资源
app.post('/api/cleanup', async (req, res) => {
    try {
        await cleanup();
        res.json({
            success: true,
            message: '模型资源已清理'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 错误处理中间件
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                error: '文件大小超过限制（最大 50MB）'
            });
        }
    }
    
    console.error('❌ 服务器错误:', error);
    res.status(500).json({
        success: false,
        error: error.message
    });
});

// 404 处理
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: '接口不存在',
        availableEndpoints: [
            'GET /health',
            'GET /api/models',
            'GET /api/languages',
            'POST /api/transcribe',
            'POST /api/batch-transcribe',
            'POST /api/transcribe-file',
            'POST /api/cleanup'
        ]
    });
});

// 创建 HTTP 服务器
const server = app.listen(PORT, () => {
    console.log('\n🚀 Whisper WASM 服务器启动成功!');
    console.log('=' .repeat(50));
    console.log(`📍 服务器地址: http://localhost:${PORT}`);
    console.log(`🔗 健康检查: http://localhost:${PORT}/health`);
    console.log(`📋 API 文档: http://localhost:${PORT}/api/models`);
    console.log('=' .repeat(50));
    console.log('\n📡 可用的 API 端点:');
    console.log('  GET  /health                    - 健康检查');
    console.log('  GET  /api/models                - 获取支持的模型列表');
    console.log('  GET  /api/languages             - 获取支持的语言列表');
    console.log('  POST /api/transcribe            - 单个音频转文本');
    console.log('  POST /api/batch-transcribe      - 批量音频转文本');
    console.log('  POST /api/transcribe-file       - 本地文件转文本');
    console.log('  POST /api/cleanup               - 清理模型资源');
    console.log('\n💡 使用示例:');
    console.log('  curl -X POST http://localhost:3000/api/transcribe \\');
    console.log('    -F "audio=@your-audio.wav" \\');
    console.log('    -F "model=Xenova/whisper-tiny" \\');
    console.log('    -F "language=zh"\n');
});

// WebSocket 服务器（为实时语音识别预留）
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('🔌 WebSocket 客户端已连接');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            } else if (data.type === 'transcribe') {
                // 实时转录功能（待实现）
                ws.send(JSON.stringify({
                    type: 'transcription',
                    status: 'processing',
                    message: '实时转录功能即将推出'
                }));
            }
        } catch (error) {
            console.error('❌ WebSocket 消息解析错误:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket 客户端已断开');
    });
});

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n🛑 正在关闭服务器...');
    
    server.close(() => {
        console.log('✅ HTTP 服务器已关闭');
    });
    
    // 清理模型资源
    await cleanup();
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 收到终止信号，正在关闭服务器...');
    server.close();
    await cleanup();
    process.exit(0);
});

export default app;