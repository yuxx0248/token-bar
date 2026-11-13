# TokenBar — Z.ai / GLM Coding Plan 用量菜单栏插件（原型）

在系统菜单栏/顶栏显示 **Z.ai 账户用量**：Coding Plan 5h/周窗口百分比，
以及账户级 API 用量（覆盖所有 agent——其他 agent 用同一账号消耗的用量都算在内）。

菜单栏标题：`⚡5h% · wk%`（按百分比红黄绿着色）。
点击展开下拉面板：今日 / 近 7 天总用量与调用次数、按模型明细（GLM-5.3、Flash…）、
今日逐小时用量走势（字符走势图）、窗口进度条 + 重置倒计时、立即刷新。

## 平台

| 平台 | 路径 | 形态 | 构建/运行 |
|---|---|---|---|
| macOS | [`macos/`](macos/) | 菜单栏 AppKit 应用（Swift 单文件） | `swiftc -O -o TokenBar main.swift && ./TokenBar` |
| Linux (GNOME) | [`linux/`](linux/) | GNOME Shell 扩展（GJS） | 见 [linux/README.md](linux/README.md) |

## 数据来源

`GET https://api.z.ai/api/monitor/usage/...`（与 ZCode 客户端 / z.ai 官网控制台同款接口，账户级统计）

- `GET /api/monitor/usage/quota/limit` → Coding Plan 5h/周窗口百分比 + 重置时间
- `GET /api/monitor/usage/model-usage?startTime=…&endTime=…` → 账户级用量
  - 时间参数格式 `yyyy-MM-dd HH:mm:ss`（本地时区），今日与近 7 天各查一次
- 请求头 `authorization` 直接传 key（不加 Bearer 前缀）
- 每 5 分钟自动刷新，打开菜单也会刷新
- 接口不可用时显示模拟数据（面板标题标注），便于纯 UI 评审

API key 的存放位置各平台不同，见各平台 README。
