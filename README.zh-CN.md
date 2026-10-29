# Cteno SDK（中文）

**用你自己的 Node.js 或 Python 代码运行 Cteno Agent。不用装桌面 App，也不用注册账号。**

`npm install @cteno/sdk` 或 `pip install cteno-sdk` 会顺带装上一个适配你平台的本地 Cteno daemon。
第一次调用 `CtenoSession.open()` 时，它以**本地模式**启动：不登录、没有 Cteno 账号，模型用你自己的 key（BYOK）。
你的代码可以创建 Agent 会话、流式读取输出、在你自己的进程里执行你定义的工具，并取回结果。

如果你同时在用 Cteno 桌面 App，App 不受任何影响：SDK 的 daemon 有自己的数据目录、socket、机器 ID 和日志；
除非你显式传入 App 的 socket 路径，否则它不会连 App 的 daemon。

完整的英文文档见 [README.md](README.md)，代码示例在 [`examples/`](examples/)。

| 包 | 语言 | 目录 |
|---|---|---|
| `@cteno/sdk` | Node.js ≥ 20（ESM，自带 TypeScript 类型） | [`js/`](js/) |
| `cteno-sdk`（`import cteno_sdk`） | Python ≥ 3.9，只依赖标准库 | [`python/`](python/) |

> **当前状态：**npm 与 PyPI 已发布 2.10.14（内置 Cteno 2.10.14）。2.10.13 是唯一一次单独发布的 SDK 版本，内置的是 2.10.12 的 daemon；从 2.10.14 起 SDK 版本号与 Cteno 一致。

## 前置条件

- Node.js ≥ 20，或 Python ≥ 3.9。
- 支持的平台：macOS（Apple 芯片；Intel 需 ≥ 10.15）、Linux x64（glibc ≥ 2.34，即 Ubuntu 22.04+、Debian 12+、RHEL 9+）、Windows x64。暂不支持 Linux arm64。
- **一个模型服务的 API key**，接口兼容 OpenAI、Anthropic 或 Gemini 均可（OpenAI、DeepSeek、Moonshot、OpenRouter、本地 Ollama/vLLM 等）。
  用 `configureModel()` 登记一次即可，见下面的上手示例。

**不需要** Cteno 桌面 App，也**不需要** Cteno 账号。

## 安装

### 从源码使用（当前可用）

npm / PyPI 上还没有这两个包，所以源码检出里没有自带的 daemon。需要把 SDK 指向一个你已有的 daemon：

- **已在运行 Cteno 桌面版 ≥ 2.10.10：** 把它的 socket 路径传给 `open()`（Node 用 `socketPath`，Python 用 `socket_path`）；或者
- **手头有 `cteno-host-cli` 二进制：** 把 `CTENO_SDK_DAEMON_PATH` 设成它的路径，`open()` 会在 SDK 自己的数据目录里启动它。

```bash
git clone https://github.com/zalan159/cteno-sdk && cd cteno-sdk
cd js && npm install && npm run build && cd ..   # Node：先构建一次，再从 ./js 引用
pip install ./python                             # Python：安装源码包
```

### 从 npm / PyPI 安装

```bash
npm install @cteno/sdk
pip install cteno-sdk
```

发布后，npm 只会装与你机器匹配的那个平台包（`@cteno/sdk-darwin-arm64`、`@cteno/sdk-darwin-x64`、`@cteno/sdk-linux-x64` 或 `@cteno/sdk-win32-x64`，约 20 MB）；
pip 同样会挑对应平台的 wheel。不要加 `--omit=optional` / `--no-optional`：daemon 是以可选依赖的形式安装的。

