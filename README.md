# 共读台 · Temporary Book Reader

一个为浏览器 AI 共读设计的本地、一次性图书浏览工具。

它把无 DRM EPUB 或 GitBook-like Markdown 项目整理成干净的章节页面，让你可以直接使用 ChatGPT Chrome 插件与当前正文共同阅读。它不试图成为永久书架，也不内置另一套 AI、批注或知识管理系统。

> Import a book, expose one clean chapter to the browser, read it with your existing AI extension, then delete the session.

## 为什么做这个工具

常规 EPUB 阅读器通常会使用 iframe、分页引擎、隐藏预加载内容和常驻目录。这些机制适合还原电子书排版，却会给浏览器 AI 插件带来多余、混杂或不可访问的 DOM。

共读台采用相反的策略：

- 后端只负责解析、拆分和临时保存书籍。
- 页面只挂载当前章节的普通语义化 HTML。
- 目录仅在打开时进入 DOM，关闭后立即卸载。
- 阅读结束后删除会话，不建设永久书库。

## 功能

- 导入无 DRM、可重排的 EPUB 2/3。
- 导入 GitBook、mdBook 或普通 Markdown 文件夹。
- 解析 `.gitbook.yaml` 中的 `root`、`structure.readme` 和 `structure.summary`。
- 按 `SUMMARY.md`、`README.md` 或安全的文件夹顺序恢复章节。
- 根据 EPUB Navigation/NCX 的顶层分组识别合集，并选择本次阅读范围。
- 单章竖向滚动，支持上一章、下一章和按需目录。
- 调整字号、行距、正文宽度和明暗主题。
- 刷新页面后恢复尚未结束的临时会话。
- 结束共读时确认删除；超过 7 天的会话会在服务启动时自动清理。
- 使用 DOMPurify 清理导入内容，服务仅监听 `127.0.0.1`。
- 相对路径的 JPG/JPEG、PNG、GIF、WebP、AVIF 图片会进入会话专属 assets，并通过受控 API 提供；SVG 不支持。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/codepiano/browser-reader.git
cd browser-reader
npm install
npm run dev
```

打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)，拖入 EPUB 文件或选择一个 Markdown 目录。

生产构建：

```bash
npm run build
npm start
```

## 控制面板运行

仓库包含 `control-panel.json` 和项目自己的生命周期脚本，可供兼容的本地控制面板直接发现和管理：

```bash
./scripts/install.sh
./scripts/start.sh
./scripts/status.sh
./scripts/open-homepage.sh
./scripts/stop.sh
```

进程状态和日志写入被忽略的 `.control-panel/` 目录。

## 支持的 Markdown 结构

GitBook 项目可以使用：

```yaml
root: ./docs
structure:
  readme: README.md
  summary: SUMMARY.md
```

`SUMMARY.md` 示例：

```markdown
# Summary

- [开始](README.md)
- [第一章](chapters/01.md)
  - [第一节](chapters/01-01.md)
- [第二章](chapters/02.md)
```

如果没有配置文件或目录文件，共读台会扫描 Markdown 文件并使用稳定的路径顺序作为回退。

## 隐私与安全边界

- 图书不会上传到远程服务。
- 导入内容存放在操作系统临时目录中。
- 服务只绑定 loopback 地址，不向局域网开放。
- 原始 HTML、脚本、iframe、表单、SVG 等不会直接进入阅读页面。
- “结束共读”会删除对应会话目录；异常退出遗留内容最长保留 7 天。
- 远程 `http(s)`、`data:`、`file:`、`javascript:` 图片不会加载；普通远程链接仍可作为链接显示。

这不是 DRM 绕过工具，也不会处理受保护的 EPUB。

## 当前限制

- EPUB 字体和复杂资源尚未映射；图片仅支持列出的静态图片格式。
- 不支持固定版式、漫画、媒体型或依赖脚本的 EPUB。
- 合集识别依赖书籍自身的 Navigation/NCX 结构，结构不规范时会按整本书打开。
- 当前验证覆盖普通浏览器 DOM；不同版本的 ChatGPT Chrome 插件仍可能采用不同的页面读取策略。
- 不提供书架、批注、划线、阅读统计、账户、云同步或内置聊天。

## 项目结构

```text
src/
├── client/          # 极简共读页面和 DOM 清理
├── importers.ts     # EPUB / Markdown 导入与合集识别
├── safety.ts        # 本地路径安全
├── server.ts        # Fastify API 和临时会话生命周期
└── types.ts
test/                # 导入器、路径和服务测试
scripts/             # 构建与本地控制面板生命周期脚本
```

## 验证

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

测试覆盖路径逃逸防护、GitBook 目录解析、EPUB spine/navigation、合集拆分、API 行为和过期会话清理。

## 项目状态

这是一个聚焦单次 AI 共读流程的早期版本。当前优先级是提高 EPUB 内容转换质量和真实书籍兼容性，而不是扩展成通用电子书管理器。
