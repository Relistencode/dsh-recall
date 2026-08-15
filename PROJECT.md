# dsh-recall 工程文档

> 对话历史召回工具——"微信搜聊天记录"模式：上下文爆炸后，按语义/关键字检索**原始对话**，定位到消息并回看前后文。
> 状态：一期开发中 · 独立仓库规划中 · 不推送

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
├─ 设置页（二期）：搜索框 + 分组结果 + 展开上下文 + **默认作用域设置**（当前对话/跨对话/跨项目）
├─ 语义层（三期）：本地 embedding（ONNX，bge-small-zh）混合召回 + rerank（参考 dsh-mneme）
└─ 压缩配合（二期）：监听 checkpoint 事件登记摘要 + 提炼决策条目
```

**依赖**：
- `@deepseek-ai/dsh-session-query-sqlite`（官方，web profile 默认启用）——`ctx.sessionQuery`：searchSessions/searchEvents/readEvent/readTitle/filterSessions/listSessions
- `@deepseek-ai/dsh-tools` —— `defineTool` 工具注册（官方 dsh-tool-todo 同款）
- `@deepseek-ai/dsh-typert-protocol`（如做设置页时用，一期 host-only 不需要）

**关键事实（调研确认）**：
- 会话日志：`~/.dsh/sessions/<workspace>/<sessionId>/session.jsonl.zstd`（JSONL + zstd，append-only）
- 官方 `session-query-sqlite` 已自动索引日志（增量更新、三种 surface 可搜：current/shadowed/log-only）——**压缩前的历史仍然可搜**
- `searchSessions`：跨会话全文搜索，按会话分组，FTS5 命中 span 数排序
- `readEvent`：目标事件 + bounded 前后文窗口（before/after 上限 readWindowMax）
- 工具注册：`ctx.tools.register(defineTool({name, description, parameters(JSON Schema), output:{schema}, execute(args, exec)}))`，apply 时全局注册

## 4. 实施计划

### 一期（当前）
- [x] 工程文档
- [ ] 调研 SessionSearchRequest 精确形状（query/filters/pageSize 字段名）
- [ ] 包骨架：package.json（name dsh-recall, exports ./lib/index.js）
- [ ] lib/index.js：`recall` 工具
  - parameters：`query`(string, required)、`workspace`(string, 可选 cwd 过滤)、`limit`(integer, 可选，默认 10)、`context`(integer, 前后文轮数，默认 3，上限 readWindowMax)
  - execute：规范化 → searchSessions（filters 含 workspace）→ 对 top 命中 readTitle + readEvent → 聚合分组
  - 错误处理：sessionQuery 缺失/搜索失败/无结果的可读消息
- [ ] 单元测试（mock sessionQuery：命中分组、上下文窗口、workspace 过滤、空结果）
- [ ] 3099 安装验证（junction + patch 行 → Inspect Tool.listTools 确认 `recall` 注册）
- [ ] 提交（不推送）

### 二期
- [ ] 设置页可视化（搜索框 + 分组结果 + 展开上下文；i18n zh/en）
- [ ] 压缩配合：监听 checkpoint 摘要事件 → 登记为可检索记忆条目；提炼"设定/决策"条目
- [ ] 工具增强：`mode: browse`（按会话浏览全文）、时间范围过滤、结果 LLM 精排/摘要
- [ ] 自动辅助开关：新会话开始自动召回 2-3 条最相关历史（默认关）

### 三期（远期）
- [ ] 语义层：本地 embedding（ONNX bge-small-zh）向量召回 + rerank 精排 + 向量聚类（参考 dsh-mneme）
- [ ] 主题化检索：结果按话题聚类合并，避免"大量相似内容"噪音
- [ ] 评估更好的压缩机制：主题化压缩 / 分层压缩 / 模型驱动压缩（billion-context-dsh 思路）——**只评估，不动 DSH 核心**

## 5. 决策记录

| 决策 | 理由 |
|---|---|
| 一个工具而非多个 | agent 调用模式是"一次提问一次检索"；多阶段筛选（改写/召回/精排/聚合/解析）封装在工具内部 |
| 手动为主 | 自动注入占 token、时机难判断；人搜微信也是主动搜 |
| 依赖官方 sessionQuery | 官方已自动索引全量历史（含压缩前的 shadowed），无需自建索引/解析 zstd；工作量降一个数量级 |
| 一期不动压缩 | 日志 append-only，压缩不影响可搜性；压缩配合（摘要登记/决策提炼）二期做，重工程远期只评估 |
| 独立仓库 | 与 dsh-extension-hub 解耦，独立版本迭代；贡献指南可进 awesome-dsh-plugin |

## 6. 参考

- 官方：`@deepseek-ai/dsh-session-query`、`dsh-session-query-sqlite`（FTS5）、`dsh-session-reference`（跨会话引用）、`dsh-tools`（defineTool）
- 社区：dsh-mneme（离线向量/精排/聚类）、hindsight（学习型记忆上限）、billion-context-dsh（模型驱动压缩）、MemGPT/Letta、mem0
- 类比：微信搜聊天记录（用户提出的需求原型）
