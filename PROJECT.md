# dsh-recall 工程文档

> 对话历史召回工具——"微信搜聊天记录"模式：上下文爆炸后，按语义/关键字检索**原始对话**，定位到消息并回看前后文。
> 状态：一二三期完成（3080 实机验证通过） · 独立仓库规划中 · 不推送

## 1. 背景与动机

长周期项目（游戏开发、耦合系统维护、bug 修复、大型内容开发）中，上下文会反复压缩（compaction）。压缩后模型只剩结构化摘要，细节丢失；项目设定、历史决策、当时的讨论过程需要能**按需找回原文**——就像人在微信里搜关键字、点开那几轮聊天记录，一看就想起来当时在做什么。

本项目为 DeepSeek Harness (DSH) 提供这一能力：一个 agent 工具（+ 后续设置页），检索**所有会话的原始日志**（跨窗口：设计窗口、执行窗口、历史项目会话），命中后带前后文回看。

## 2. 需求（已与用户确认）

| 需求点 | 结论 |
|---|---|
| 核心 | 关键字检索历史对话原文，定位到消息 + 回看前后几轮（微信式） |
| 对象 | 所有会话（跨工作区：DSH 项目、游戏项目等） |
| 触发 | **手动为主**（agent 主动调工具）；自动辅助（新会话相关召回）作为可选项，默认关 |
| 精准定位 | 五层：① agent 查询理解/改写（模糊→精确词 + 工作区过滤）② 官方 FTS5 命中排序 ③ 元数据过滤（cwd/时间）④ 会话级聚合 ⑤ LLM 精排/摘要（二期） |
| 语义 | 二期/三期：embedding 混合召回补字面盲区（参考 dsh-mneme 本地 ONNX） |
| 压缩配合 | 一期不动压缩（日志 append-only，FTS5 索引完整保留历史，压缩不影响召回）；二期登记 checkpoint 摘要 + 提炼设定/决策条目；远期评估主题化/分层压缩 |
| **作用域** | **默认只搜当前会话**；跨对话（同工作区）/跨项目（全部）只在**用户明确要求**时发生（agent 不会主动扩大——工具描述写死约束，仅当用户说"去看看执行窗口干了什么""参考一下 recall 项目"这类话才扩大）；设置页（二期）提供默认作用域设置（当前对话/跨对话/跨项目） |
| 形态 | 独立插件 `dsh-recall`（可随时卸载，附加功能生态），工具 `recall` 注册给 agent |

## 3. 架构

```
dsh-recall（npm 独立包，host 插件）
├─ 工具 `recall`（ctx.tools.register，defineTool）
│   ├─ 查询规范化：trim/分词/大小写
│   ├─ 作用域：默认当前会话（session id 过滤）；scope=workspace（cwd 过滤）/ all（无过滤），仅用户明确要求时扩大
│   ├─ 粗召回：ctx.sessionQuery.searchSessions（官方 FTS5，自动增量索引全量 zstd JSONL 历史）
│   ├─ 上下文：ctx.sessionQuery.readTitle（会话标题）+ readEvent（命中前后 ±N 轮）
│   ├─ 会话聚合：按会话分组，组内按命中强度排序，输出分组结果
│   └─ 输出：{ query, total, groups: [{ sessionId, title, cwd, time, snippet, context[] }] }
├─ 自定义 ToolView（lib/client.js，tool.call.toolview key=recall）
│   ├─ 运行中：光波扫动动画 + 「回忆中…」（无感知，安静）
│   ├─ 完成：一行极简「回忆完成」（结果由 agent 在回复中呈现，UI 不进模型上下文）
│   └─ 失败：一行错误原因
└─ 语义层（三期）：本地 embedding（ONNX，bge-small-zh）混合召回 + rerank（参考 dsh-mneme）
```

