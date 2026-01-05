import requests
import os

# 测试健康检查接口
def test_health():
    """测试健康检查接口"""
    url = "http://localhost:3000/health"
    
    try:
        response = requests.get(url)
        
        print(f"\n🧪 测试健康检查接口")
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 健康检查成功!")
            return True
        else:
            print("❌ 健康检查失败!")
            return False
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return False

# 测试模型列表接口
def test_models():
    """测试模型列表接口"""
    url = "http://localhost:3000/api/models"
    
    try:
        response = requests.get(url)
        
        print(f"\n🧪 测试模型列表接口")
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 模型列表获取成功!")
            return True
        else:
            print("❌ 模型列表获取失败!")
            return False
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return False

# 测试语言列表接口
def test_languages():
    """测试语言列表接口"""
    url = "http://localhost:3000/api/languages"
    
    try:
        response = requests.get(url)
        
        print(f"\n🧪 测试语言列表接口")
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 语言列表获取成功!")
            return True
        else:
            print("❌ 语言列表获取失败!")
            return False
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return False

# 测试转录接口
def test_transcribe():
    """测试转录接口"""
    url = "http://localhost:3000/api/transcribe"
    
    # 检查测试文件是否存在
    test_file = "test.wav"
    if not os.path.exists(test_file):
        print(f"\n🧪 测试转录接口")
        print(f"❌ 测试文件不存在: {test_file}")
        return False
    
    try:
        print(f"\n🧪 测试转录接口")
        print(f"📁 使用测试文件: {test_file}")
        
        # 准备请求
        files = {'audio': open(test_file, 'rb')}
        data = {'model': 'tiny', 'language': 'zh'}
        
        response = requests.post(url, files=files, data=data)
        
        # 输出结果
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 转录成功!")
            return True
        else:
            print("❌ 转录失败!")
            return False
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return False
    finally:
        # 关闭文件
        if 'files' in locals() and 'audio' in files:
            files['audio'].close()

# 主测试函数
def main():
    """运行所有测试"""
    print("🚀 开始测试所有API端点")
    print("=" * 50)
    
    # 运行所有测试
    results = []
    results.append(test_health())
    results.append(test_models())
    results.append(test_languages())
    results.append(test_transcribe())
    
    # 统计结果
    print("\n" + "=" * 50)
    print("📊 测试结果汇总")
    print(f"✅ 成功: {results.count(True)}")
    print(f"❌ 失败: {results.count(False)}")
    print(f"📋 总测试数: {len(results)}")
    
    if all(results):
        print("🎉 所有测试通过!")
    else:
        print("💔 部分测试失败!")

if __name__ == "__main__":
    main()