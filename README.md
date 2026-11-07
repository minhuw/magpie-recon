# 储备

magpie 窗口里的一页。不改 magpie 本身。只读两个文件：

- `usage.jsonl`：每次调用的时间、token、网关钥匙、订阅账号
- `quota-history.json`：每个账号每个窗口的剩余百分比、窗口起点、reset

额度历史是 JSON，不是 JSONL。magpie 写在配置目录里，和 `usage.jsonl` 放在一起（默认 `~/.config/magpie`，或 `$XDG_CONFIG_HOME/magpie`）。

## 安装

在要看的那台 magpie 上：

```sh
magpie plugin add github:minhuw/magpie-recon
```

在插件页打开它，侧边栏会出现「储备」。第一次打开会稍等，页面要等本机服务起来再跳过去。

配置目录不在默认位置时，插件行的 Options 写成：

```json
{ "port": 3478, "dir": "/你的/magpie配置目录" }
```

`dir` 要是绝对路径。空字符串表示用默认目录。环境变量 `MAGPIE_RESERVE_DIR` 同样是这个目录。

## 页面

主图按 Codex、Claude 分开显示当前剩余、预计耗尽时间和下一次 reset。每个供应商取所有账号当前窗口的平均剩余百分比；各账号分别按最近的额度变化速度外推、在零处截断，再合并成曲线。预测不会跨过 reset。

- 所有账号都在任何 reset 前耗尽：标出「全部额度」耗尽点和时间。
- 只有部分账号会耗尽：显示最早的单账号耗尽时间，不把它当成整个池耗尽。
- 先遇到 reset：标出 reset，并估算当时还剩多少。
- 读数不足或近期没有净消耗：不编造耗尽时间。

展开的「账号窗口」表格可检查单个账号的剩余、耗尽预测和 reset。

服务只听 `127.0.0.1`，并且核对 Host。页面跑在 magpie 的沙箱里，自己不能发请求，只能把框架导航到这个服务。
