# 示例交互启动器

[English](README.md) | 简体中文

在源码仓库中通过分组终端提示启动 **DSH Harness²** 和 **DSH WikiSkill**。每个示例的 `launch.yaml` 与 `recipe.yaml` 放在一起，所有默认值都从 Recipe 读取。启动器只调用构建后的公开 CLI 和 dashboard 的只读 observation API，不直接修改框架状态。

## 启动

使用 Node 24 和仓库指定的 pnpm 版本，在仓库中执行：

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/launcher/launch.mjs
```

选择示例、修改常用参数，按需展开高级参数，然后查看配置总览。可选择 **Start experiment**（启动实验）、**Generate and validate only**（仅生成并验证）、**Edit parameters**（修改参数）、**Save answers and exit**（保存答案并退出）。只保存答案时不会生成 Recipe，也不会运行 doctor。

Harness² 需要 `MODEL_NAME`、`EVALUATOR_MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。WikiSkill 的优化和评测共用 `MODEL_NAME`，还需要 `MODEL_ENDPOINT` 和 `MODEL_API_KEY`。交互启动会询问缺失的变量，并隐藏密钥输入。这些输入只通过子进程环境变量传递，答案和生成的 Recipe 都不保存这些环境变量值，`${VAR}` 引用保持原样，也不写入 `.env` 文件。

时间参数显示为小时或分钟，写入 Recipe 时换算为毫秒或秒。任务列表支持逗号、换行、用 `[]` 表示允许为空的划分，以及 `@path/to/tasks.txt` 文件输入。文件可以是以空白或逗号分隔的 ID，也可以是 YAML/JSON 数组。`@` 文件路径相对于当前 shell 工作目录解析。WikiSkill 的训练、验证、测试任务不能重叠。Harness² 显示的评测次数估算为 `4 × k × 任务数`，不计重试或提前终止。

## 生成、重放、续跑和摘要

```sh
# 交互配置，但不启动实验
node examples/launcher/launch.mjs --dry-run

# 无交互重放保存的覆盖值，使用新 ID
node examples/launcher/launch.mjs --answers .rsi/launcher/<id>/answers.yaml --id <new-id>

# 无需模型凭据，也不执行真实评测，只生成并检查
node examples/launcher/launch.mjs --answers answers.yaml --dry-run

# 沿用之前生成的 Recipe 路径续跑
node examples/launcher/launch.mjs resume <id>

# 刷新运行中或已结束实验的摘要
node examples/launcher/launch.mjs summary <id>
```

答案文件只包含模板名和使用**显示单位**的覆盖值，例如：

```yaml
schemaVersion: rsi.launch.answers/v1
template: harness2
values:
  k: 2
  wall: 4
  evalTimeout: 30
  memory: false
```

另一个模板名为 `wikiskill`，常用参数键是 `trainTasks`、`validationTasks`、`testTasks`、`rounds`、`concurrency` 和 `wall`。全部参数键与单位见 [Harness² 清单](../harness/dsh-harness2/launch.yaml)和 [WikiSkill 清单](../harness/dsh-wikiskill/launch.yaml)。未知参数、非法值、重复任务 ID 和清单引用的缺失字段都会被拒绝。重放会将覆盖值应用到**当前**源 Recipe 默认值上，不是固定的实验快照。`resume` 保留保存的 Recipe，由 Runtime 检查恢复条件；它要求实验已由 `run` 创建，仅执行 dry-run 后不能续跑。

`--answers` 始终不进行交互，包括询问缺失环境变量；启动真实实验前需要在 shell 中设置这些变量。仅静态生成会提示缺失变量，但不要求输入。未指定 `--id` 时，ID 自动包含 UTC 时间戳和随机后缀。生成不会覆盖已有的 launcher 目录。

## 验证与产物

产物统一写入此源码仓库的 `.rsi/launcher/<id>/`，CLI 也从该仓库启动，保证 CLI 和 dashboard 使用同一存储：

| 文件           | 内容                                     |
| -------------- | ---------------------------------------- |
| `answers.yaml` | 模板名及与当前 Recipe 默认值不同的参数   |
| `recipe.yaml`  | 资源路径已重定位的完整 Recipe            |
| `doctor.json`  | 自动静态检查的完整报告，续跑时刷新       |
| `run.log`      | CLI 标准输出和错误输出，续跑时追加       |
| `summary.md`   | 已记录的状态、用量、返回的测量和文件改动 |

生成时递归扫描以 `./` 或 `../` 开头的字符串（也支持 Windows 反斜杠形式），将其转换为基于**原 Recipe 目录**的绝对路径。`plugins/...`、`tuning.json` 等不带该前缀的候选内部路径、URL 和表达式保持原意，`${VAR}` 不会被展开。生成的绝对路径只适用于当前仓库位置，移动仓库后应重放答案。模板的路径约定发生变化时，需要重新验证此规则是否适用。

每份生成的 Recipe 自动执行 `ember-rsi doctor <recipe> --static`，失败时保留报告并阻止启动，没有单独的 doctor 菜单动作。静态检查只验证配置和声明的路径，**不检查**模型访问、Docker、评测环境准备和真实执行。需要时可以另行运行[完整 doctor](../../docs/users/guides/doctor_zh.md)。首版会拒绝 `REPLACE_WITH_*` 占位符，通用占位符/路径问答以及 inference/kernel 搜索空间编辑不在本次范围内。

## 进度与结果

启动器临时在 localhost 的空闲端口启动 dashboard，每 30 秒通过只读 API 获取当前用量，并显示墙钟预算消耗。进度百分比表示预算消耗，不代表任务完成度。当前 `show` 只返回保存的实验记录，不能提供实时预算计数。监控或摘要生成结束时会关闭临时 dashboard。

监控时按 Ctrl+C，可选择 **Keep watching**（继续查看）、**Cancel experiment and wait for cleanup**（取消并等待清理）或 **Exit launcher; experiment keeps running**（退出启动器，实验继续）。非交互运行会请求取消。取消通过公开 CLI 发出；如果实验尚未创建记录，启动器会提示取消未确认并继续监控。独立运行进程负责实验清理。退出监控后，可用 `pnpm ember-rsi cancel <id>` 取消，或用 `summary <id>` 查看。退出监控的实验完成后不会自动刷新摘要。

摘要只追踪 Policy 明确返回的结果引用，分别展示验证与独立测试测量，不从无关分数中推断胜者。只有祖先 baseline 唯一、comparison key、指标定义及单位一致，且双方执行成功、覆盖完整时，才展示差值。文件比较使用公开 artifact 的 digest 列表，`?` 表示 digest 不可用。缺失测量和不可用数据保留为未知。

## 开发检查

```sh
pnpm typecheck:examples
node --import tsx --test tests/unit/example-launcher.test.mjs
pnpm check
```

启动器测试使用本地 fixture 和模拟 CLI 进程，不发起模型调用或真实基准评测。`.mjs` 入口直接加载 Node 24 支持的 TypeScript，不需要构建启动器。`@clack/prompts` 是开发依赖，发布包不包含示例。
