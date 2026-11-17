# 跨服务器继续本项目的 Codex 对话

这里保存 **5 份脱敏后的主要会话快照**，共 242 条用户消息、1680 条助手消息；gzip 总大小 839,744 字节。后台服务版本提示会话已从本包移除。Git clone 后需先恢复到独立的 `CODEX_HOME`，再登录并选择会话。

这是按本机 Codex CLI 0.169.0 实测的文件迁移方式，不是官方云同步或 import 命令。原件来自本机 `~/.codex/sessions`，元数据标记 `source=vscode`、`originator=codex-tui`、创建版本 0.166.0；本次没有发现 `source=cli` 的项目主要会话，不把当前聊天冒称另一份 CLI 原生记录。

快照截止 **2026-11-15 22:06:59（北京时间，14:06:59 UTC）**。每份来源读取范围先固定为当时字节大小，仅导出完整 JSON 行；活跃会话之后的消息与本次导出过程不在包中，也没有未来自动同步任务。最早会话创建于 2026-11-01，最晚有效会话创建于 2026-11-08，最新保留记录为 2026-11-15 22:06:34（北京时间）。完整 ID、日期、大小、SHA-256 和各项删减计数见 [manifest.json](manifest.json)。

## 会话名称

下列名称逐字来自本机 Codex 的会话名称，已核对 `session_index.thread_name` 与本机数据库的 `name` 字段。恢复时只写入这五个名称，不复制账号的完整索引或数据库；五份 gzip 的脱敏消息内容保持不变。

| 会话 ID | 名称 |
| --- | --- |
| `01a194c3-bc92-7c51-b1eb-eac9e36e5642` | 整理毕业设计内容 |
| `01a19a55-460a-7741-bfbf-1c55336e8f21` | 推荐云服务器厂商 |
| `01a19b72-100e-7760-b895-a34fc0595848` | 记住T1智能体开发规范 |
| `01a1a21b-c6d6-7621-911a-5ce142946461` | 实现医学答案抽取打印页面 |
| `01a1bbee-5106-7a71-beb3-1bc8916acebd` | 绑定仓库并上传代码 |

名称的核对时间另记于 manifest；会话内容截止日期仍为上述固定快照日期。

## 在另一台服务器恢复

先安装可用的 Codex CLI 与 Python 3（仅使用标准库），在新服务器的普通 shell 中执行。以下示例使用尚未恢复过的新隔离目录：

```bash
git clone https://github.com/PeiliangCai/t1-agent.git
cd t1-agent
project_root="$(pwd -P)"
history_home="$HOME/.codex-t1-agent-20261115"

python3 code/scripts/codex-history.py verify
python3 code/scripts/codex-history.py restore \
  --codex-home "$history_home" \
  --project-root "$project_root"

export CODEX_HOME="$history_home"
codex login
codex resume --all -C "$project_root" 01a1bbee-5106-7a71-beb3-1bc8916acebd
```

**先 restore，再设置 `CODEX_HOME`。** 恢复工具拒绝写入默认 `~/.codex` 或当前环境指定的 `CODEX_HOME`；请使用新的独立目录。已恢复且内容相同的文件会跳过，已有不同会话内容或名称会令整次写入提前停止；不会覆盖已有会话，不会复制认证、配置、全局 history 或数据库，不会设置不安全的权限或审批模式。它只根据新的项目路径改写 `session_meta.cwd`，不替换消息文本里的旧路径，并向 `session_index.jsonl` 补入本包的五个名称，保留无关会话名称。

新服务器需自行登录并配置可用的模型/provider；包中记录的 provider 是 `openai`。若遇到 `modelProviderMismatch` 或其他版本差异，请核对新机配置和 CLI 版本。应用运行配置与真实 `.env` 也需在新机自行准备。

本项目长期工程对话另一个主要会话为：

```bash
codex resume --all -C "$project_root" 01a19b72-100e-7760-b895-a34fc0595848
```

## 已导入旧版会话

若已恢复过旧版 6 份会话，先在项目根目录更新仓库，再使用一个未用过的新目录恢复。旧目录保留原有对话和续聊内容；以下操作不会删除或覆盖它们：