**依赖**：
- `@deepseek-ai/dsh-session-query-sqlite`（官方，web profile 默认启用）——`ctx.sessionQuery`：searchSessions/searchEvents/readEvent/readTitle/filterSessions/listSessions
- `@deepseek-ai/dsh-tools` —— `defineTool` 工具注册（官方 dsh-tool-todo 同款）
- `@deepseek-ai/dsh-typert-protocol`（如做设置页时用，一期 host-only 不需要）

**关键事实（调研确认）**：
- 会话日志：`~/.dsh/sessions/<workspace>/<sessionId>/session.jsonl.zstd`（JSONL + zstd，append-only）
- 官方 `session-query-sqlite` 已自动索引日志（增量更新、三种 surface 可搜：current/shadowed/log-only）——**压缩前的历史仍然可搜**
- **全文搜索默认关闭**：官方 dsh-base 默认 `path: ':memory:'`、`openAt: never`（搜索报 `SESSION_QUERY_SEARCH_DISABLED`）；部署须在 profile 的 `cordis.patch.yml` 覆盖为持久 `path`（如 `~/.dsh/storages/session-search.db`）+ `openAt: first-search`，**重启 dsh 实例后生效**（本机 3080/3099 已配）
- `searchSessions`：跨会话全文搜索，按会话分组，FTS5 命中 span 数排序
- `readEvent`：目标事件 + bounded 前后文窗口（before/after 上限 readWindowMax）
- 工具注册：`ctx.tools.register(defineTool({name, description, parameters(JSON Schema), output:{schema}, execute(args, exec)}))`，apply 时全局注册

## 4. 实施计划

### 一期（完成）
- [x] 工程文档
- [x] 调研 SessionSearchRequest 精确形状（query/filters/pageSize 字段名）
- [x] 包骨架：package.json（name dsh-recall, exports ./lib/index.js）
- [x] lib/index.js：`recall` 工具
  - parameters：`query`(string, required)、`scope`(enum session/workspace/all，默认 session)、`workspace`(string, 可选 cwd 过滤)、`limit`(integer, 可选，默认 10)、`context`(integer, 前后文轮数，默认 3，上限 readWindowMax)
  - execute：规范化 → searchSessions（filters 含 sessionId/workspace）→ 对 top 命中 readTitle + readEvent → 聚合分组
  - 错误处理：sessionQuery 缺失/搜索失败（含 `SESSION_QUERY_SEARCH_DISABLED` 提示部署需开 openAt）/无结果的可读消息
- [x] 单元测试（mock sessionQuery：命中分组、上下文窗口、workspace 过滤、空结果——.smoke-recall.mjs，29 断言）
- [x] 安装验证（junction + patch 行 → Inspect 确认 `recall` 注册；3080 实机全文搜索「附加功能」命中本会话历史 ✓）
- [x] 提交（不推送）

### 二期
- [ ] 工具增强：`mode: browse`（按会话浏览全文）、时间范围过滤、结果 LLM 精排/摘要
- [ ] 压缩配合（待用户决定）：监听 `compaction/summary` 事件（官方日志事件，见调研）→ 登记为可检索记忆条目；提炼"设定/决策"条目
- [ ] 候选：索引驱动迁移到官方 `sessionProjections` 注册表（省手写 reconcile、免费持久化/冷恢复；但向量层异步不满足投影 apply 同步约束，需混合；且引入 zod 依赖）——**已调研未实施**

### 三期（完成）
- [x] 语义层：本地 embedding（ONNX bge-small-zh）向量召回 + 混合（与 fuzzy 合并，取最高分）
- [x] 后台预热：worker 线程嵌入（~9.6 条/秒，host 零阻塞；3080 实机 2 分钟完成 1367 条）
- [x] 覆盖率门控 ≥90%：语义未就绪前静默只用 fuzzy

### 三期（远期）
- [ ] 主题化检索：结果按话题聚类合并，避免"大量相似内容"噪音
- [ ] 评估更好的压缩机制：主题化压缩 / 分层压缩 / 模型驱动压缩（billion-context-dsh 思路）——**只评估，不动 DSH 核心**

