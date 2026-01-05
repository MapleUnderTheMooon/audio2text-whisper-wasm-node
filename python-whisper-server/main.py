from fastapi import FastAPI, UploadFile, File, Form, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
import whisper
import os
import time
from typing import List, Dict, Any, Optional
import tempfile
import numpy as np
import ffmpeg

# 重写 Whisper 的 load_audio 函数，使用纯 Python 处理 WAV 文件
def custom_load_audio(file: str, sr: int = 16000):
    """使用纯 Python 处理 WAV 文件，避免依赖外部 FFmpeg 命令"""
    print(f"🔧 使用自定义 load_audio 函数处理文件: {file}")
    
    try:
        # 检查文件扩展名
        ext = os.path.splitext(file)[1].lower()
        
        if ext == '.wav':
            print(f"📦 直接处理 WAV 文件")
            
            # 使用 wave 模块直接读取 WAV 文件
            import wave
            
            with wave.open(file, 'rb') as wf:
                # 获取音频信息
                channels = wf.getnchannels()
                sample_width = wf.getsampwidth()
                original_sr = wf.getframerate()
                n_frames = wf.getnframes()
                
                print(f"   WAV 信息: 声道={channels}, 位深={sample_width*8}bit, 采样率={original_sr}, 帧数={n_frames}")
                
                # 读取音频数据
                data = wf.readframes(n_frames)
                
                # 转换为 numpy 数组
                if sample_width == 2:
                    # 16位 PCM
                    audio = np.frombuffer(data, np.int16)
                elif sample_width == 4:
                    # 32位 PCM
                    audio = np.frombuffer(data, np.int32)
                else:
                    # 8位 PCM
                    audio = np.frombuffer(data, np.uint8)
                    audio = audio.astype(np.float32) - 128  # 转换为 [-1, 1] 范围
                
                # 转换为单声道
                if channels > 1:
                    print(f"   转换为单声道")
                    audio = audio.reshape(-1, channels).mean(axis=1)
                
                # 归一化到 [-1, 1] 范围
                if sample_width == 2:
                    audio = audio.astype(np.float32) / 32768.0
                elif sample_width == 4:
                    audio = audio.astype(np.float32) / 2147483648.0
                
                # 重采样（如果需要）
                if original_sr != sr:
                    print(f"   重采样: {original_sr}Hz → {sr}Hz")
                    # 使用简单的线性插值重采样
                    from scipy import signal
                    audio = signal.resample(audio, int(len(audio) * sr / original_sr))
                
                print(f"✅ WAV 处理成功，样本数量: {len(audio)}")
                return audio
        else:
            # 对于其他格式，使用 wave 模块抛出明确的错误
            print(f"❌ 仅支持 WAV 格式，不支持 {ext} 格式")
            raise RuntimeError(f"Only WAV format is supported, got {ext}")
    except wave.Error as e:
        print(f"❌ WAV 文件处理失败: {e}")
        raise RuntimeError(f"Failed to load WAV audio: {e}") from e
    except Exception as e:
        print(f"❌ 音频处理异常: {e}")
        import traceback
        traceback.print_exc()
        raise

# 替换 Whisper 库的默认 load_audio 函数
whisper.audio.load_audio = custom_load_audio
print("✅ 已替换 Whisper 的 load_audio 函数，使用纯 Python 处理 WAV 音频")

# 创建 FastAPI 应用
app = FastAPI(
    title="Whisper Python API",
    version="2.0.0",
    description="基于 Whisper 的语音识别 API，支持 GPU 加速"
)

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 在生产环境中应该设置具体的源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 模型缓存，避免重复加载
model_cache = {}

# 支持的模型列表
SUPPORTED_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large"
]

# 支持的语言列表
SUPPORTED_LANGUAGES = [
    "zh", "en", "ja", "ko", "fr", "de", "es", "ru", "it", "pt",
    "nl", "pl", "tr", "ar", "hi", "id", "ms", "th", "vi", "fil"
]

