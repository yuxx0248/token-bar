# TokenBar for Linux（GNOME Shell 扩展）

macOS 菜单栏版 TokenBar 的 Linux 移植：GNOME 顶栏右上角常驻 `⚡5h% · wk%`，
点击弹出完整面板（窗口进度 + 重置倒计时、今日 / 近 7 天用量、按模型明细、
逐小时走势、立即刷新）。数据接口与 macOS 版完全一致（见顶层 README）。

要求：GNOME Shell 45+（本机为 51）。无需任何额外依赖（Soup / St 均为 Shell 自带）。

## 安装

```bash
cd linux/gnome-shell
./install.sh --api-key <你的 Z.ai API key>   # 写 key + 装扩展
./install.sh                                  # 只装扩展（之后可自行补 key）
```

- 扩展装到 `~/.local/share/gnome-shell/extensions/tokenbar@zuohang/`
- **Wayland 下 GNOME Shell 只在启动时扫描扩展目录**，首次安装需要注销并重新登录
  一次；X11 会话可用 Alt+F2 → `r` 重启 Shell 代替
- 登录回来后 `gnome-extensions info tokenbar@zuohang` 应显示 State: ACTIVE

## API key

本机的 ZCode CLI 把凭证**加密**存放在 `~/.zcode/v2/credentials.json`，外部程序读不到
（macOS 版直接读 `~/.zcode/v2/config.json` 里的明文 key，Linux 上没有这个文件），
所以 Linux 版从独立配置读取，两个路径按顺序尝试：

1. `~/.config/tokenbar/config.json` → `{"apiKey": "..."}`
2. `~/.zcode/v2/config.json` → `provider.builtin:zai-coding-plan.options.apiKey`（macOS 版布局）

key 在 z.ai 控制台（api.z.ai → API Keys）获取，与 ZCode 客户端用的是同一账号的 key，
因此统计口径一致（账户级，含所有 agent）。`install.sh --api-key` 会写入第 1 个路径（0600）。

## 行为说明

- 每 5 分钟自动刷新；打开菜单超过 30s 未刷新也会拉一次
- 接口不可用（已有 key）→ 显示模拟数据，标题标注「模拟数据（接口不可用）」
- 未配置 key → 不显示假数据，顶栏显示 `–`，面板里给出配置说明
- `TOKENBAR_MOCK=1` 强制模拟数据（macOS 版同款）。GNOME 扩展跑在 gnome-shell 进程里，
  需要让该进程看到变量：写入 `~/.config/environment.d/tokenbar.conf`（`TOKENBAR_MOCK=1`）
  后重新登录

## 测试 / 卸载 / 排错

```bash
gjs -m test-lib.js    # lib.js 逻辑测试（格式化 / 解析 / URL），无 UI 无网络
./uninstall.sh        # 停用并删除扩展（Wayland 下重登后彻底生效）
journalctl --user -o cat -f /usr/bin/gnome-shell | grep -i tokenbar  # 运行日志
gsettings get org.gnome.shell disable-user-extensions  # 应为 false
```

与 macOS 版的差异：无菜单栏 tooltip（GNOME 不支持），「退出」换成了「禁用 TokenBar」
（可用扩展应用重新开启）；接口失败时与 macOS 一样回落到模拟数据。
