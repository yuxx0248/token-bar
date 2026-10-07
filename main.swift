//
//  TokenBar — macOS 菜单栏 Z.ai 用量插件（原型）
//  build: swiftc -O -o TokenBar main.swift
//  run:   ./TokenBar
//
//  数据源（均为官方接口，与 ZCode 客户端 / z.ai 官网同款；key 自动读取
//  ~/.zcode/v2/config.json，authorization 头直接传 key）：
//  1. GET /api/monitor/usage/quota/limit        → Coding Plan 5h/周窗口百分比+重置时间
//  2. GET /api/monitor/usage/model-usage?...     → 账户级 API 用量（含所有 agent）
//

import AppKit
import Foundation

// MARK: - Helpers

func fmtTokens(_ n: Int) -> String {
    let d = Double(n)
    if d >= 1e9 { return String(format: "%.2fB", d / 1e9) }
    if d >= 1e6 { return String(format: "%.2fM", d / 1e6) }
    if d >= 1e3 { return String(format: "%.1fK", d / 1e3) }
    return "\(n)"
}

func fmtCalls(_ n: Int) -> String {
    n >= 10000 ? String(format: "%.1f万", Double(n) / 10000) : "\(n)"
}

let clockFmt: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "HH:mm"
    return f
}()

let dayFmt: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "M/d"
    return f
}()

let fullTimeFmt: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "M/d HH:mm"
    return f
}()

let paramFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f
}()

func fmtDuration(_ ti: TimeInterval) -> String {
    let s = max(0, Int(ti))
    let h = s / 3600
    if h >= 24 { return "\(h / 24)d \(h % 24)h" }
    if h >= 1 { return "\(h)h \(s % 3600 / 60)m" }
    if s >= 60 { return "\(s / 60)m" }
    return "\(s)s"
}

func pctColor(_ p: Int) -> NSColor {
    p >= 90 ? .systemRed : p >= 70 ? .systemYellow : .systemGreen
}

func sparkline(_ values: [Int]) -> String {
    let blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
    let mx = max(1, values.max() ?? 1)
    return values.map { blocks[max(0, min(7, Int(Double($0) / Double(mx) * 7)))] }.joined()
}

// MARK: - Model

struct ModelUsage {
    var totalTokens = 0
    var totalCalls = 0
    var models: [(name: String, tokens: Int)] = []
    var hourly: [Int] = []
    var loaded = false
}

struct QuotaWindows {
    var loaded = false
    var level: String?
    var fiveHourPct = 0
    var fiveHourReset: Date?
    var weekPct = 0
    var weekReset: Date?
}

struct UsageSnapshot {
    var quota = QuotaWindows()
    var today = ModelUsage()
    var week = ModelUsage()
    var source = "加载中…"
    var lastRefresh: Date?
}

// MARK: - Usage monitor

final class UsageMonitor {
    private(set) var snapshot = UsageSnapshot()
    private let queue = DispatchQueue(label: "tokenbar.monitor", qos: .utility)