# 加载模型的辅助函数
def load_model(model_name: str):
    """加载模型，如果已在缓存中则直接返回"""
    if model_name in model_cache:
        print(f"📦 从缓存加载模型: {model_name}")
        return model_cache[model_name]
    
    print(f"📥 正在加载模型: {model_name}")
    start_time = time.time()
    
    # 加载模型，自动使用GPU（如果可用）
    model = whisper.load_model(model_name)
    
    load_time = time.time() - start_time
    print(f"✅ 模型加载完成，耗时: {load_time:.2f}s")
    
    # 存入缓存
    model_cache[model_name] = model
    return model

# 音频转文本核心函数
def transcribe_audio(file_path: str, options: Dict[str, Any]):
    """音频转文本核心处理"""
    start_time = time.time()
    
    # 处理模型名称
    model_name = options.get("model", "tiny")
    
    # 如果是完整模型名称（如 Xenova/whisper-tiny），提取简写
    if "/" in model_name:
        model_name = model_name.split("-")[-1]
    
    # 确保模型名称有效
    if model_name not in SUPPORTED_MODELS:
        raise ValueError(f"不支持的模型: {model_name}，支持的模型有: {SUPPORTED_MODELS}")
    
    # 加载模型
    model = load_model(model_name)
    
    # 设置转录选项
    transcribe_options = {
        "language": options.get("language", "zh"),
        "task": options.get("subtask", "transcribe"),
        "verbose": False
    }
    
    print(f"🎤 正在转录音频，使用模型: {model_name}")
    print(f"🌍 语言: {transcribe_options['language']}")
    print(f"📋 任务: {transcribe_options['task']}")
    
    # 执行转录
    result = model.transcribe(file_path, **transcribe_options)
    
    processing_time = time.time() - start_time
    print(f"✅ 转录完成，耗时: {processing_time:.2f}s")
    
    return result, processing_time

# 处理音频文件，Whisper模型会自动处理格式，所以简化处理
def process_audio_file(file_path: str) -> str:
    """处理音频文件，Whisper模型会自动处理格式"""
    print(f"🔧 正在处理音频文件: {file_path}")
    print(f"✅ 直接返回原始文件路径，Whisper模型会自动处理音频格式")
    # 只返回原始文件路径，让Whisper模型自动处理
    return file_path

# 健康检查接口
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptime": time.time() - app.startup_time if hasattr(app, 'startup_time') else 0,
        "version": "2.0.0"
    }

# 应用启动事件
@app.on_event("startup")
async def startup_event():
    app.startup_time = time.time()
    print("🚀 Whisper Python 服务器启动成功!")
    print("=" * 50)
    print(f"📍 服务器地址: http://localhost:3000")
    print(f"🔗 健康检查: http://localhost:3000/health")
    print(f"📋 API 文档: http://localhost:3000/docs")
    print("=" * 50)
    print("\n📡 可用的 API 端点:")
    print("  GET  /health                    - 健康检查")
    print("  GET  /api/models                - 获取支持的模型列表")
    print("  GET  /api/languages             - 获取支持的语言列表")
    print("  POST /api/transcribe            - 单个音频转文本")
    print("  POST /api/batch-transcribe      - 批量音频转文本")
    print("  POST /api/transcribe-file       - 本地文件转文本")
    print("  POST /api/cleanup               - 清理模型资源")
    print("\n💡 使用示例:")
    print("  curl -X POST http://localhost:3000/api/transcribe \\")
    print("    -F \"audio=@your-audio.wav\" \\")
    print("    -F \"model=whisper-tiny\" \\")
    print("    -F \"language=zh\"")
    print("")

# 错误处理
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": str(exc),
            "details": str(exc)
        }
    )

# 获取支持的模型列表
@app.get("/api/models")
async def get_models():
    try:
        return {
            "success": True,
            "data": SUPPORTED_MODELS
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e)
            }
        )

# 获取支持的语言列表
@app.get("/api/languages")
async def get_languages():
    try:
        return {
            "success": True,
            "data": SUPPORTED_LANGUAGES
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e)
            }
        )

# 清理模型资源
@app.post("/api/cleanup")
async def cleanup_models():
    try:
        # 清空模型缓存
        global model_cache
        model_cache.clear()
        print("🗑️  模型资源已清理")
        return {
            "success": True,
            "message": "模型资源已清理"
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e)
            }
        )

