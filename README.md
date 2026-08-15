# dsh-recall

> **AI 再也不会"忘记"你说的话了。**

你和 AI 之间发生过的一切——一个决定、一条设定、一次讨论、一句随口提的需求——它都记得。就像你的朋友或同事:你说过的话他放在心上;哪怕你自己记不清原话、只记得大概意思,他也能自然接上,像从未忘过一样。

## 它是什么

`dsh-recall` 是 DeepSeek Harness (DSH) 的原生插件,给 agent 装上一座**记忆迷宫**——它会在自己的脑子里,为你们每一段对话筑起迷宫:走廊是会话语义,房间是消息原文。当你问"我们上次说到哪了",它不是翻备忘录,而是走进迷宫,把那条走廊、那个房间、当时墙上的每一句话**原样**带回,再像聊天一样自然地融进回答——你甚至察觉不到它"想了一下"。

- 运行中,它只在角落里安静地亮起一束扫动的光:

  ![回忆中](assets/回忆中.png)

- 完成时,不留痕迹:

  ![回忆完成](assets/回忆完成.png)

## 它不是什么

- ❌ **不是上下文工程**——不把全部历史硬塞进模型窗口
- ❌ **不是提示词工程**——不靠 prompt 让模型"装作记得"
- ❌ **不是 memory 文档系统**——不需要你手动维护任何 MEMORY.md / 备忘录
- ✅ 是**真正的回忆能力**:按需检索对话的原始记录——包括**已经被压缩掉**的历史(压缩只是摘要,原文永远可搜)

## 三层检索,自动混合

| 层 | 技术 | 解决 |
|---|---|---|
| 字面 | 官方全文索引 (FTS5) | 精确命中原词 |
| 模糊 | 自建 trigram/词元索引(零依赖) | 记不清原话、只记得片段、换字漏字 |
| 语义 | 本地 bge 中文模型(24MB,预置) | 换词、意译、"大概意思"也能想起来 |

三层在每次回忆时自动合并,按相关度排序,逐会话聚合。**全部本地运行、完全离线**,不依赖任何外部模型 API——安装即用,零配置。

## 安装

```sh
dsh plugin --profile web add dsh-recall
```

重启 `dsh web`。没有额外步骤:模型随包预置(完整版约 37MB),首次搜索自动建立索引,随后在后台安静地完成语义预热(几分钟,对你的使用无任何感知)。

### 可选配置

在 profile 的 `cordis.patch.yml` 中:

```yaml
- id: recall
  name: dsh-recall
  config:
    semantic: false   # 关闭语义层(只保留字面 + 模糊检索,包体更小)
    warmup: gentle    # 慢速预热,降低后台 CPU 占用(就绪更慢)
```

---

## 面向开发者

### 架构

```
recall 工具 (ctx.tools.register, defineTool)
├─ 语义层: bge-small-zh-v1.5 int8 ONNX (23MB, 预置)
│    └─ worker 线程推理 (onnxruntime-web WASM, 零原生依赖)
│    └─ 余弦检索 (内存, 512 维)
│    └─ 覆盖率门控 ≥90% 后才参与混合
├─ 模糊层: 自建 SQLite trigram FTS + bigram LIKE + 包含度重排
│    └─ 增量 reconcile (live: ctx.sessions / persisted: sessionPersistence)
├─ 字面层: 官方 ctx.sessionQuery (降级兜底)
└─ 混合: 语义 ∪ 模糊, 取每文档最高分, 按会话聚合
     → readTitle + readEvent 上下文窗口 → 无感知输出
```

降级链:任何一层失败都静默降级到下一层,工具永不报错中断。

### 模块

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 工具注册、scope 解析、混合排序、会话聚合、预热调度 |
| `lib/fuzzy-index.js` | 自建 SQLite 索引(trigram FTS + bigram 召回 + 向量表),零 npm 依赖 |
| `lib/tokenizer.js` | BERT WordPiece 分词器(与 transformers.js 逐 token 对拍一致) |
| `lib/semantic.js` | Embedder 封装:worker 线程、批量嵌入、懒加载 |
| `lib/embed-worker.js` | worker 内 WASM 推理 + mask-aware mean pooling + L2 归一 |
| `lib/vendor/` | vendored onnxruntime-web(0.8MB 入口 + 12MB wasm)+ tokenizer.json |
| `models/` | 合并后单文件 int8 模型(23MB,发布时拆为 optional 包) |
| `lib/client.js` | 极简 ToolView(「回忆中…」/「回忆完成」,不进模型上下文) |

### 关键技术决策

- **自建第二索引,不 fork 官方包**:官方 FTS 用 unicode61 且整句加引号匹配,中文只能逐字/整句——模糊检索必须自己的索引
- **只索引对话文本**:tool-call 参数是操作噪音(曾污染语义排序,实机验证发现),索引只保留 user/assistant 的 text 块
- **worker 线程推理**:WASM 在主线程会阻塞 host 事件循环;worker 化后 ~9.6 条/秒且 host 零阻塞(实测)
- **预置模型,零网络**:模型 23MB 随包(vendor 布局已验证:wasmBinary + 字节直读,无 fetch、无 node_modules 技巧);发布时拆为 `dsh-recall-models` optional 依赖,`npm install --omit=optional` 即轻量版
- **预热不用 timer 服务**:`inject` 是必需依赖契约,服务缺失会阻塞插件加载;改用递归 `setTimeout` 链 + fiber 清理
- **数据源走官方服务**:`ctx.sessions`(live)+ `ctx.sessionPersistence`(持久化),不读 .zstd 文件、不碰私有格式

### 已知边界(如实)

- 短查询(≤4 字)的语义补位较弱(bge 短文本余弦区分度有限),由模糊层 LIKE 兜底
- 语义排序对完全无字面重合的查询不完全可靠——模糊层始终是主路径,agent 最终判断
- 模型为 int8 量化,语义质量为"够用"级别;追求极致可换 fp32 模型(约 4 倍体积)

### 开发与测试

```sh
node .smoke-recall.mjs      # 单元 + 集成(mock,无需模型)
node .smoke-semantic.mjs    # 真模型集成(需 models/ 就位)
```

两套冒烟共 70+ 断言:tokenizer 对拍、索引增量、作用域、混合排序、降级、预热。

### 发布结构

- `dsh-recall` —— 主包(代码 + vendor 运行时 + tokenizer)
- `dsh-recall-models` —— optional 依赖(23MB 模型),npm 默认安装,失败/跳过自动降级为轻量版

### 参考

- [PROJECT.md](PROJECT.md) —— 完整工程文档、决策记录、已知边界、二期计划
- 官方:`@deepseek-ai/dsh-session-query(-sqlite)`、`dsh-tools`、`dsh-session-persistence`
- 模型:BAAI/bge-small-zh-v1.5 (MIT) · onnx-community int8 导出 · onnxruntime-web (MIT)

## License

MIT
