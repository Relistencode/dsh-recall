# dsh-recall

🌏 [English](README.md) · 中文

> **AI 再也不会"忘记"你说的话了。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 原生插件:给 agent 一座**记忆迷宫**——为你们的每一段对话筑起走廊与房间。它记得你们之间发生过的一切:一个决定、一条设定、一次讨论、一句随口提的需求。你问"我们上次说到哪了",它走进迷宫,把当时的对话**原样**带回,再像聊天一样自然融进回答——你甚至察觉不到它"想了一下"。

对话历史回忆 · 三层检索(字面 / 模糊 / 语义)· 完全本地离线 · 压缩免疫

- 运行中,只在角落里安静地亮起一束扫动的光:

  ![回忆中](assets/recalling.png)

- 完成时,不留痕迹:

  ![回忆完成](assets/recall-done.png)

## 它不是什么

- ❌ **不是上下文工程** —— 不把全部历史硬塞进模型窗口
- ❌ **不是提示词工程** —— 不靠 prompt 让模型"装作记得"
- ❌ **不是 memory 文档系统** —— 不需要手动维护 MEMORY.md / 备忘录
- ✅ 是**真正的回忆能力**:按需检索对话**原始记录**——包括**已被压缩掉**的历史(压缩只是摘要,原文永远可搜)

## 三层检索

| 层 | 技术 | 解决 |
|---|---|---|
| 字面 | 官方 FTS5 全文索引 | 精确命中原词 |
| 模糊 | 自建 trigram + 字符二元组索引(零依赖) | 记不清原话、只记得片段、换字漏字 |
| 语义 | 本地 bge-small-zh 模型(int8,24MB 预置) | 换词、意译、"大概意思"也能想起来 |

每次回忆三层自动混合,按相关度排序,逐会话聚合。**全部本地运行、完全离线**,不依赖任何外部模型 API。

## 快速开始

```sh
dsh plugin --profile web add dsh-recall
```

**一条命令即可**:包自带组合补丁(bundle 层),插件与它所需的全文搜索会自动接线。重启 `dsh web` 即可。没有额外步骤:模型随包预置(完整版约 37MB),首次搜索自动建立索引,随后在后台安静完成语义预热(几分钟,对你的使用无感知)。

> 也可以在 [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub) 的插件管理页 **「附加功能」** 区块里一键安装/停用/卸载本插件。

### 可选配置

```yaml
- id: recall
  name: dsh-recall
  config:
    semantic: false   # 关闭语义层(只保留字面 + 模糊,包体更小)
    warmup: gentle    # 慢速预热,降低后台 CPU 占用(仅预热期间占用,后续使用 0 占用)
```

## 特性一览

| 能力 | 说明 |
|---|---|
| 三层混合检索 | 字面 / 模糊 / 语义自动合并,静默降级链(任一失败自动回退下层) |
| 作用域控制 | 默认仅当前会话;`workspace` / `all` 只在用户明确要求时使用 |
| 上下文窗口 | 每个命中附带前后 ±N 轮原始消息(可配,默认 3) |
| 压缩免疫 | 索引覆盖全量历史,含 shadowed(压缩遮蔽)事件 |
| 增量索引 | live 会话走 `ctx.sessions`,持久化走 `sessionPersistence`,append-only 增量 |
| 后台预热 | worker 线程嵌入(~10 条/秒),host 事件循环零阻塞 |
| 无感知 UI | 「回忆中…」光波 → 「回忆完成」一行,结果不进 UI、由 agent 自然呈现 |

## 更新记录

<details>
<summary>更新记录（点击展开）</summary>

> npm 首个发布版本为 **0.1.0**；以下 0.0.x 为开发里程碑。

- **2026-08** — v0.1.0：正式发布——**一条命令安装**（`dsh.bundle.patch` 自动接线插件行并启用全文搜索）；23.9MB 语义模型拆为可选包 `dsh-recall-models`（`--omit=optional` 即轻量版）；双语 README + 多语言 UI。
- **2026-08** — v0.0.6：语义层——本地 bge-small-zh（int8，随包预置，完全离线）跑在 worker 线程；字面/模糊/语义**三层混合检索**，覆盖率 ≥90% 门控 + 静默降级；后台预热（~10 条/秒，host 事件循环零阻塞）。
- **2026-08** — v0.0.4：模糊检索——自建 trigram + 字符二元组索引（零 npm 依赖）：只记得片段、记不清原话、换字漏字也能找到。
- **2026-08** — v0.0.2：`recall` 工具——官方 FTS5 全文检索全部历史会话（含压缩掉的历史），按会话聚合 + 上下文窗口；作用域控制（默认仅当前会话）；无感知 UI（回忆中… / 回忆完成）。

