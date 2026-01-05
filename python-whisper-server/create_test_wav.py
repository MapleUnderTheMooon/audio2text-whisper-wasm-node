import wave
import numpy as np

# 创建一个简单的WAV文件
def create_test_wav(filename="test.wav", duration=2, sample_rate=16000, freq=440):
    """创建一个测试用的WAV文件"""
    # 生成音频数据
    t = np.linspace(0, duration, int(sample_rate * duration), False)
    audio = np.sin(2 * np.pi * freq * t).astype(np.float32)
    
    # 归一化到16位整数范围
    audio = (audio * 32767).astype(np.int16)
    
    # 写入WAV文件
    with wave.open(filename, 'wb') as wf:
        wf.setnchannels(1)  # 单声道
        wf.setsampwidth(2)  # 16位
        wf.setframerate(sample_rate)
        wf.writeframes(audio.tobytes())
    
    print(f"✅ 测试WAV文件创建成功: {filename}")
    print(f"   时长: {duration}秒")
    print(f"   采样率: {sample_rate}Hz")
    print(f"   频率: {freq}Hz")

if __name__ == "__main__":
    create_test_wav()