## 4.5 已知边界（M5 实机验证结论）

| 边界 | 说明 | 兜底 |
|---|---|---|
| 短查询（≤4 字）语义补位弱 | bge-small-zh 短文本余弦区分度有限（分数挤在 0.45-0.55） | fuzzy 主路径（trigram + 2 字 LIKE 扫描） |
| 语义排序对无字面查询不完全可靠 | "状态机"等查询 top 命中有不相关文档 | agent 判断 snippet；fuzzy 字面优先 |
| 工具参数不进索引 | tool-call 块 JSON 曾污染语义排序（M5 发现并修复：只索引 text 块） | — |
| 压缩摘要可搜 | 摘要以 user/message 落盘，天然被 recall 覆盖 | — |

## 5. 决策记录

| 决策 | 理由 |
|---|---|
| 一个工具而非多个 | agent 调用模式是"一次提问一次检索"；多阶段筛选（改写/召回/精排/聚合/解析）封装在工具内部 |
| 手动为主 | 自动注入占 token、时机难判断；人搜微信也是主动搜 |
| **无感知定位** | 面向长期单窗口工作者（文字工作者/项目维护者/游戏与角色扮演用户）：工具自动工作，用户只需看到安静的回移动效；**不做设置页/搜索界面** |
| **完成态不展示结果** | agent 在回复中呈现结果；UI 保持一行状态（回忆完成/失败），节省用户注意力（UI 本就不进模型上下文） |
| **回复层无感知** | agent 回复要像"一直都知道"一样自然融入召回内容——不出现"我查一下/当时我们讨论过/搜索结果"等任何检索痕迹，用户看不出发生过搜索（用户原话：朋友记得周三要看电影，自然答"你两点半到门口来"） |
| 依赖官方 sessionQuery | 官方已自动索引全量历史（含压缩前的 shadowed），无需自建索引/解析 zstd；工作量降一个数量级 |
| 自建第二索引（fuzzy+语义） | 官方索引 unicode61 整句匹配只能字面；trigram/bigram/语义需要自己的索引（不 fork 官方包） |
| **只索引对话文本** | tool-call 参数是操作噪音，曾污染语义排序（M5 实证）；索引只保留 user/assistant 的 text 块 |
| **语义层预置进包** | 模型 23MB + wasm 13MB vendor 进包，安装即全部能力、零网络依赖；发布为 optional 模型包（`dsh-recall-models`），`--omit=optional` 即轻量版 |
| **worker 线程推理** | onnxruntime-web WASM 在主线程会阻塞 host 事件循环；worker 化后 ~9.6 条/秒零阻塞（spike7 实证） |
| **预热用 setTimeout 链** | 不依赖 timer 服务（inject 是必需依赖契约，服务缺失会阻塞插件加载）；递归 setTimeout + fiber 清理 |
| **语义阈值 0.50** | M5 实测：0.42 放行过多弱相关（短文本余弦挤在 0.45-0.55）；0.50 在噪音与召回间取平衡 |
| 一期不动压缩 | 日志 append-only，压缩不影响可搜性；压缩配合（摘要登记/决策提炼）待定，重工程远期只评估 |
| 独立仓库 | 与 dsh-extension-hub 解耦，独立版本迭代；贡献指南可进 awesome-dsh-plugin |

## 6. 参考

- 官方：`@deepseek-ai/dsh-session-query`、`dsh-session-query-sqlite`（FTS5）、`dsh-session-reference`（跨会话引用）、`dsh-tools`（defineTool）
- 社区：dsh-mneme（离线向量/精排/聚类）、hindsight（学习型记忆上限）、billion-context-dsh（模型驱动压缩）、MemGPT/Letta、mem0
- 类比：微信搜聊天记录（用户提出的需求原型）
