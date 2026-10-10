# 真实 Solver 接入

个人练习可调用本机的 **TexasSolver CLI**，运行实际 DCFR 求解并读取其 JSON 策略。练习建议中的权益估计和规则评分仍是本项目的练习模型；只有标记 `source: "TexasSolver CLI"`、`supported: true` 的结果来自外部求解器。

## 安装

先安装游戏依赖，然后运行：

```sh
npm ci
npm run solver:setup
npm start
```

安装脚本从[作者的 GitHub Releases](https://github.com/bupticybee/TexasSolver/releases/tag/v0.1.1)下载 **v0.1.1 console** 包。该版本是专用命令行发行版，发布说明包含转牌与河牌计算修复；较新的 v0.2.0 加入图形界面。本项目使用 console 的 `-i` / `-r` 参数及 JSON 输出，接口见[官方 console 文档](https://github.com/bupticybee/TexasSolver/tree/console#usage)。

自动安装支持 Windows、macOS、Linux 的 x64 环境。Windows 压缩包约 **16.5 MB**，解压后还包含牌型查询表；启动一次求解需要加载查询表，首次结果可能需要十几秒或更久。网络下载采用官方 HTTP 分块，并检查总大小；本地计算的 SHA-256 记录用于后续审计，不代表作者提供了独立校验签名。

安装文件保存在被 Git 忽略的 `.solver/` 中，仓库不分发求解器程序。Windows 使用系统 `tar` 解压；macOS 使用 `tar`，Linux 需安装 `unzip`。非 x64 架构或发行包无法运行时，可按照官方文档编译 console。

已自行安装 console 的房主，可在运行游戏服务前设置绝对路径；必须保留求解器旁边完整的 `resources/` 目录：

```powershell
# Windows PowerShell：将占位路径换成本机 console_solver.exe 的位置
$env:TEXAS_SOLVER_PATH = 'C:\path\to\TexasSolver\console_solver.exe'
npm start
```

```sh
# macOS / Linux
TEXAS_SOLVER_PATH=/path/to/TexasSolver/console_solver npm start
```

路径只来自房主的进程环境或本机安装清单，网页请求无法指定可执行文件。对外状态只显示引擎、版本、是否可用和说明，不公开本机路径。

## 当前支持范围

在个人练习中，选择 **一名机器人**，进入转牌或河牌并轮到自己行动时请求求解。当前适配支持：

- 一名真人对一名机器人，双方仍参与本手且都未全下。
- 本轮尚未下注，或自己本轮尚未投入筹码、正在面对对手的首次下注。
- 本轮起始底池至少 2 筹码，底池与有效筹码均不超过 1000000。

翻牌前、翻牌、多人、已全下、本轮投入后面对再加注等节点会明确返回 `supported: false`，并说明原因。超时、输出不完整或包含不合法的正频率动作时，也不返回外部策略。

对下注未跟齐的节点，适配先用 `当前底池 − 双方本轮投入` 恢复本轮起始底池，再用 `min(双方剩余筹码 + 各自本轮投入)` 恢复有效筹码。按庄家确定 IP / OOP，沿已发生的过牌和首次下注定位求解树节点。输出下注映射到游戏的“加注到”金额，全下映射到实际全下动作。

## 结果应如何理解

默认双方范围均为 **全部 169 类起手牌、每个组合等权**。Solver 会处理公共牌及双方手牌之间的牌张冲突；程序只读取自己的底牌以找到自己组合的输出策略，**不读取机器人真实底牌**。范围尚未按翻牌前行动或此前街道更新，因此它是明确范围假设下的参考。

求解树考虑达到最小下注要求的半池、满池、对手已经发生的首次下注、满池加注和全下。它是离散下注树，没有覆盖所有可能的下注金额。有效筹码封顶意味着较大筹码玩家的超额部分不参与该 heads-up 底池模型。

默认最多 **100 次 DCFR 迭代**，目标 exploitability 为起始底池的 **1%**。结果包含实际日志中的 `exploitabilityPercent`、是否达到目标的 `converged`、耗时、频率和假设；即使正常完成，也应依据这些收敛信息评估结果。频率是给定范围和下注树下的近似混合策略，不是任意局面的完整 GTO 解。

一次只运行一个求解任务。默认时间上限 45 秒，调用方可设置至多 60 秒；超时会终止子进程。每次任务使用独立临时目录，完成、失败或超时后删除输入、输出和日志。求解进程通过参数数组启动，`shell: false`，Windows 隐藏进程窗口。

## 开发接口

```js
import { solverStatus, solveDecision } from './solver-adapter.js';

const status = solverStatus();
const result = await solveDecision(heroPublicSnapshot, { timeoutMs: 45000 });
```

`solverStatus()` 返回 `{ available, engine, source, repository, version, reason, supportedStreets, license }`。`available` 表示找到了可执行文件和资源；实际运行错误会在求解结果中说明。

成功求解返回：

```js
{
  available: true,
  supported: true,
  source: 'TexasSolver CLI',
  strategy: [
    { type: 'check', frequency: 0.4 },
    { type: 'raise', amount: 50, frequency: 0.6 }
  ],
  recommendation: { type: 'raise', amount: 50, frequency: 0.6 },
  assumptions: ['范围、下注树与迭代假设说明'],
  exploitabilityPercent: 0.8,
  converged: true,
  approximate: true,
  elapsedMs: 12000
}
```

上述数字只是字段格式示例。`recommendation` 是最高频率动作，完整混合频率在 `strategy` 中。未安装或不支持时，`strategy` 为空、`recommendation` 为 `null`，不会伪造 Solver 结果。

内部研究调用还可提供 `rangeOop`、`rangeIp`、`maxIterations`、`accuracy`；范围只接受牌类和可选的 0–1 权重，不接受命令或文件路径。游戏的网页请求不转发这些内部选项。

## 测试

常规 `npm test` 包含输入约束、对手底牌访问隔离、位置/底池恢复、JSON 频率与合法动作映射、不支持节点和路径隐私合同测试。默认不运行需要下载程序的耗时测试。

安装官方 CLI 后，可显式运行真实河牌求解、忙碌状态和超时清理测试：

```powershell
# Windows PowerShell
$env:RUN_SOLVER_INTEGRATION = '1'
node --test tests/solver.test.js
```

```sh
# macOS / Linux
RUN_SOLVER_INTEGRATION=1 node --test tests/solver.test.js
```

本机已用官方 Windows v0.1.1 console 验证小规模河牌：底池 100、有效筹码 100，双方范围 `AA,KK,QQ,JJ,AK,AQ,KQ`，公共牌 `Ks Qh Jd 2c 3s`，己方 `As Ah`。得到真实的过牌、下注和全下频率及收敛日志；耗时包含牌型表加载。该实测针对这一测试局面，不能推广为所有街道和范围均达到同一精度或速度。

## 上游选择与许可证

- [bupticybee/TexasSolver](https://github.com/bupticybee/TexasSolver)：本次使用的 C++ console，作者发布 Windows / macOS / Linux 包，支持输入文件和 JSON 输出。
- [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver)：Rust postflop 引擎，使用示例需 Rust 编译；属于库接口，本次未集成。
- [bupticybee/TexasHoldemSolverJava](https://github.com/bupticybee/TexasHoldemSolverJava)：MIT 的旧 Java 求解器，可作为另一适配方向，本次未集成。

TexasSolver 的仓库标注 [AGPL-3.0](https://github.com/bupticybee/TexasSolver/blob/master/LICENSE)，作者 [README 授权说明](https://github.com/bupticybee/TexasSolver#q--as)另涉及发行包再分发、代码集成和网络服务授权。本项目只提供本机外部 CLI 的安装与调用适配，不复制其源码、不随仓库分发二进制。部署公开求解服务、再分发或商业集成前，应核对上游许可及作者说明。`postflop-solver` 同样标注 AGPL-3.0，换用它不会自动消除许可要求。
