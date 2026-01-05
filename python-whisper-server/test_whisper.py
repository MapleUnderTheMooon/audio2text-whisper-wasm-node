import whisper
import os

print("测试Whisper库是否能正常工作...")

# 检查是否能列出可用模型
try:
    print("\n可用的Whisper模型:")
    # 这里我们只是测试模型加载功能，不实际下载大模型
    model = whisper.load_model("tiny")
    print(f"✅ 成功加载模型: tiny")
    print(f"✅ Whisper库工作正常")
except Exception as e:
    print(f"❌ Whisper库测试失败: {e}")
    print(f"❌ 错误详情: {str(e)}")

print("\n测试完成")