```bash
git pull

python3 code/scripts/codex-history.py restore \
  --codex-home "$HOME/.codex-t1-agent-20261117" \
  --project-root "$PWD"

export CODEX_HOME="$HOME/.codex-t1-agent-20261117"
codex login
codex resume --all -C "$PWD"
```

若该新目录也已用过，请换一个未用过的目录名。新目录只显示本包的五份会话及其名称，内容仍截至 2026-11-15。旧目录之后产生的续聊内容不会自动合并；需要查看时可切回旧 `CODEX_HOME`。不要直接删除旧目录。

仅拉取仓库不会从已恢复的旧目录删除后台服务会话；本工具也不会删除账号原件或已有会话。重新恢复到旧目录最多只能为内容未变的五份会话补名，仍会保留旧服务会话，因此推荐上述新目录方式。

## 保存与省略的内容

保留用户与助手可见的普通消息、commentary/final 消息、会话 ID/日期/cwd、必要的工具调用名称和 call/result 绑定。工具输入与输出均换成明确的省略占位；固定快照中有 2 个调用尚无结果，补了占位结果，未假装它们执行成功。

删除 system/developer 消息、运行时 AGENTS/环境注入、base instructions、工具定义、隐藏/加密 reasoning、analysis 通道、compacted 内部总结、world state、turn context、运行配置、账号标识和跨 agent 消息。93 份 subagent 会话、14 份没有可见消息的主要会话以及其他项目没有导出。

导出副本在内存中对真实 `.env`/环境变量/auth 中的凭证值做精确替换，并检查已知 token、私钥、JWT、Bearer 和含凭证 URL 模式；本次保留的可见文本未命中这些凭证，主要风险载荷随工具内容和内部记录整体省略。脱敏不等于完整原会话，也不能保证涵盖所有未知格式的敏感内容。保留的可见对话会随公开仓库公开。

为兼容本机 CLI 的历史展示，副本使用 `history_mode=legacy`，并从同一份已脱敏可见消息合成 `user_message`/`agent_message` 展示事件；`response_item` 仍保存可见上下文，展示事件不是额外对话。原始 `~/.codex` 与原会话没有改写。

## 验证范围与手动续接

[validation.json](validation.json) 记录本机隔离目录实测结果：原有 7 项恢复边界检查及新增的名称索引检查通过；CLI 0.169.0 的 `thread/list` 与 `thread/read` 返回上述五个名称，`thread/read(includeTurns=true)` 返回的用户/助手数量与导出消息一致；最新会话的 `thread/resume(excludeTurns=false)` 返回 3 条用户与 21 条助手消息。最初的新式展示事件返回空 items，改成上述旧式展示事件后恢复；该旧 store 的 `thread/items/list` 明确不支持。

测试没有发送 `turn/start`，没有运行模型或调用付费模型 API。测试目录不含认证/配置，代理指向本机不可连接端口；CLI 在 `thread/resume` 时仍尝试后台 Responses WebSocket 预热并报告连接失败，历史读取与名称检查均通过。验证的是本机文件迁移后的识别与历史读取；尚未在另一服务器执行实际模型续聊，也没有迁移原服务端状态、子 agent、shell、工具结果或认证。续聊时会使用新机当前的规则、工具与配置。

若新版本 CLI 无法恢复，可直接阅读压缩 JSONL，或生成可读文本，再把相关内容交给新对话作为历史背景：

```bash
python3 code/scripts/codex-history.py transcript \
  --session 01a1bbee-5106-7a71-beb3-1bc8916acebd
```

需要复查恢复边界与本地读取时执行以下命令；临时恢复目录在 `code/runtime-data/`，结束后自动清理：

```bash
python3 code/codex-history/tests/check.py
```

官方依据：[CLI resume](https://learn.chatgpt.com/docs/cli/reference#codex-resume) 说明可按本机保存的会话 ID 继续，`--all` 可跨 cwd 查找；[配置和状态位置](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations) 说明 `CODEX_HOME` 默认 `~/.codex` 且认证/配置/history 分开存放；[App-server](https://learn.chatgpt.com/docs/app-server.md) 说明初始化、读取与恢复会话以及 `turn/start` 的区别。这些说明没有保证 Git clone 即可恢复，也没有保证脱敏后历史等价于原会话。
