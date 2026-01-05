import requests
import os

# 测试转录接口
def test_transcribe():
    """测试转录接口"""
    url = "http://localhost:3000/api/transcribe"
    
    # 检查测试文件是否存在
    test_file = "test.wav"
    if not os.path.exists(test_file):
        print(f"❌ 测试文件不存在: {test_file}")
        return
    
    print(f"🧪 测试转录接口: {url}")
    print(f"📁 使用测试文件: {test_file}")
    
    # 准备请求数据
    files = {
        'audio': open(test_file, 'rb')
    }
    
    data = {
        'model': 'tiny',
        'language': 'zh'
    }
    
    try:
        # 发送请求
        response = requests.post(url, files=files, data=data)
        
        # 输出结果
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 测试成功!")
        else:
            print("❌ 测试失败!")
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")
    finally:
        # 关闭文件
        files['audio'].close()

if __name__ == "__main__":
    test_transcribe()