# 跨服务器继续本项目的 Codex 对话

这里保存 **5 份脱敏后的主要会话快照**，共 242 条用户消息、1680 条助手消息；gzip 总大小 839,744 字节。后台服务版本提示会话已从本包移除。新机可直接合并到默认 `$HOME/.codex`，沿用该目录已有的登录与配置。已在旧独立目录中续聊的用户，请用下方 `merge-home` 迁移本机实际记录。

这是按本机 Codex CLI 0.169.0 实测的文件迁移方式，不是官方云同步或 import 命令。原件来自本机 `~/.codex/sessions`，元数据标记 `source=vscode`、`originator=codex-tui`、创建版本 0.166.0；本次没有发现 `source=cli` 的项目主要会话，不把当前聊天冒称另一份 CLI 原生记录。

快照截止 **2026-11-15 22:06:59（北京时间，14:06:59 UTC）**。每份来源读取范围先固定为当时字节大小，仅导出完整 JSON 行；活跃会话之后的消息与本次导出过程不在包中，也没有未来自动同步任务。最早会话创建于 2026-11-01，最晚有效会话创建于 2026-11-08，最新保留记录为 2026-11-15 22:06:34（北京时间）。完整 ID、日期、大小、SHA-256 和各项删减计数见 [manifest.json](manifest.json)。

## 会话名称

下列名称逐字来自本机 Codex 的会话名称，已核对 `session_index.thread_name` 与本机数据库的 `name` 字段。导入时只为缺名的这五个 ID 补名，目标已有的本机名称保留，不复制账号的完整索引或数据库；五份 gzip 的脱敏消息内容保持不变。

| 会话 ID | 名称 |
| --- | --- |
| `01a194c3-bc92-7c51-b1eb-eac9e36e5642` | 整理毕业设计内容 |
| `01a19a55-460a-7741-bfbf-1c55336e8f21` | 推荐云服务器厂商 |
| `01a19b72-100e-7760-b895-a34fc0595848` | 记住T1智能体开发规范 |
| `01a1a21b-c6d6-7621-911a-5ce142946461` | 实现医学答案抽取打印页面 |
| `01a1bbee-5106-7a71-beb3-1bc8916acebd` | 绑定仓库并上传代码 |

名称的核对时间另记于 manifest；会话内容截止日期仍为上述固定快照日期。

## 在另一台服务器恢复

先安装可用的 Codex CLI 与 Python 3（脚本仅用标准库，面向 Linux）。**运行导入前退出 Codex，并停止使用目标 home 的 Codex/app-server 等后台服务。** 然后在新服务器的普通 shell 中执行：

