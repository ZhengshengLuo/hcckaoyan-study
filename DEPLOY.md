# 🚀 GitHub Pages 部署指南

## 第一步：安装 Git

你的电脑目前没有安装 Git，需要先安装：

1. 打开浏览器，访问 https://git-scm.com/downloads/win
2. 下载 **Standalone Installer** → **64-bit Git for Windows Setup**
3. 安装时一路 Next 即可（保持默认设置）
4. 安装完成后，**关闭并重新打开 PowerShell**
5. 输入 `git --version` 验证安装成功

## 第二步：创建 GitHub 仓库

1. 打开 https://github.com ，登录你的账号（没有就注册一个）
2. 点击右上角 **+** → **New repository**
3. 填写信息：
   - **Repository name**: `kaoyan-study`（或你喜欢的名字）
   - **Description**: `考研专注力与进度追踪`
   - **Public**（必须公开才能用免费的 GitHub Pages）
   - ❌ 不要勾选 "Add a README file"
4. 点击 **Create repository**

## 第三步：推送代码

安装好 Git 后，打开 PowerShell，依次执行：

```powershell
# 进入项目目录
cd "C:\Users\cspin\Desktop\考研学习"

# 配置 Git 用户信息（替换成你自己的）
git config --global user.name "你的GitHub用户名"
git config --global user.email "你的邮箱@example.com"

# 初始化仓库并推送
git init
git add .
git commit -m "🎉 初始版本：考研专注力追踪应用"
git branch -M main
git remote add origin https://github.com/你的用户名/kaoyan-study.git
git push -u origin main
```

> 第一次 push 时会弹出 GitHub 登录窗口，按提示登录即可。

## 第四步：开启 GitHub Pages

1. 在 GitHub 仓库页面，点击 **Settings**（⚙️ 齿轮图标）
2. 左侧菜单找到 **Pages**
3. **Source** 选择 **Deploy from a branch**
4. **Branch** 选择 `main`，文件夹选 `/ (root)`
5. 点击 **Save**
6. 等待 1-2 分钟，刷新页面，你会看到一个链接：

```
https://你的用户名.github.io/kaoyan-study/
```

## 第五步：在 iPad 上使用

1. 在 iPad 的 Safari 浏览器中打开上面的链接
2. 选择 **美乐蒂女孩** 身份
3. 开始学习！

> **添加到主屏幕**：在 Safari 中点击分享按钮 → "添加到主屏幕"，这样就像一个 App 一样使用了！

## 第六步：PC 端监督

1. 在 PC 浏览器中打开同一个链接
2. 选择 **库洛米守护者** 身份
3. 数据会通过 MQTT 自动实时同步

---

## 后续更新代码

每次修改代码后，执行以下命令即可更新：

```powershell
cd "C:\Users\cspin\Desktop\考研学习"
git add .
git commit -m "更新描述"
git push
```

GitHub Pages 会在 1-2 分钟内自动更新。
