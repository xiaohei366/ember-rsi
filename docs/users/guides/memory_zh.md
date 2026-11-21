# Memory 使用指南

[English](memory.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Memory 将经验整理为不可变的文件树快照。获授权的绑定通过 `await ctx.readMemory()` 读取调用开始时生效的版本，返回值包含版本引用、制品引用和 UTF-8 文件。没有可读快照时返回 `null`。

## 为 Policy 配置 Memory

在 Policy 的 `defaults.memory` 或 Recipe 顶层的 `memory` 中声明模块。以下 Recipe 片段使用 WikiSkill 内置的步骤名和绑定名。

```yaml
memory:
  enabled: true
  trigger: { afterStep: train }
  observe:
    steps: [train, propose, select]
    excludeSteps: [baseline, validate, test]
    includeCandidateDiffs: true
    includeCandidateSources: true
  consumers: [proposer]
  evidenceView: training-summary
  budget: { modelCalls: 2, timeoutSeconds: 600 }
```

Harness² 在每个任务结束后使用执行证据更新 Memory。WikiSkill 在训练评测完成后、Proposer 调用前更新。Parameter Agent 可通过 `memory.enabled: true` 开启，在每轮搜索后整理实测配置。三个 Policy 共用相同的模块声明格式。

## 选择证据和消费绑定

通过 `afterStep`、`afterIteration` 或 `afterPolicy: true` 选择串行边界，同一模块可配置多个触发条件。`every` 表示每完成 N 次指定步骤或迭代后触发。迭代支持 `skipFinal`，Memory 默认值为 false。可用 `if` 表达式增加条件。两个学习模块在同一边界触发时，Memory 先执行。

`observe.bindings` 和 `observe.steps` 取并集，`excludeSteps` 排除指定调用及其生成的测量内容。步骤可用唯一 ID 或能够消除歧义的路径。上例中，WikiSkill 能读到上一轮 Selector 的汇总决策和当前训练评测，验证集和测试集的逐项结果不进入证据窗口。

默认 `execution` 视图只提供执行证据。`training-summary` 可包含已获授权的训练反馈。内置编辑器通过 `context/learning/index.json` 读取证据索引。需要候选源码时设置 `includeCandidateSources`。设置 `includeBaseline` 可将应用的初始候选加入差异对照。

省略 `consumers` 时，默认授权 Policy 的 Proposer 绑定。编辑器把文件挂载到 `context/memory/`，并在 `context/input.json` 中列出索引。Policy 输出可通过 `${{ memory.ref }}` 引用活动快照。

## 配置与复用经验

Recipe 可以覆盖嵌套字段，数组整体替换。用 `plugin` 选择实现 `contract.memory` 的插件，插件参数放在 `config` 中。默认的 `memory.agent` 使用内置提示词，可通过 `config.prompt` 覆盖。无法唯一确定 Agent 时，设置 `config.agentRef`。目标可使用内联 `goal` 或相对路径 `goalFile`。每条资源路径都相对于声明该值的文件解析。

`budget.modelCalls`、`timeoutSeconds` 和 `evidenceBytes` 限制单次更新。`editConstraints` 可限制路径、修改文件数和字节数。普通更新被拒绝时保留原快照，实验级预算和取消信号仍然生效。

新实验默认从空 Memory 开始。可设置 `seed: { directory: ./wiki }`，或用 `seed: { fromExperiment: previous-id }` 复制已结束实验的活动快照。应用快照前可先预览目标目录。

```sh
arsi memory list <experiment-id>
arsi memory show <memory-id> --to ./exported-wiki
arsi memory apply <memory-id> --to ./exported-wiki
```

原始种子目录由用户管理时，省略 `--to` 会使用该目录；其他情况下请指定专用的导出目录。优化器资源的修订方法见 [Reflection 指南](reflection_zh.md)。