# 单个音频文件转文本
@app.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form("tiny"),
    language: str = Form("zh"),
    quantized: str = Form("false"),
    subtask: str = Form("transcribe")
):
    temp_files = []  # 用于跟踪临时文件，确保清理
    
    try:
        print("\n🎤 接收到音频转文本请求")
        
        # 保存上传的文件到临时位置
        print(f"📁 使用临时目录: {tempfile.gettempdir()}")
        
        # 创建临时文件，使用更可靠的方式
        temp_input = tempfile.NamedTemporaryFile(suffix=os.path.splitext(audio.filename)[1], delete=False)
        input_path = temp_input.name
        temp_input.close()
        temp_files.append(input_path)
        
        # 确保路径格式在Windows上正确
        input_path = os.path.abspath(input_path)
        print(f"📝 临时文件路径: {input_path}")
        
        # 写入文件内容
        with open(input_path, "wb") as f:
            content = await audio.read()
            f.write(content)
            print(f"💾 写入内容大小: {len(content) / 1024 / 1024:.2f} MB")
        
        # 验证文件是否成功创建
        if not os.path.exists(input_path):
            raise ValueError(f"❌ 临时文件创建失败: {input_path}")
        
        print(f"📁 上传的文件: {audio.filename}")
        print(f"🎯 使用模型: {model}")
        print(f"🌍 语言设置: {language}")
        print(f"💾 临时文件大小: {os.path.getsize(input_path) / 1024 / 1024:.2f} MB")
        
        # 处理音频文件
        processed_path = process_audio_file(input_path)
        temp_files.append(processed_path)  # 添加到临时文件列表
        
        # 设置转录选项
        options = {
            "model": model,
            "language": language,
            "quantized": quantized.lower() == "true",
            "subtask": subtask
        }
        
        # 执行转录
        result, processing_time = transcribe_audio(processed_path, options)
        
        # 构建响应，处理可能不存在的duration键
        response = {
            "success": True,
            "data": {
                "text": result["text"],
                "chunks": result["segments"],
                "language": result["language"],
                "duration": result.get("duration", 0),  # 使用get方法避免KeyError
                "task": subtask,
                "model": model,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "processingTime": int(processing_time * 1000),
                "fileInfo": {
                    "originalName": audio.filename,
                    "size": os.path.getsize(input_path),
                    "mimetype": audio.content_type
                }
            }
        }
        
        print(f"✅ 转录完成，耗时: {processing_time:.2f}s")
        print(f"📝 识别结果: {result['text'][:100]}{'...' if len(result['text']) > 100 else ''}")
        
        return response
        
    except Exception as e:
        print(f"❌ 转录错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e),
                "details": traceback.format_exc()
            }
        )
    finally:
        # 清理临时文件
        for file_path in temp_files:
            try:
                if os.path.exists(file_path):
                    os.unlink(file_path)
                    print(f"🗑️  清理临时文件: {file_path}")
            except Exception as cleanup_error:
                print(f"⚠️  清理临时文件失败: {cleanup_error}")

