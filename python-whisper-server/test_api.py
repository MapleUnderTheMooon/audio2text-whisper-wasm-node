import requests
import os
import wave
import numpy as np

# 创建一个简单的测试音频文件
def create_test_wav(file_path, duration=1, sample_rate=16000, frequency=440):
    """创建一个简单的正弦波音频文件"""
    print(f"📝 创建测试音频文件: {file_path}")
    
    # 生成正弦波数据
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    data = np.sin(2 * np.pi * frequency * t)
    
    # 转换为16位整数
    data = (data * 32767).astype(np.int16)
    
    # 写入WAV文件
    with wave.open(file_path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16位
        wf.setframerate(sample_rate)
        wf.writeframes(data.tobytes())
    
    print(f"✅ 测试音频文件创建成功，大小: {os.path.getsize(file_path)} bytes")
    return file_path

# 测试transcribe接口
def test_transcribe():
    """测试音频转文本接口"""
    print("\n🧪 测试音频转文本接口...")
    
    # 创建测试音频文件
    test_file = create_test_wav("test.wav")
    
    # API地址
    url = "http://localhost:3000/api/transcribe"
    
    # 准备请求数据
    files = {
        "audio": open(test_file, "rb")
    }
    
    data = {
        "model": "tiny",
        "language": "zh",
        "quantized": "false",
        "subtask": "transcribe"
    }
    
    print(f"🔄 发送请求到: {url}")
    print(f"📁 测试文件: {test_file}")
    
    try:
        # 发送请求
        response = requests.post(url, files=files, data=data)
        
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 测试成功!")
        else:
            print(f"❌ 测试失败，状态码: {response.status_code}")
            
    except Exception as e:
        print(f"❌ 请求错误: {e}")
    finally:
        # 关闭文件
        files["audio"].close()
        # 删除测试文件
        if os.path.exists(test_file):
            os.remove(test_file)
            print(f"🗑️ 删除测试文件: {test_file}")

if __name__ == "__main__":
    test_transcribe()