    private func apiKey() -> String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".zcode/v2/config.json").path
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let provider = obj["provider"] as? [String: Any],
              let plan = provider["builtin:zai-coding-plan"] as? [String: Any],
              let options = plan["options"] as? [String: Any],
              let key = options["apiKey"] as? String, !key.isEmpty
        else { return nil }
        return key
    }

    /// GET JSON，authorization 头直接传完整 key（不加 Bearer）
    private func getJSON(path: String, query: [URLQueryItem]?, key: String) -> [String: Any]? {
        var comp = URLComponents(url: URL(string: "https://api.z.ai" + path)!,
                                 resolvingAgainstBaseURL: false)!
        comp.queryItems = query
        var req = URLRequest(url: comp.url!, timeoutInterval: 12)
        req.setValue(key, forHTTPHeaderField: "authorization")
        var result: [String: Any]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["success"] as? Bool) == true
            else { return }
            result = obj
        }.resume()
        sem.wait()
        return result
    }

    /// Coding Plan 5h/周窗口
    private func fetchQuota(key: String) -> QuotaWindows {
        guard let obj = getJSON(path: "/api/monitor/usage/quota/limit", query: nil, key: key),
              let d = obj["data"] as? [String: Any],
              let limits = d["limits"] as? [[String: Any]]
        else { return QuotaWindows() }
        var q = QuotaWindows()
        q.loaded = true
        q.level = d["level"] as? String
        var tokenLimits: [(reset: Date, pct: Int)] = []
        for l in limits {
            guard let type = l["type"] as? String else { continue }
            if type == "TOKENS_LIMIT",
               let pct = l["percentage"] as? Int,
               let ms = l["nextResetTime"] as? Double {
                tokenLimits.append((Date(timeIntervalSince1970: ms / 1000), pct))
            }
        }
        // 按重置时间排序：最近重置的是 5h 窗口，最远的是周窗口
        tokenLimits.sort { $0.reset < $1.reset }
        if let first = tokenLimits.first {
            q.fiveHourPct = first.pct
            q.fiveHourReset = first.reset
        }
        if tokenLimits.count > 1, let last = tokenLimits.last {
            q.weekPct = last.pct
            q.weekReset = last.reset
        }
        return q
    }

    /// 账户级 API 用量（model-usage，时间格式 yyyy-MM-dd HH:mm:ss 本地时区）
    private func fetchUsage(key: String, start: Date, end: Date) -> ModelUsage {
        guard let obj = getJSON(path: "/api/monitor/usage/model-usage", query: [
                URLQueryItem(name: "startTime", value: paramFmt.string(from: start)),
                URLQueryItem(name: "endTime", value: paramFmt.string(from: end)),
              ], key: key),
              let d = obj["data"] as? [String: Any],
              let total = d["totalUsage"] as? [String: Any],
              let tokens = total["totalTokensUsage"] as? Int,
              let calls = total["totalModelCallCount"] as? Int
        else { return ModelUsage() }
        var u = ModelUsage()
        u.loaded = true
        u.totalTokens = tokens
        u.totalCalls = calls
        if let models = total["modelSummaryList"] as? [[String: Any]] {
            u.models = models.compactMap { m in
                guard let name = m["modelName"] as? String,
                      let t = m["totalTokens"] as? Int else { return nil }
                return (name, t)
            }.sorted { $0.tokens > $1.tokens }
        }
        if let list = d["modelDataList"] as? [[String: Any]] {
            var hourly: [Int] = []
            for m in list {
                guard let series = m["tokensUsage"] as? [Int] else { continue }
                if hourly.count < series.count { hourly = [Int](repeating: 0, count: series.count) }
                for (i, v) in series.enumerated() { hourly[i] += v }
            }
            u.hourly = hourly
        }
        return u
    }

    private func mockSnapshot() -> UsageSnapshot {
        let t = Date().timeIntervalSince1970
        var s = UsageSnapshot()
        s.quota.loaded = true
        s.quota.level = "pro"
        s.quota.fiveHourPct = Int(30 + 35 * (0.5 + 0.5 * sin(t / 5000)))
        s.quota.fiveHourReset = Date().addingTimeInterval(3 * 3600)
        s.quota.weekPct = Int(78 + 12 * (0.5 + 0.5 * sin(t / 200000 + 3)))
        s.quota.weekReset = Date().addingTimeInterval(36 * 3600)
        for (scale, label) in [(1.0, "today"), (3.2, "week")] {
            var u = ModelUsage()
            u.loaded = true
            u.totalTokens = Int((60 + 30 * sin(t / 3600)) * 1e6 * scale)
            u.totalCalls = Int(2700 * scale)
            u.models = [("GLM-5.3", Int(Double(u.totalTokens) * 0.96)),
                        ("GLM-5.3-Flash", Int(Double(u.totalTokens) * 0.04))]
            u.hourly = (0..<24).map { _ in Int(2e6 * scale * Double.random(in: 0.3...1.0)) }
            if label == "today" { s.today = u } else { s.week = u }
        }
        s.source = "模拟数据"
        return s
    }

    func refresh(completion: @escaping () -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            var s = UsageSnapshot()
            let cal = Calendar.current
            let now = Date()
            let todayStart = cal.startOfDay(for: now)
            let todayEnd = cal.date(bySettingHour: 23, minute: 59, second: 59, of: now) ?? now
            let weekStart = cal.date(byAdding: .day, value: -6, to: todayStart) ?? todayStart

            if let key = self.apiKey() {
                s.quota = self.fetchQuota(key: key)
                s.today = self.fetchUsage(key: key, start: todayStart, end: todayEnd)
                s.week = self.fetchUsage(key: key, start: weekStart, end: todayEnd)
            }

            if !s.quota.loaded && !s.today.loaded {
                let mock = ProcessInfo.processInfo.environment["TOKENBAR_MOCK"] == nil
                    && self.apiKey() != nil
                s = mock ? mockSnapshot() : mockSnapshot()  // 接口失败也展示模拟数据便于看 UI
                s.source = ProcessInfo.processInfo.environment["TOKENBAR_MOCK"] == nil
                    ? "模拟数据（接口不可用）" : "模拟数据（TOKENBAR_MOCK）"
            } else {
                var parts: [String] = []
                if s.quota.loaded {
                    parts.append("GLM Coding " + (s.quota.level.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Plan"))
                }
                if s.today.loaded { parts.append("账户级 API") }
                s.source = "官方 · " + parts.joined(separator: " + ")
            }
            s.lastRefresh = now
            NSLog("TokenBar refresh: %@ 5h=%d%% week=%d%% today=%@/%d",
                  s.source, s.quota.fiveHourPct, s.quota.weekPct,
                  fmtTokens(s.today.totalTokens), s.today.totalCalls)
            let snap = s
            DispatchQueue.main.async {
                self.snapshot = snap
                completion()
            }
        }
    }
}

