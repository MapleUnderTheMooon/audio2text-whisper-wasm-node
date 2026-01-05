import requests

# 测试健康检查接口
def test_health():
    """测试健康检查接口"""
    url = "http://localhost:3000/health"
    
    try:
        # 发送请求
        response = requests.get(url)
        
        # 输出结果
        print(f"📡 响应状态码: {response.status_code}")
        print(f"📝 响应内容: {response.text}")
        
        if response.status_code == 200:
            print("✅ 健康检查成功!")
        else:
            print("❌ 健康检查失败!")
            
    except Exception as e:
        print(f"❌ 请求失败: {e}")

if __name__ == "__main__":
    test_health()