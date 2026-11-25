# TokenBar — Z.ai/GLM Coding Plan + DeepSeek 用量菜单栏插件（原型）

在系统菜单栏/顶栏显示两路用量：

- **Z.ai（GLM Coding Plan）**：Coding Plan 5h/周窗口百分比，以及账户级 API 用量
  （覆盖所有 agent——其他 agent 用同一账号消耗的用量都算在内）。
- **DeepSeek（充值余额制）**：钱包剩余预算（美金额度实时显示，<\$10 红、<\$25 橙、其余绿），
  峰/谷价实时状态（🔥 峰价 / ❄️ 谷价）与今日 / 近 7 天按模型消耗金额。

菜单栏标题：`🔥44% · 19% · ❄️ $49.91`——首图标为 **GLM 峰时状态**
（🔥 峰时 / ❄️ 闲时，按 **北京时间 工作日 14:00–18:00** 判定，峰时 2x 计费），
百分比按红黄绿着色；DeepSeek 段为 **DS 峰谷价状态 + 剩余预算**
（🔥/❄️ 按 DeepSeek 官方峰谷窗口，预算按余额着色）。
点击展开下拉面板：GLM 峰时状态、窗口百分比（仅数字）+ 重置倒计时、
今日 / 近 7 天按模型用量（GLM + DeepSeek 合并一个列表，用了哪些列哪些；
有真实计费的模型在括号里附约多少美金，如 deepseek-flash 2.49M（约 $0.09））、
DeepSeek 余额与峰谷时段（折算美西时间）、立即刷新。

## 平台

| 平台 | 路径 | 形态 | 构建/运行 |
|---|---|---|---|
| macOS | [`macos/`](macos/) | 菜单栏 AppKit 应用（Swift 单文件） | `swiftc -O -o TokenBar main.swift && ./TokenBar` |
| Linux (GNOME) | [`linux/`](linux/) | GNOME Shell 扩展（GJS） | 见 [linux/README.md](linux/README.md) |

DeepSeek 维度目前仅 Linux 版实现（macOS 版尚未同步）。

## 数据来源

### Z.ai / GLM

`GET https://api.z.ai/api/monitor/usage/...`（与 ZCode 客户端 / z.ai 官网控制台同款接口，账户级统计）

- `GET /api/monitor/usage/quota/limit` → Coding Plan 5h/周窗口百分比 + 重置时间
- `GET /api/monitor/usage/model-usage?startTime=…&endTime=…` → 账户级用量
  - 时间参数格式 `yyyy-MM-dd HH:mm:ss`（本地时区），今日与近 7 天各查一次
- 请求头 `authorization` 直接传 key（不加 Bearer 前缀）
- 每 5 分钟自动刷新，打开菜单也会刷新
- 接口不可用时显示模拟数据（面板标题标注），便于纯 UI 评审

### DeepSeek

`GET https://platform.deepseek.com/api/v0/...`（与 DeepSeek 平台官网 / DeepSeek Harness 同源，余额制）

- `GET /api/v0/users/get_user_summary` → 钱包余额（充值钱包 + 赠送钱包合并，单位随钱包币种，本机为 USD）
- `GET /api/v0/usage/by_api_key/cost?start=<sec>&end=<sec>&tz=<偏移秒>` → 按模型消耗金额（今日 / 近 7 天各查一次；`start/end` 必须对齐本地日界，`tz` 传本地偏移的整小时部分）
- `GET /api/v0/usage/by_api_key/amount?…` → 按模型 token（cache hit/miss + response）与请求次数
- 请求头 `x-dsh-auth-token` 传 DeepSeek Harness 的平台 token
- 峰谷价（官方定价）：🔥 峰价 = UTC 周一至五 01:00–04:00、06:00–10:00；其余 ❄️ 谷价半价
  （周末、中国法定节假日全天谷价；节假日日历未内置，节假日会短暂显示为峰价）。面板中折算成美西时间显示。
- 余额 <\$10 红、<\$25 橙、其余绿；接口失败只标注不造假

API key 的存放位置各平台不同，见各平台 README。