# 批量音频转文本
@app.post("/api/batch-transcribe")
async def batch_transcribe(
    audio: List[UploadFile] = File(...),
    model: str = Form("tiny"),
    language: str = Form("zh"),
    quantized: str = Form("false"),
    subtask: str = Form("transcribe")
):
    try:
        print(f"\n📂 接收到批量转文本请求，共 {len(audio)} 个文件")
        
        if not audio:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "请上传至少一个音频文件"
                }
            )
        
        print(f"🎯 使用模型: {model}")
        print(f"🌍 语言设置: {language}")
        
        # 设置转录选项
        options = {
            "model": model,
            "language": language,
            "quantized": quantized.lower() == "true",
            "subtask": subtask
        }
        
        results = []
        total_processing_time = 0
        start_time = time.time()
        
        for i, file in enumerate(audio):
            print(f"\n--- 处理文件 {i+1}/{len(audio)}: {file.filename} ---")
            
            try:
                # 保存上传的文件到临时位置
                temp_input = tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename)[1], delete=False)
                input_path = temp_input.name
                temp_input.close()
                
                # 写入文件内容
                with open(input_path, "wb") as f:
                    f.write(await file.read())
                
                # 处理音频文件
                processed_path = process_audio_file(input_path)
                
                # 执行转录
                result, processing_time = transcribe_audio(processed_path, options)
                
                # 记录结果，处理可能不存在的duration键
                results.append({
                    "index": i,
                    "filename": file.filename,
                    "success": True,
                    "text": result["text"],
                    "duration": result.get("duration", 0),  # 使用get方法避免KeyError
                    "confidence": sum(seg.get("confidence", 0) for seg in result["segments"]) / len(result["segments"]) if result["segments"] else 0,
                    "language": result["language"],
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "processingTime": int(processing_time * 1000)
                })
                
                total_processing_time += processing_time
                
                # 清理临时文件
                os.unlink(input_path)
                os.unlink(processed_path)
                
                print(f"✅ 文件 {i+1} 处理成功")
                
            except Exception as e:
                print(f"❌ 文件 {i+1} 处理失败: {str(e)}")
                results.append({
                    "index": i,
                    "filename": file.filename,
                    "success": False,
                    "error": str(e)
                })
        
        end_time = time.time()
        total_time = end_time - start_time
        
        # 构建响应
        response = {
            "success": True,
            "data": {
                "results": results,
                "summary": {
                    "total": len(audio),
                    "successful": sum(1 for r in results if r["success"]),
                    "failed": sum(1 for r in results if not r["success"]),
                    "processingTime": int(total_time * 1000)
                },
                "fileInfo": [
                    {
                        "originalName": file.filename,
                        "size": 0,  # 由于文件已处理，无法获取准确大小
                        "mimetype": file.content_type
                    }
                    for file in audio
                ]
            }
        }
        
        print(f"\n✅ 批量转录完成，总耗时: {total_time:.2f}s")
        print(f"📊 成功: {response['data']['summary']['successful']}, 失败: {response['data']['summary']['failed']}")
        
        return response
        
    except Exception as e:
        print(f"❌ 批量转录错误: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e),
                "details": str(e)
            }
        )

# 本地文件转文本
@app.post("/api/transcribe-file")
async def transcribe_file(
    filePath: str = Body(...),
    options: Dict[str, Any] = Body(default_factory=dict)
):
    try:
        print(f"\n📁 处理本地文件: {filePath}")
        
        if not filePath:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "请提供文件路径"
                }
            )
        
        # 转换为绝对路径
        if not os.path.isabs(filePath):
            filePath = os.path.abspath(filePath)
        
        if not os.path.exists(filePath):
            return JSONResponse(
                status_code=404,
                content={
                    "success": False,
                    "error": f"文件不存在: {filePath}"
                }
            )
        
        print(f"📁 文件大小: {os.path.getsize(filePath) / 1024 / 1024:.2f} MB")
        
        # 处理音频文件
        processed_path = process_audio_file(filePath)
        
        # 设置默认选项
        default_options = {
            "model": "tiny",
            "language": "zh",
            "subtask": "transcribe"
        }
        
        # 合并选项
        merged_options = {**default_options, **options}
        
        # 执行转录
        result, processing_time = transcribe_audio(processed_path, merged_options)
        
        # 清理临时文件
        os.unlink(processed_path)
        
        # 构建响应，处理可能不存在的duration键
        response = {
            "success": True,
            "data": {
                "text": result["text"],
                "chunks": result["segments"],
                "language": result["language"],
                "duration": result.get("duration", 0),  # 使用get方法避免KeyError
                "task": merged_options["subtask"],
                "model": merged_options["model"],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "processingTime": int(processing_time * 1000),
                "filePath": filePath
            }
        }
        
        print(f"✅ 本地文件转录完成，耗时: {processing_time:.2f}s")
        print(f"📝 识别结果: {result['text'][:100]}{'...' if len(result['text']) > 100 else ''}")
        
        return response
        
    except Exception as e:
        print(f"❌ 本地文件转录错误: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e),
                "details": str(e)
            }
        )

# 404 处理
@app.api_route("{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def not_found(path: str):
    return JSONResponse(
        status_code=404,
        content={
            "success": False,
            "error": "接口不存在",
            "availableEndpoints": [
                "GET /health",
                "GET /api/models",
                "GET /api/languages",
                "POST /api/transcribe",
                "POST /api/batch-transcribe",
                "POST /api/transcribe-file",
                "POST /api/cleanup"
            ]
        }
    )

# 主函数
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=3000,
        reload=True  # 开发模式下启用自动重载
    )