在不支持的平台上，或装的是纯 Python 的 sdist，SDK 能装上但启动不了 daemon，见[排错](#排错)。

## 5 分钟上手

先登记一次模型（保存在 SDK daemon 自己的数据目录里，之后一直作为默认模型），然后提问。`hello.mjs`：

```js
import { CtenoSession, query } from '@cteno/sdk/core';

const cteno = await CtenoSession.open();            // 第一次调用时启动自带的 daemon
await cteno.configureModel({
  baseUrl: 'https://api.openai.com/v1',             // 含版本号的 API 根地址，原样使用
  model: 'gpt-4.1-mini',
  apiKey: process.env.OPENAI_API_KEY,
});
cteno.dispose();

for await (const m of query({ prompt: 'Reply with exactly: hello from Cteno', cwd: '.' })) {
  if (m.type === 'assistant' && (m.kind === undefined || m.kind === 'message')) console.log(m.text);
  if (m.type === 'result') console.log(m.ok ? '[done]' : `[failed] ${m.error}`);
}
```

```console
$ OPENAI_API_KEY=sk-... node hello.mjs
hello from Cteno
[done]
```

Python 版（`hello.py`）：

```python
import asyncio, os
from cteno_sdk import CtenoSession

async def main():
    async with await CtenoSession.open() as cteno:
        await cteno.configure_model(base_url="https://api.openai.com/v1", model="gpt-4.1-mini",
                                    api_key=os.environ["OPENAI_API_KEY"])
        sid = await cteno.create(cwd=".")
        result = await cteno.run(sid, "Reply with exactly: hello from Cteno")
        print(result.text if result.ok else result.error)
        await cteno.close_session(sid)

asyncio.run(main())
```

一台机器上第一次 `open()` 要一两秒，用来启动 daemon、初始化数据库；之后的调用直接连上已在运行的 daemon。
Anthropic 或 Gemini 风格的接口，传 `apiFormat: 'anthropic'` / `'gemini'`（Python 是 `api_format=`）。

**`baseUrl` 原样使用，SDK 不会替你拼任何版本号。** 它只在后面追加接口路径：`apiFormat: 'openai'` 追加 `/responses`（OpenAI Responses API），`'anthropic'` 追加 `/messages`，`'gemini'` 追加 `/models/<model>:streamGenerateContent`。请按厂商文档把版本段写进 `baseUrl`：

| 厂商 | `apiFormat` | `baseUrl` |
|---|---|---|
| OpenAI | `openai` | `https://api.openai.com/v1` |
| DeepSeek | `openai` | `https://api.deepseek.com/v1` |
| DeepSeek（Anthropic 兼容） | `anthropic` | `https://api.deepseek.com/anthropic/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` |
| Google Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` |

**配置错误在 `configureModel()` 时就报错，不会等到第一轮才 404。** `baseUrl` 缺版本段、版本段重复（`…/v1/v1`）或带了接口路径（`…/v1/responses`）时，`configureModel()` 抛 `SdkError('REMOTE')`，错误信息里写明实际将请求的完整 URL。

**`ok` 反映这一轮的真实结果。** 模型调用失败（404、401、限流、额度）或回合超时时，`result.ok` 为 `false`，`error` 是厂商返回的错误原文（含实际请求的 URL，例如 `OpenAI API error (404 Not Found) POST https://…/v1/responses: (empty body)`），`errorKind` 是错误类别（`E_EXECUTOR`、`E_AUTH`、`E_RATE_LIMIT`、`E_TIMEOUT` 等）。`ok: true` 表示这一轮跑完并给出了回答。

流里的 `assistant` 帧除了正文，还有 thinking、工具调用等结构化帧（`kind` 有值）。只打印 `kind` 为空或 `'message'` 的帧，就只看到正文。

## 权限：哪些操作不用批准

SDK 是无人值守运行的，所以它从不等人：

- **只读工具**（读文件、搜索、列目录）自动执行。
- **其他工具**（shell 命令、改文件、联网、浏览器等）都需要批准。没有批准方时，SDK **立即拒绝**，
  并告诉模型原因，这一轮会正常结束，不会卡住。
- 想自己决定，就传 **`canUseTool`**（Python 是 `can_use_tool`）：

```js
const result = await session.run({
  sessionId: id,
  prompt: '新建 notes.txt，写上今天的日期',
  canUseTool: req => req.toolName === 'Bash' ? { allow: true } : { allow: false, reason: '我的应用不允许' },
});
```

  被放行的调用会执行，这一轮接着往下跑；`run()` / `send()` 要等整轮（包括批准之后的部分）结束才返回。
- 也可以给会话设**权限模式**：`create({ permissionMode })`，可选 `acceptEdits`（允许改文件，其他工具仍走 `canUseTool`）、
  `plan`（不做任何改动）、`bypassPermissions`（全部放行，只在你完全掌控提示词和工作目录时使用）。

## 常见任务

都有可运行的文件，在 [`examples/`](examples/) 里：

| 任务 | Node | Python |
|---|---|---|
| 列出会话和模型 profile | `list-sessions.mjs` | `sessions.py` |
| 派一个任务并等结果，再看它调用了哪些工具 | `run-task.mjs` | `sessions.py` |
| 实时看事件流，用 hook 拦截危险工具调用 | `stream-events.mjs` | — |
| 多轮对话 | `multi-turn.mjs` | — |
| 自定义 Agent：自己的提示词、在你进程里执行的工具、结构化输出 | `client-tools.mjs` | `query.py` |

在 clone 下来的仓库里运行：

```bash
cd js && npm install && npm run build && cd ..
cd examples/node && npm install && node list-sessions.mjs
pip install ./python && python examples/python/quickstart.py
```

## 自带的 daemon

**放在哪里。** 每个用户一个目录，SDK daemon 的所有东西都在里面：

| 系统 | 默认实例目录 |
|---|---|
| macOS | `~/Library/Application Support/cteno-sdk` |
| Linux | `$XDG_DATA_HOME/cteno-sdk` 或 `~/.local/share/cteno-sdk` |
| Windows | `%LOCALAPPDATA%\cteno-sdk` |

里面有 `data/`（数据库、模型 profile、机器 ID）、`home/`（Agent 的记忆和工作区）、`run/`（socket）、`logs/daemon.log`。
用 `CTENO_SDK_HOME`（或 `open({ daemon: { home } })`，Python 是 `open(home=...)`）可以换目录；每个目录是一个独立的 daemon，数据互不相通。

**生命周期。** `open()` 先找这个目录对应的 daemon，在运行就连上，没在运行就启动。
同一用户、同一目录下的所有 SDK 进程共用一个 daemon；你的进程退出后 daemon 继续运行，这样会话能跑完，下次 `open()` 也是瞬间完成。
用 `stopDaemon()`（Python：`from cteno_sdk import stop_daemon`）停掉它，会话和数据都保留在磁盘上。

**升级。** daemon 的版本跟 SDK 版本绑定。升级 SDK 后，下一次 `open()` 会用新的自带 daemon 替换掉正在运行的旧版本，数据就地迁移。
设置 `CTENO_SDK_KEEP_DAEMON=1` 则始终保留正在运行的那个。

**安全：系统用户身份就是凭证。** SDK 没有 token。daemon 只监听权限为 `0600` 的 Unix socket（Windows 上是按目录区分的命名管道），
不监听任何 TCP 端口。以你的用户身份运行的进程都能用它，其他用户不能。模型 key 保存在 daemon 的数据目录里，权限同你的用户。

**本地模式。** daemon 从不登录，所以没有 Cteno 账号、云端中转和同步：会话、历史和记忆只存在这台机器上，
模型调用直接发到你配置的接口。Cteno App 的云端功能（手机远程访问、多设备同步）SDK daemon 都没有。

**和 Cteno 桌面 App 并存。** 两者可以同时运行，互相看不到：数据目录、socket、机器 ID、会话和日志都是分开的。
如果你想改用 App 的 daemon（比如希望会话出现在 App 里），显式传入它的 socket：`CtenoSession.open({ socketPath })` /
`CtenoSession.open("/path/to/host.sock")`。App 里 `cteno-host-cli status` 输出的 `host_socket_active` 就是这个路径。
`discoverOwnerSocket()`（`@cteno/sdk/discover`）能帮你找到它；`open()` 自己从不去找。

**用自己编译的 daemon。** 把 `CTENO_SDK_DAEMON_PATH` 设成某个 `cteno-host-cli` 的路径，就会用它代替自带的。

## 排错

| 现象 | 原因和解决办法 |
|---|---|
| `The platform package @cteno/sdk-<platform> is not installed` | npm 跳过了可选依赖。去掉 `--omit=optional` / `--no-optional` 重装，或者显式 `npm install @cteno/sdk-<platform>`。 |
| 从源码使用时报 `The platform package @cteno/sdk-<platform> is not installed` | npm 包发布之前，源码检出没有自带 daemon。请传桌面版的 `socketPath`，或设置 `CTENO_SDK_DAEMON_PATH`（见[从源码使用](#从源码使用当前可用)）。 |
| `No bundled Cteno daemon for <os>-<arch>` | 你的平台没有预编译的 daemon（见[前置条件](#前置条件)）。把 `CTENO_SDK_DAEMON_PATH` 指向你自己编译的 `cteno-host-cli`，或用 `socketPath` 连你自己运行的 daemon。 |
| Python：`This cteno-sdk install has no bundled daemon` | pip 装的是 sdist（你的平台没有 wheel，或用了 `--no-binary`）。在支持的平台上用 `pip install --only-binary=:all: cteno-sdk`，或设置 `CTENO_SDK_DAEMON_PATH`。 |
| `The bundled Cteno daemon exited during startup` / `failed to start: CTENO_DAEMON_FATAL …` | 报错开头是 daemon 自己打印的致命错误行和本次启动的错误行，后面附 `logs/daemon.log` 的末尾。Linux 上出现 `GLIBC_2.34 not found`，说明发行版太老。 |
| `daemon home too long: socket path … is N bytes, max M`（`CONFIG`） | daemon 的 Unix socket 在 `<home>/run/host.host.sock`，系统限制路径长度（macOS 103 字节、Linux 107 字节）。换一个更短的 `home` / `CTENO_SDK_HOME`。这个错误在启动任何进程之前就会报出。 |
| `configureModel()` 拒绝 `baseUrl` | 错误信息里有实际将请求的 URL。按上面的表格填含版本号的 API 根地址。 |
| `result.ok` 为 false，报模型、鉴权或额度错误 | `error` 是厂商的原始回复，并写明实际请求的 URL。检查 `baseUrl`、`model`、`apiKey`、`apiFormat`，再调一次 `configureModel()`（相同 `id` 会覆盖）。`listProfiles()` 能看到已配置的。 |
| 工具调用被拒绝："No approver is attached …" | 非只读工具默认就是这样。传 `canUseTool`，或选一个 `permissionMode`（见[权限](#权限哪些操作不用批准)）。 |
| socket 上报 `EACCES` / permission denied | 这个目录的 daemon 是别的系统用户启动的。换成同一个用户，或用你自己的 `CTENO_SDK_HOME`。 |
| 在 Cteno 桌面 App 里看不到 SDK 建的会话 | SDK 用的是自己的 daemon，会话不在 App 里。想用 App 的 daemon，就传 App 的 `socketPath`。 |
| 运行示例时报 `Cannot find package '@cteno/sdk'` | 在 `examples/node` 里先 `npm install` 再运行，或把示例复制到你自己的项目里。 |
| 打印出来全是 JSON | 你打印了所有 `assistant` 帧，按上手示例那样按 `kind` 过滤。 |

## 兼容性

| SDK | 自带 daemon | 有自带 daemon 的平台 |
|---|---|---|
| 2.10.15 | Cteno 2.10.15 | macOS arm64 / x64、Linux x64（glibc ≥ 2.34）、Windows x64 |
| 2.10.14 | Cteno 2.10.14 | macOS arm64 / x64、Linux x64（glibc ≥ 2.34）、Windows x64 |
| 2.10.13 | Cteno 2.10.12 | macOS arm64 / x64、Linux x64（glibc ≥ 2.34）、Windows x64 |
| 2.10.12（未发布） | Cteno 2.10.12 | – |
| 2.10.11（未发布） | Cteno 2.10.11 | – |
| 0.2.0（未发布） | Cteno 2.10.10 | – |
| 0.1.x | 无，需要运行中的 Cteno App 或 `cteno-host-cli serve` ≥ 2.10.9 | – |

用 `socketPath` 连其他 daemon 时：会话、流式输出、历史、trace、hook 需要 ≥ 2.10.9；自定义 Agent（`spec` / `AgentSpec`）需要 ≥ 2.10.10。

| 平台 | 测试情况 |
|---|---|
| Linux x64 | 在没装过 Cteno、没有账号的干净容器里，从 npm 包和 wheel 安装 |
| macOS arm64 | 与运行中的 Cteno 桌面 App 并存 |
| Windows x64 | 从 npm 包和 wheel 安装 |
| macOS x64 | npm tarball 与 wheel 安装（Apple 芯片上经 Rosetta） |
| Linux arm64 | 暂不支持（没有 daemon 包） |

## 已知限制

- **暂不支持浏览器自动化。** 自带的 daemon 不含浏览器引擎（有几百 MB），浏览器类工具会报引擎缺失。之后计划按需下载。
- 只能同一台机器、同一个系统用户。远程使用要走 Node 的 Socket.IO 适配器，连接由你自己鉴权。
- **daemon 会比你的进程活得久。** 这是有意为之（见[自带的 daemon](#自带的-daemon)）；需要它退出时（比如 CI 任务结束）调用 `stopDaemon()`。
- Cteno 2.10.x 的 `trace()` 里，工具调用和工具结果的类型显示为 `assistant_message`。要看用了哪些工具，请看 `run()` 返回的 `toolCalls`，或流式帧的 `kind`。
- `listSessions()` 返回你所连 daemon 的全部会话，包括同一用户、同一目录下其他 SDK 进程创建的会话。

## 参与贡献

欢迎提 PR。本仓库是发布快照：SDK 和 Cteno daemon 一起在私有上游仓库开发。PR 被接受后，维护者会在上游合入改动并署名
`Co-authored-by` 给你，下次导出时同步回这里，然后关闭 PR 并附上对应提交的链接，不会在本仓库直接合并。
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

SDK 客户端代码是 [MIT](LICENSE)。平台包（`@cteno/sdk-<平台>`、wheel 里的 `cteno_sdk/_bin`）中的 daemon 二进制不适用 MIT，条款见各平台包内附带的 `LICENSE.daemon`。