</details>

## 工作方式

```
recall 工具 (defineTool)
├─ 语义层: bge-small-zh int8 ONNX(23MB 预置)→ worker 线程 WASM 推理
│          → 512 维余弦检索,覆盖率 ≥90% 门控后才参与混合
├─ 模糊层: 自建 SQLite trigram FTS + bigram LIKE + 包含度重排(主路径)
├─ 字面层: 官方 ctx.sessionQuery(兜底)
└─ 混合: 语义 ∪ 模糊取每文档最高分 → 按会话聚合 → 标题 + 上下文窗口
```

- 数据源走官方服务(`ctx.sessions` / `ctx.sessionPersistence`),不读 .zstd 文件、不碰私有格式
- 索引与模型文件:`~/.dsh/storages/recall-index.db`、`models/`(随包)
- 语义推理在 **worker 线程**运行——WASM 放主线程会阻塞 host 事件循环(实测 ~9.6 条/秒零阻塞)

## Roadmap

**v1 · 当前** — 三层混合检索:官方 FTS5 字面 / 自建 trigram+bigram 模糊 / 本地 bge embedding 语义;覆盖率门控、后台预热、静默降级链。

**v2 · 检索控制**
- **`browse` 模式**:从命中事件沿 seq 顺读完整会话(分页),把"回忆"变成"翻阅聊天记录"
- **两阶段召回**:默认轻量粗召回(标题 + 摘要,~600 tokens),agent 选定会话后按需精读完整上下文——无用信息不进上下文
- **时间范围过滤**:按消息时间区间约束检索
- **结果聚合**:同一主题的多次提及合并为完整"事件"输出(而非零散命中)
- **压缩锚点**:订阅 `compaction/summary` 日志事件,把压缩摘要登记为可检索锚点,原文经 `shadowedSeqs` 还原

**v3 · 记忆组织**
- **主题聚类**:embedding 相似度聚类,按话题归拢呈现
- **记忆沉淀**:跨会话提炼设定/决策条目,沉淀为长期记忆
- 远期:评估主题化 / 分层压缩机制——只评估,不改 DSH 核心

## 已知边界

- 短查询(≤4 字)的语义补位较弱(bge 短文本余弦区分度有限),由模糊层 LIKE 兜底
- 语义排序对完全无字面重合的查询不完全可靠——模糊层始终是主路径,agent 最终判断
- 模型为 int8 量化,语义质量为"够用"级别;可换 fp32 模型(约 4 倍体积)追求极致

## 开发与测试

```sh
node .smoke-recall.mjs      # 单元 + 集成(mock,无需模型)—— 60+ 断言
node .smoke-semantic.mjs    # 真模型集成(需 models/ 就位)
```

覆盖:tokenizer 对拍(与 transformers.js 逐 token 一致)、索引增量、作用域、混合排序、降级、预热。

### 模块

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 工具注册、作用域解析、混合排序、会话聚合、预热调度 |
| `lib/fuzzy-index.js` | 自建 SQLite 索引(trigram FTS + bigram + 向量表),零 npm 依赖 |
| `lib/tokenizer.js` | BERT WordPiece 分词器(纯 JS,与官方实现逐 token 对拍一致) |
| `lib/semantic.js` | Embedder:worker 线程、批量嵌入、懒加载 |
| `lib/embed-worker.js` | worker 内 WASM 推理 + mask-aware mean pooling + L2 归一 |
| `lib/vendor/` | vendored onnxruntime-web(入口 0.8MB + wasm 12MB)+ tokenizer.json |
| `models/` | 合并单文件 int8 模型(23MB,发布时拆为 optional 包) |
| `lib/client.js` | 极简 ToolView(「回忆中…」/「回忆完成」,zh/en 随用户语言) |

### 发布结构

- `dsh-recall` —— 主包(代码 + vendor 运行时 + tokenizer)
- `dsh-recall-models` —— optional 依赖(23MB 模型),npm 默认安装;`--omit=optional` 即轻量版,缺失自动降级

## 参考与致谢

- 官方:`@deepseek-ai/dsh-session-query(-sqlite)`、`dsh-tools`、`dsh-session-persistence`
- 模型:BAAI/bge-small-zh-v1.5 (MIT) · onnx-community int8 导出 · onnxruntime-web (MIT)
- 生态参考:[dsh-plugin-recall](https://github.com/truelove-dreamer/dsh-plugin-recall)(一期同构的官方 FTS 检索工具)、[dsh-mneme](https://github.com/modusensus/dsh-mneme)(本地语义记忆,混合召回降级链思路)

## License

MIT
