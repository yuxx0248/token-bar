# TokenBar — 菜单栏 Z.ai API 用量插件（原型 v3）

macOS 菜单栏（右上角）小插件，显示 **Z.ai API 账户用量**（账户级、覆盖所有 agent，
不限于 ZCode——其他 agent 用同一个账号的 API key 消耗的用量都算在内）。

菜单栏标题：`API 87M`（今日 tokens，简写）。
点击展开下拉面板：今日 / 近 7 天总用量与调用次数、按模型明细（GLM-5.3、Flash…）、
今日逐小时用量走势（字符走势图）。

## 构建与运行

```bash
swiftc -O -o TokenBar main.swift
./TokenBar        # 退出：点菜单栏图标 → 退出 TokenBar（或 ⌘Q）
```

## 数据来源

`GET https://api.z.ai/api/monitor/usage/model-usage?startTime=…&endTime=…`

- 与 ZCode 客户端 / z.ai 官网控制台同款接口，账户级统计
- API key 自动从 `~/.zcode/v2/config.json`（`builtin:zai-coding-plan` → options.apiKey）读取
- 请求头 `authorization` 直接传 key（不加 Bearer 前缀）
- 时间参数格式 `yyyy-MM-dd HH:mm:ss`（本地时区），今日与近 7 天各查一次
- 每 5 分钟自动刷新，点开菜单或「立即刷新」也会拉取
- 接口不可用时显示模拟数据（面板标题会标注），便于纯 UI 评审（`TOKENBAR_MOCK=1` 同效）

## 与 Coding Plan 窗口的关系

之前版本显示的 5h/周窗口是 **Coding Plan** 配额（`/api/monitor/usage/quota/limit`），
本版本已改为 **API 账户总用量**（用户主要需求：其他 agent 也在消耗同一账号）。
如需两者并存，把 quota 接口的解析加回来即可（代码历史里有实现）。

## 已知简化（原型阶段）

- 官方未提供余额/费用端点（客户端代码里没有），只能显示用量，不能显示剩余额度
- 每次刷新串行两个 HTTP 请求；走势图按「今日」逐小时，7 天未做按天走势
- key 读取只支持 zai-coding-plan 一个 provider，多 key 账户未处理