// MARK: - App delegate (menu bar UI)

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let monitor = UsageMonitor()
    private var dataTimer: Timer?
    private var renderTimer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        rebuildMenu()
        reload()

        dataTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.reload()
        }
        renderTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.renderTitle()
            self?.rebuildMenu()
        }
    }

    private func reload() {
        monitor.refresh { [weak self] in
            self?.renderTitle()
            self?.rebuildMenu()
        }
    }

    // MARK: 菜单栏标题：窗口百分比

    private func renderTitle() {
        guard let button = statusItem.button else { return }
        let s = monitor.snapshot
        let str = NSMutableAttributedString()
        str.append(NSAttributedString(string: "⚡", attributes: [
            .font: NSFont.systemFont(ofSize: 12),
        ]))
        str.append(NSAttributedString(string: "\(s.quota.fiveHourPct)%", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: pctColor(s.quota.fiveHourPct),
        ]))
        str.append(NSAttributedString(string: " · \(s.quota.weekPct)%", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: pctColor(s.quota.weekPct),
        ]))
        button.attributedTitle = str
        button.toolTip = """
        Coding Plan 窗口: 5h \(s.quota.fiveHourPct)% · 周 \(s.quota.weekPct)%
        API 今日: \(fmtTokens(s.today.totalTokens)) · 近7天 \(fmtTokens(s.week.totalTokens))
        数据来源: \(s.source)
        """
    }

    // MARK: 下拉菜单

    private func rebuildMenu() {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()
        let s = monitor.snapshot

        addTitle(menu, source: s.source)

        if s.quota.loaded {
            menu.addItem(.separator())
            addHeader(menu, "5 小时窗口（Coding Plan）")
            addProgress(menu, pct: s.quota.fiveHourPct)
            addDetail(menu, resetText(s.quota.fiveHourReset))

            menu.addItem(.separator())
            addHeader(menu, "周窗口（Coding Plan）")
            addProgress(menu, pct: s.quota.weekPct)
            addDetail(menu, resetText(s.quota.weekReset))
        }

        if s.today.loaded {
            menu.addItem(.separator())
            addHeader(menu, "今日 API 用量（账户级 · 含所有 agent）")
            addDetail(menu, "\(fmtTokens(s.today.totalTokens)) tokens · \(fmtCalls(s.today.totalCalls)) 次调用")
            for m in s.today.models.prefix(4) {
                addDetail(menu, "\(m.name)  \(fmtTokens(m.tokens))")
            }
            if !s.today.hourly.isEmpty {
                var hourly = s.today.hourly
                while hourly.last == 0 && hourly.count > 1 { hourly.removeLast() }
                addSpark(menu, sparkline(hourly))
            }
        }

        if s.week.loaded {
            menu.addItem(.separator())
            addHeader(menu, "近 7 天 API 用量")
            addDetail(menu, "\(fmtTokens(s.week.totalTokens)) tokens · \(fmtCalls(s.week.totalCalls)) 次调用")
            for m in s.week.models.prefix(4) {
                addDetail(menu, "\(m.name)  \(fmtTokens(m.tokens))")
            }
        }

        menu.addItem(.separator())
        if let last = s.lastRefresh {
            addDetail(menu, "更新于 \(clockFmt.string(from: last))，每 5 分钟自动刷新")
        }
        let refreshItem = NSMenuItem(title: "立即刷新", action: #selector(refreshNow(_:)), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)
        let quitItem = NSMenuItem(title: "退出 TokenBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)
    }

    private func resetText(_ date: Date?) -> String {
        guard let d = date else { return "—" }
        return "重置 \(fullTimeFmt.string(from: d))（约 \(fmtDuration(d.timeIntervalSinceNow)) 后）"
    }

    private func addTitle(_ menu: NSMenu, source: String) {
        let str = NSMutableAttributedString(string: "Z.ai 用量  ", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
        ])
        str.append(NSAttributedString(string: source, attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        let item = NSMenuItem()
        item.attributedTitle = str
        item.isEnabled = false
        menu.addItem(item)
    }

    private func addHeader(_ menu: NSMenu, _ text: String) {
        let item = NSMenuItem()
        item.attributedTitle = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        item.isEnabled = false
        menu.addItem(item)
    }

    private func addDetail(_ menu: NSMenu, _ text: String) {
        let item = NSMenuItem()
        item.attributedTitle = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
        ])
        item.isEnabled = false
        menu.addItem(item)
    }

    private func addSpark(_ menu: NSMenu, _ spark: String) {
        let item = NSMenuItem()
        item.attributedTitle = NSAttributedString(string: spark, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.systemTeal,
        ])
        item.isEnabled = false
        menu.addItem(item)
    }

    private func addProgress(_ menu: NSMenu, pct: Int) {
        let p = min(max(pct, 0), 100)
        let blocks = 14
        let filled = Int((Double(p) / 100 * Double(blocks)).rounded())
        let barFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

        let str = NSMutableAttributedString(string: String(repeating: "█", count: filled), attributes: [
            .font: barFont, .foregroundColor: pctColor(p),
        ])
        str.append(NSAttributedString(string: String(repeating: "░", count: blocks - filled), attributes: [
            .font: barFont, .foregroundColor: NSColor.tertiaryLabelColor,
        ]))
        str.append(NSAttributedString(string: String(format: "  %d%%", p), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
        ]))
        let item = NSMenuItem()
        item.attributedTitle = str
        item.isEnabled = false
        menu.addItem(item)
    }

    // MARK: actions

    @objc private func refreshNow(_ sender: Any?) {
        reload()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
        reload()
    }
}

// MARK: - Bootstrap

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
