# Reflection 使用指南

[English](reflection.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Reflection 为指定优化插件的资源文件提出修订。Runtime 校验提议的文件树，在当前实验内激活通过校验的版本，供后续调用使用。每个调用都记录实际获取的修订引用。

## 为 Policy 配置 Reflection

在 Policy 的 `defaults.reflection` 或 Recipe 顶层的 `reflection` 中声明模块。以下示例使用 Harness² 的绑定名。其内置模块默认关闭；设置 `reflection: { enabled: true }` 即可启用随包提供的配置。

```yaml
reflection:
  enabled: true
  trigger: { afterIteration: search, skipFinal: true }
  observe: { bindings: [invariantProposer, domainProposer, composer] }
  targets:
    invariantProposer: { resources: [guidance] }
    domainProposer: { resources: [guidance] }
  goal: Preserve useful proposal strategies and qualify unsupported claims.
  evidenceView: execution
  budget: { timeoutSeconds: 3600 }
```

Parameter Agent 也默认关闭 Reflection。开启后，它根据搜索轮次的证据修订 Proposer 指导文件，并在还有后续轮次时触发。其他 Policy 可通过 Recipe 指定串行边界和目标绑定，直接接入 Reflection。

## 选择证据、资源和预算

用 `afterStep`、`afterIteration` 或 `afterPolicy: true` 设置一个或多个触发条件。迭代触发默认使用 `skipFinal: true`。`observe.bindings` 和 `observe.steps` 选择自上个边界以来的调用。`excludeSteps` 排除指定调用，并阻止展开它们产生的测量。启用 Memory 时，可将 `memory` 列为观察绑定。

`execution` 提供执行证据；`training-summary` 还可包含已获授权的训练反馈。默认投影包括可用的 Agent 轨迹、文档预览和资源版本差异。`budget.modelCalls`、`timeoutSeconds` 和 `evidenceBytes` 限制单次执行。实验级预算和取消信号在整个过程中生效。

每个目标指定一个已配置的绑定及其可编辑资源字段。自定义插件在配置 Schema 中用 `x-rsi-path: file` 或 `x-rsi-path: directory` 标注资源字段，在绑定配置中指定具体路径，然后将字段名写入 `targets.<binding>.resources`。插件应从生效的配置路径读取资源。Runtime 激活修订时替换受影响的插件实例，并保留原有快照。

通过 `plugin` 选择实现 `contract.reflection` 的插件。默认的 `reflection.agent` 从 `context/learning/index.json` 读取证据，依据资源清单提出修改。可用 `config.agentRef`、`config.prompt` 和内联 `goal` 或 `goalFile` 覆盖相应字段。对象递归合并，数组整体替换。关闭模块时仍检查语法，跳过学习资源探测。

## 将版本应用到后续实验

Runtime 激活的修订仅在当前实验内生效。将修订写回用户管理的资源，或导出到新目录前，先预览将新增、替换和删除的文件。

```sh
arsi reflection list <experiment-id>
arsi reflection show <revision-id> --to ./revised-guidance
arsi reflection apply <revision-id> --to ./revised-guidance
```

省略 `--to` 时使用记录的原始路径。随包提供的资源需要指定外部导出目录。只有一个目录资源时直接映射到该目录；涉及文件或多个资源时，预览会列出各项路径。在后续 Recipe 的绑定中引用导出的资源即可复用。经验快照见 [Memory 指南](memory_zh.md)。
