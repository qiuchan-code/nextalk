# 纸片人

手账贴纸风的 AI 角色扮演聊天应用，给秋蟾自己用的。

捏角色、聊起天来它记得你、对话控制随手可退——仿「星野」，但只服务一个人、只住在一个网页里。

## 它是什么

纯静态单页应用，**没有后端**。浏览器直连各家大模型 API（实测 DeepSeek、智谱 GLM、MiniMax、硅基流动都支持浏览器跨域调用，Kimi 不行所以禁用了）。

功能：捏角色（头像/人设/四维性格滑块）、多会话、重说/回溯、长期记忆、事件簿、导出导入备份。

## 本地跑

```bash
npm install
npm run dev
```

打开 http://localhost:5173/ ，先在「设置」里填 API Key（推荐 DeepSeek），回「角色」页捏第一个角色。

## 部署到 GitHub Pages（手机随时能开）

1. 在 GitHub 新建一个仓库（比如 `zhipianren`），把本目录推上去：
   ```bash
   git remote add origin https://github.com/<你的用户名>/zhipianren.git
   git push -u origin main
   ```
2. 进仓库 **Settings → Pages**，Source 选 **"GitHub Actions"**。
3. 等一分钟，`Actions` 里会自动构建发布。手机浏览器打开
   `https://<你的用户名>.github.io/zhipianren/` 就能用，还能写入手机主屏像 App 一样。

> 部署后地址是固定网址，手机随时能开，和电脑开不开机无关。
> API Key 存各自浏览器 localStorage，代码里没有密钥，别人打开你的网址看到的是空白设置页。

## 关键设计

- **性格滑块真生效**：四维同时映射到 system prompt 的语气指令和采样参数（temperature / presence_penalty / 回复长度），见 `src/lib/prompt.js`
- **长期记忆**：三层记忆（关于用户的稳定事实 / 两人发生的事 / 关系亲密度），每满 8 条消息后台提炼一次，按「重要性×时间衰减」打分注入提示词，超上限自动合并旧记忆，见 `src/lib/memory.js`
- **回溯用链表指针**：消息用 `parentId` 串联，回溯/重说不会让事件簿记的位置错乱，见 `src/lib/sessions.js`
- **大量信息只发最近 14 条原文**，更早的压进记忆和事件簿，避免上下文爆炸

## 谁维护的

这个项目由秋蟾和 Claude 一起做。想改手感、加功能，改 `src/` 里的文件就行，每个文件开头都写了它是干嘛的。