若默认 home 已有 Codex 后台 daemon，先运行 `CODEX_HOME="$HOME/.codex" codex app-server daemon stop`；若停止命令报错，先停下处理，不继续导入。全新机器没有后台服务时无需执行此步。此命令见官方[停止后台 daemon 说明](https://learn.chatgpt.com/docs/environments/network-file-systems.md)，本机 CLI 0.169.0 的 `--help` 已确认支持。

```bash
git clone https://github.com/PeiliangCai/t1-agent.git
cd t1-agent
project_root="$(pwd -P)"

python3 code/scripts/codex-history.py restore --merge --project-root "$project_root" &&
unset CODEX_HOME &&
codex resume --all -C "$project_root" 01a1bbee-5106-7a71-beb3-1bc8916acebd
```

这一条 `restore --merge` 命令会先校验包内 SHA-256 与完整记录，再导入五份快照；不需要另跑 `verify`。默认目标固定为 `$HOME/.codex`，不会跟随 shell 遗留的带后缀 `CODEX_HOME`，也不建立第二套 Codex home。`unset CODEX_HOME` 让随后启动的 CLI 使用同一个默认目录。该默认目录已登录时直接沿用；尚未登录时才先执行 `codex login`。

若以前在 `~/.bashrc`、`~/.profile` 或 `~/.zshrc` 写过指向日期目录的 `export CODEX_HOME=...`，请移除对应旧设置，避免新终端再次切回旧目录；导入脚本不会修改这些启动文件。

`--project-root` 只按新项目路径改写快照的 `session_meta.cwd`，消息正文里的旧路径保留。新服务器需要有可用的模型/provider 配置；包中记录的 provider 是 `openai`。若遇到 `modelProviderMismatch` 或其他版本差异，请核对新机配置和 CLI 版本。应用运行配置与真实 `.env` 也需在新机自行准备。

本项目长期工程对话另一个主要会话为：

```bash
codex resume --all -C "$project_root" 01a19b72-100e-7760-b895-a34fc0595848
```

## 已有独立目录的迁移

若以前恢复到 `.codex-t1-agent-20261115` 或 `.codex-t1-agent-20261117` 并继续过对话，**请选实际包含最新续聊的源目录**。两个目录都存在时，先在各自的 Codex 会话中核对历史；不要根据目录日期或文件 mtime 自动选胜者。以下示例假设已确认最新记录在 `20261115`；若在 `20261117`，只修改 `source_home` 那一行。

退出使用源、目标 home 的所有 Codex，再在项目根目录执行。下面两条 `daemon stop` 分别停止源与默认目标的后台服务；任何一条报错都先停下处理，不继续合并。命令使用 `&&`，前一步失败时不会自动执行后续步骤：

```bash
git pull
source_home="$HOME/.codex-t1-agent-20261115"

CODEX_HOME="$source_home" codex app-server daemon stop &&
CODEX_HOME="$HOME/.codex" codex app-server daemon stop &&
python3 code/scripts/codex-history.py merge-home --source-home "$source_home" &&
unset CODEX_HOME &&
codex resume --all -C "$PWD"
```

`merge-home` 直接读取源目录 `sessions/` 与 `archived_sessions/` 中当前五个项目 ID 的真实 JSONL，逐字节复制它们及源索引中对应的最新名称，保留 11 月 15 日之后的续聊。它不拿仓库旧快照覆盖本地续聊，也不改写正文或 `session_meta.cwd`；`codex resume -C "$PWD"` 用于指定当前项目路径。目标已有名称保留；源缺名时用本包名称补齐。源缺少部分项目 ID 时会在结果的 `missing_project_ids` 中列出；五个全无则停止。

**本命令只迁移上述五个 ID，不是整个账号迁移。** 源中的其他 ID（包括旧版第六份后台服务会话、你后来另开的新对话）会列在 `not_imported_session_ids` 与 `not_imported_session_count` 中，仍只存在于原目录。旧目录不会被修改或删除；完成后先核对默认目录中的最新历史、未导入 ID 与冲突提示，继续保留旧目录，不要据此直接删除它。默认 home 已登录时无需重复登录。

## 合并边界与冲突

- 写入前检查全部选中记录、目标路径与名称索引。新 ID 才新增文件；同 ID、同内容即使位于不同文件名或归档目录也跳过，缺名才补名。本机已经改过的名称始终保留。
- 同 ID 内容不同（包括两边各有续聊、只有一边有追加，或快照 cwd 与已导入文件不同）时，整次导入在写文件前停止，报告 ID 和冲突路径。请保留两边并核对历史；脚本不拼接对话、不按 mtime 选胜者、不覆盖、不要求另建 home 或删除数据库。
- 跨 `sessions/`、`archived_sessions/` 和不同文件名的重复 metadata ID 会被拒绝，不能借换路径重复导入。源与目标 home 不能相同或互相嵌套；home 本身、会话树和索引中的符号链接会被拒绝。
- 本地源会检查选中 JSONL 的每一条记录、结尾换行与读取稳定性；不完整 JSONL、损坏或缺尾换行的索引、预检期间发现的并发变化都会停止。写入采用不跟随符号链接的路径访问与独占创建，已有会话不被覆盖。仍须先退出 Codex/停后台服务；这不是运行中数据库的事务快照，写入中途遇到 I/O 错误或外部并发操作时可能留下本次已新增的文件，排除原因后重跑会跳过相同内容。
- 两种命令都只写选中会话文件与 `session_index.jsonl` 中缺失的对应名称，不复制或改写 `auth.json`、`config.toml`、SQLite、全局 history、日志、插件、skills、socket 或权限/审批配置；源内容不外发。目标无关会话与索引原有字节保留。没有目标目录时仅建立所需的会话目录与名称索引，新文件为 0600、新目录为 0700（受 umask 约束）。

`restore --merge` 与 `merge-home` 都可显式使用 `--codex-home PATH` 指定目标，但本页默认流程统一使用 `$HOME/.codex`。原有 `restore --codex-home PATH` **不带 `--merge` 时仍拒绝默认目录及环境指定的活动目录**，仅保留为独立目标的兼容入口；不推荐用新建带日期目录处理冲突。

## 保存与省略的内容

保留用户与助手可见的普通消息、commentary/final 消息、会话 ID/日期/cwd、必要的工具调用名称和 call/result 绑定。工具输入与输出均换成明确的省略占位；固定快照中有 2 个调用尚无结果，补了占位结果，未假装它们执行成功。

删除 system/developer 消息、运行时 AGENTS/环境注入、base instructions、工具定义、隐藏/加密 reasoning、analysis 通道、compacted 内部总结、world state、turn context、运行配置、账号标识和跨 agent 消息。93 份 subagent 会话、14 份没有可见消息的主要会话以及其他项目没有导出。

导出副本在内存中对真实 `.env`/环境变量/auth 中的凭证值做精确替换，并检查已知 token、私钥、JWT、Bearer 和含凭证 URL 模式；本次保留的可见文本未命中这些凭证，主要风险载荷随工具内容和内部记录整体省略。脱敏不等于完整原会话，也不能保证涵盖所有未知格式的敏感内容。保留的可见对话会随公开仓库公开。

为兼容本机 CLI 的历史展示，副本使用 `history_mode=legacy`，并从同一份已脱敏可见消息合成 `user_message`/`agent_message` 展示事件；`response_item` 仍保存可见上下文，展示事件不是额外对话。原始 `~/.codex` 与原会话没有改写。

## 验证范围与手动续接

[validation.json](validation.json) 记录本机隔离目录实测结果：默认 home 合并、已有续聊原样迁移、标题与账号文件保全、跨路径 ID 冲突、损坏 JSONL/索引、符号链接及并发变化等边界检查通过。账号文件与数据库字节保全在启动 CLI 前断言，避免把 CLI 自己更新状态混为导入脚本修改。CLI 0.169.0 从隔离的 `restore --merge` 默认目录执行 `thread/list` 与 `thread/read`，返回上述五个名称，`thread/read(includeTurns=true)` 返回的用户/助手数量与导出消息一致；最新会话的 `thread/resume(excludeTurns=false)` 返回 3 条用户与 21 条助手消息。最初的新式展示事件返回空 items，改成上述旧式展示事件后恢复；该旧 store 的 `thread/items/list` 明确不支持。

测试没有发送 `turn/start`，没有运行模型或调用付费模型 API。所有 HOME/XDG 与测试会话位于 `code/runtime-data/` 的隔离目录，只用脱敏包和合成夹具，不读取真实 Codex home；CLI 测试 home 不含认证/配置，强制使用文件凭证存储，代理指向本机不可连接端口。CLI 在 `thread/resume` 时仍尝试后台 Responses WebSocket 预热并报告连接失败，历史读取与名称检查均通过。验证的是本机文件迁移后的识别与历史读取；尚未在另一服务器执行实际模型续聊，也没有迁移原服务端状态、子 agent、shell 或认证。快照省略的工具结果不会恢复；`merge-home` 则原样保留本地文件已有的记录。续聊时会使用新机当前的规则、工具与配置。

若新版本 CLI 无法恢复，可直接阅读压缩 JSONL，或生成可读文本，再把相关内容交给新对话作为历史背景：

```bash
python3 code/scripts/codex-history.py transcript \
  --session 01a1bbee-5106-7a71-beb3-1bc8916acebd
```

需要复查恢复边界与本地读取时执行以下命令；临时恢复目录在 `code/runtime-data/`，结束后自动清理：

```bash
python3 code/codex-history/tests/check.py
```

官方依据（OpenAI Docs）：[CLI resume](https://learn.chatgpt.com/docs/cli/reference#codex-resume) 说明可按本机保存的会话 ID 继续，`--all` 可跨 cwd 查找，显式 `-C` 指定续聊目录；[环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables) 说明 `CODEX_HOME` 默认 `~/.codex`，并包含认证、配置和会话等状态；[排障目录说明](https://learn.chatgpt.com/docs/reference/troubleshooting) 列出 `sessions` 与 `archived_sessions`。这些说明没有保证 Git clone 即可恢复，也没有保证脱敏后历史等价于原会话；本仓库合并逻辑由上述本地隔离实测验证。
