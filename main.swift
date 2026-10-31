//
//  TokenBar — macOS 菜单栏 Z.ai 用量插件（原型）
//  build: swiftc -O -o TokenBar main.swift
//  run:   ./TokenBar
//
//  数据源（均为官方接口，与 ZCode 客户端 / z.ai 官网同款；key 自动读取
//  ~/.zcode/v2/config.json，authorization 头直接传 key）：
//  1. GET  /api/monitor/usage/quota/limit        → Coding Plan 5h/周窗口百分比+重置时间
//  2. GET  /api/monitor/usage/model-usage?...     → 账户级 API 用量（含所有 agent）
//  3. GET  /api/biz/customer-package-reset/list   → 重置卡余额（Reset Card）
//  4. POST /api/biz/customer-package-reset/use    → 使用重置卡（立即恢复对应额度）
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

extension NSImage {
    /// 位图重绘着色（lockFocus 在 macOS 14 才标废弃，原型阶段可用）
    func tinted(with color: NSColor) -> NSImage {
        let img = NSImage(size: size)
        img.lockFocus()
        draw(in: NSRect(origin: .zero, size: size))
        color.set()
        NSRect(origin: .zero, size: size).fill(using: .sourceAtop)
        img.unlockFocus()
        return img
    }
}

// MARK: - Peak 时段（官方定义：周一至周五 14:00–18:00 UTC+8）

enum PeakState { case peak, offPeak, promoOffPeak }

struct PeakStatus {
    var state = PeakState.offPeak
    var localWindowText = ""   // 换算到本机时区的时段，如「周一至周五 14:00–18:00」
    var nextChange: Date?     // 状态下次切换：peak 结束 / 下个 peak 开始 / 促销结束
    var note: String?         // 促销期备注
}

/// 规则集中在这里，官方调整时段/促销时只改这一处
enum PeakPolicy {
    static let tz = TimeZone(identifier: "Asia/Singapore")!   // UTC+8，无夏令时
    static let startHour = 14
    static let endHour = 18
    static let weekdays: Set<Int> = [2, 3, 4, 5, 6]           // Calendar.weekday：1=周日
    static let rateNote = "计费：off-peak GLM-5.3 1× · Flash 0.4× ｜ peak 3× · 1.2×"

    // 全天 off-peak 的促销覆盖期（SGT 挂钟时间，start 含 / end 不含）
    static let promos: [(start: Date, end: Date, note: String)] = [
        (date("2026-09-25 00:00"), date("2026-10-08 00:00"), "促销期：全天按 off-peak 计费"),
    ]

    static func date(_ s: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = tz
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: s)!
    }
}

/// 纯本地计算，不依赖网络；判定一律在 SGT 日历进行，本机时区/夏令时只影响展示文案
func evaluatePeak(now: Date = Date()) -> PeakStatus {
    var sgt = Calendar(identifier: .gregorian)
    sgt.timeZone = PeakPolicy.tz
    let c = sgt.dateComponents([.weekday, .hour], from: now)

    var p = PeakStatus()
    p.localWindowText = peakLocalWindowText(now: now, sgt: sgt)

    if let promo = PeakPolicy.promos.first(where: { now >= $0.start && now < $0.end }) {
        p.state = .promoOffPeak
        p.nextChange = promo.end
        p.note = promo.note
        return p
    }

    func at(_ hour: Int, on day: Date) -> Date {
        var comps = sgt.dateComponents([.year, .month, .day], from: day)
        comps.hour = hour
        return sgt.date(from: comps)!
    }

    if PeakPolicy.weekdays.contains(c.weekday ?? 0),
       let hour = c.hour, hour >= PeakPolicy.startHour, hour < PeakPolicy.endHour {
        p.state = .peak
        p.nextChange = at(PeakPolicy.endHour, on: now)   // 今日 18:00 SGT
    } else {
        // 从今天起找下一个「工作日 14:00」，最多跨一个周末
        var day = sgt.startOfDay(for: now)
        for _ in 0..<8 {
            if PeakPolicy.weekdays.contains(sgt.component(.weekday, from: day)) {
                let start = at(PeakPolicy.startHour, on: day)
                if start > now {
                    p.nextChange = start
                    break
                }
            }
            day = sgt.date(byAdding: .day, value: 1, to: day)!
        }
    }
    return p
}

/// 官方时段换算到本机时区的描述；大偏移时区会跨午夜且星期平移（如美西 → 周日至周四 23:00–03:00）
func peakLocalWindowText(now: Date, sgt: Calendar) -> String {
    let wd = sgt.component(.weekday, from: now)
    let monday = sgt.date(byAdding: .day, value: wd >= 2 ? 2 - wd : -6, to: sgt.startOfDay(for: now))!

    let local = Calendar.current
    let wdNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    var patterns: [(days: [Int], start: String, end: String, cross: Bool)] = []

    for i in 0..<5 {
        let day = sgt.date(byAdding: .day, value: i, to: monday)!
        var comps = sgt.dateComponents([.year, .month, .day], from: day)
        comps.hour = PeakPolicy.startHour
        let s = sgt.date(from: comps)!
        comps.hour = PeakPolicy.endHour
        let e = sgt.date(from: comps)!

        let sc = local.dateComponents([.weekday, .hour, .minute], from: s)
        let ec = local.dateComponents([.hour, .minute], from: e)
        let start = String(format: "%02d:%02d", sc.hour ?? 0, sc.minute ?? 0)
        let end = String(format: "%02d:%02d", ec.hour ?? 0, ec.minute ?? 0)
        let cross = !local.isDate(e, inSameDayAs: s)

        if let idx = patterns.firstIndex(where: { $0.start == start && $0.end == end && $0.cross == cross }) {
            patterns[idx].days.append(sc.weekday ?? 0)
        } else {
            patterns.append((days: [sc.weekday ?? 0], start: start, end: end, cross: cross))
        }
    }

    func fmtDays(_ days: [Int]) -> String {
        var ranges: [[Int]] = []
        for d in days.sorted() where (1...7).contains(d) {
            if let idx = ranges.indices.last, ranges[idx].last! % 7 + 1 == d {
                ranges[idx].append(d)
            } else {
                ranges.append([d])
            }
        }
        return ranges.map {
            $0.count == 1 ? wdNames[$0.first! - 1] : "\(wdNames[$0.first! - 1])至\(wdNames[$0.last! - 1])"
        }.joined(separator: "、")
    }

    return patterns.map { "\(fmtDays($0.days)) \($0.start)–\($0.end)\($0.cross ? "（+1d）" : "")" }
        .joined(separator: " ｜ ")
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

/// 一张额度重置卡（官网订阅页同款能力，5 小时 / 周 两种）
struct ResetCard {
    var resetType = ""      // "FIVE_HOUR" | "WEEK"
    var recordId = 0
    var grantType = ""
    var expire: Date?
    var available = false
}

struct ResetCardState {
    var loaded = false
    var cards: [ResetCard] = []

    func availableCards(of type: String) -> [ResetCard] {
        cards.filter { $0.available && $0.resetType == type }
            .sorted { ($0.expire ?? .distantFuture) < ($1.expire ?? .distantFuture) }
    }

    var fiveHourCount: Int { availableCards(of: "FIVE_HOUR").count }
    var weekCount: Int { availableCards(of: "WEEK").count }
}

struct UsageSnapshot {
    var quota = QuotaWindows()
    var cards = ResetCardState()
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

    /// POST JSON（同款鉴权），返回 (是否成功, 服务器消息)
    @discardableResult
    private func postJSON(path: String, body: [String: Any], key: String) -> (ok: Bool, msg: String) {
        guard let url = URL(string: "https://api.z.ai" + path) else { return (false, "URL 无效") }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue(key, forHTTPHeaderField: "authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var result: (Bool, String) = (false, "请求失败")
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            let ok = (obj["success"] as? Bool) == true || (obj["code"] as? Int) == 200
            let msg = obj["msg"] as? String ?? (ok ? "成功" : "失败")
            result = (ok, msg)
        }.resume()
        sem.wait()
        return result
    }

    /// 重置卡余额（与官网订阅页「Usage Reset」卡片同款接口）
    private func fetchResetCards(key: String) -> ResetCardState {
        guard let obj = getJSON(path: "/api/biz/customer-package-reset/list", query: [
                URLQueryItem(name: "targetType", value: "PERSONAL"),
              ], key: key),
              let d = obj["data"] as? [String: Any]
        else { return ResetCardState() }
        var st = ResetCardState()
        st.loaded = true
        for (src, type) in [("fiveHourResets", "FIVE_HOUR"), ("weekResets", "WEEK")] {
            for r in d[src] as? [[String: Any]] ?? [] {
                var c = ResetCard()
                c.resetType = type
                c.recordId = (r["recordId"] as? Int) ?? Int(r["recordId"] as? String ?? "") ?? -1
                c.grantType = r["grantType"] as? String ?? ""
                c.available = r["available"] as? Bool ?? false
                if let e = r["expireTime"] as? String { c.expire = paramFmt.date(from: e) }
                st.cards.append(c)
            }
        }
        return st
    }

    /// 使用一张重置卡（自动选最早到期的那张，与官网「优先使用」逻辑一致）
    func useResetCard(ofType type: String, completion: @escaping (Bool, String) -> Void) {
        queue.async { [weak self] in
            guard let self,
                  let key = self.apiKey(),
                  let card = self.snapshot.cards.availableCards(of: type).first
            else {
                DispatchQueue.main.async { completion(false, "无可用重置卡或缺少 API key") }
                return
            }
            let r = self.postJSON(path: "/api/biz/customer-package-reset/use", body: [
                "targetType": "PERSONAL",
                "resetType": card.resetType,
                "recordId": card.recordId,
                "grantType": card.grantType,
                "requestId": UUID().uuidString,
            ], key: key)
            NSLog("TokenBar useResetCard(%@) -> ok=%d msg=%@", type, r.ok ? 1 : 0, r.msg)
            DispatchQueue.main.async { completion(r.ok, r.msg) }
        }
    }

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
        s.cards.loaded = true
        s.cards.cards = [
            ResetCard(resetType: "FIVE_HOUR", recordId: 1001, grantType: "CAMPAIGN",
                      expire: Date().addingTimeInterval(26 * 3600), available: true),
            ResetCard(resetType: "WEEK", recordId: 1002, grantType: "CAMPAIGN",
                      expire: Date().addingTimeInterval(5 * 86400), available: true),
            ResetCard(resetType: "WEEK", recordId: 1003, grantType: "CAMPAIGN",
                      expire: Date().addingTimeInterval(-86400), available: false),
        ]
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
                s.cards = self.fetchResetCards(key: key)
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
            NSLog("TokenBar refresh: %@ 5h=%d%% week=%d%% today=%@/%d cards=%@(%d/%d)",
                  s.source, s.quota.fiveHourPct, s.quota.weekPct,
                  fmtTokens(s.today.totalTokens), s.today.totalCalls,
                  s.cards.loaded ? "loaded" : "n/a", s.cards.fiveHourCount, s.cards.weekCount)
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
        let peak = evaluatePeak()
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
        str.append(NSAttributedString(string: " ", attributes: [
            .font: NSFont.systemFont(ofSize: 12),
        ]))
        str.append(peakIcon(for: peak.state))
        button.attributedTitle = str
        var tip = """
        Coding Plan 窗口: 5h \(s.quota.fiveHourPct)% · 周 \(s.quota.weekPct)%
        Peak: \(peak.localWindowText) · 当前\(peakStateText(peak))
        API 今日: \(fmtTokens(s.today.totalTokens)) · 近7天 \(fmtTokens(s.week.totalTokens))
        """
        if s.cards.loaded, s.cards.fiveHourCount + s.cards.weekCount > 0 {
            tip += "\n重置卡可用: 5小时 ×\(s.cards.fiveHourCount) · 周 ×\(s.cards.weekCount)"
        }
        tip += "\n数据来源: \(s.source)"
        button.toolTip = tip
    }

    /// 标题里的 peak 状态图标：peak 🔥 橙 / off-peak ❄ 青（SF Symbol 着色嵌入，取不到时退回 emoji）
    private func peakIcon(for state: PeakState) -> NSAttributedString {
        let name = state == .peak ? "flame.fill" : "snowflake"
        let color: NSColor = state == .peak ? .systemOrange : .systemTeal
        if let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold)) {
            let h: CGFloat = 13
            let w = max(8, base.size.width * h / max(1, base.size.height))
            let att = NSTextAttachment()
            att.image = base.tinted(with: color)
            att.bounds = CGRect(x: 0, y: -2, width: w, height: h)
            return NSAttributedString(attachment: att)
        }
        return NSAttributedString(string: state == .peak ? "🔥" : "❄️", attributes: [
            .font: NSFont.systemFont(ofSize: 11),
        ])
    }

    private func peakStateText(_ p: PeakStatus) -> String {
        switch p.state {
        case .peak: return " peak（GLM-5.3 3× 消耗）"
        case .offPeak: return " off-peak（GLM-5.3 1× 消耗）"
        case .promoOffPeak: return " off-peak（促销期全天半价）"
        }
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

        // Peak 时段（官方规则静态换算，纯本地计算，不依赖接口）
        menu.addItem(.separator())
        addHeader(menu, "Peak 时段（Coding Plan）")
        let peak = evaluatePeak()
        var peakLine = ""
        switch peak.state {
        case .peak: peakLine = "🔥 当前 peak"
        case .offPeak: peakLine = "❄ 当前 off-peak"
        case .promoOffPeak: peakLine = "❄ 当前 off-peak（\(peak.note ?? "促销期")）"
        }
        if let next = peak.nextChange {
            let suffix = "（约 \(fmtDuration(next.timeIntervalSinceNow)) 后）"
            switch peak.state {
            case .peak: peakLine += " · \(clockFmt.string(from: next)) 结束\(suffix)"
            case .offPeak: peakLine += " · 下一 peak \(fullTimeFmt.string(from: next))\(suffix)"
            case .promoOffPeak: peakLine += " · \(fullTimeFmt.string(from: next)) 恢复常规\(suffix)"
            }
        }
        addDetail(menu, peakLine)
        addDetail(menu, "本地时段：\(peak.localWindowText)（UTC+8 换算）")
        addDetail(menu, PeakPolicy.rateNote)

        if s.cards.loaded {
            menu.addItem(.separator())
            addHeader(menu, "重置卡（Reset Card）")
            let fh = s.cards.fiveHourCount, wk = s.cards.weekCount
            if fh + wk == 0 {
                addDetail(menu, "无可用重置卡")
            } else {
                var parts: [String] = []
                if fh > 0 { parts.append("5小时 ×\(fh)") }
                if wk > 0 { parts.append("周 ×\(wk)") }
                addDetail(menu, "可用：" + parts.joined(separator: " · "))
                if fh > 0 { addUseCardItem(menu: menu, type: "FIVE_HOUR", count: fh, cards: s.cards) }
                if wk > 0 { addUseCardItem(menu: menu, type: "WEEK", count: wk, cards: s.cards) }
            }
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

    private func addUseCardItem(menu: NSMenu, type: String, count: Int, cards: ResetCardState) {
        let name = type == "WEEK" ? "周额度" : "5 小时额度"
        var title = "⚡ 使用\(name)重置卡（剩 \(count) 张）"
        if let next = cards.availableCards(of: type).first?.expire {
            title += " · 本张 \(fullTimeFmt.string(from: next)) 到期"
        }
        let item = NSMenuItem(title: title, action: #selector(useCard(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = type
        menu.addItem(item)
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

    private var cardActionInFlight = false

    @objc private func useCard(_ sender: NSMenuItem?) {
        guard !cardActionInFlight, let type = sender?.representedObject as? String else { return }
        let s = monitor.snapshot
        let name = type == "WEEK" ? "周额度" : "5 小时额度"
        guard let card = s.cards.availableCards(of: type).first else { return }

        let alert = NSAlert()
        alert.messageText = "使用\(name)重置卡？"
        var info = "将把\(name)恢复到 100%，对应重置周期从现在重新起算。"
        if let e = card.expire { info += "\n本张将于 \(fullTimeFmt.string(from: e)) 到期。" }
        alert.informativeText = info
        alert.alertStyle = .warning
        alert.addButton(withTitle: "使用")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        cardActionInFlight = true
        monitor.useResetCard(ofType: type) { [weak self] ok, msg in
            guard let self else { return }
            self.cardActionInFlight = false
            if ok {
                self.reload()
            } else {
                let fail = NSAlert()
                fail.messageText = "重置卡使用失败"
                fail.informativeText = msg
                fail.alertStyle = .warning
                fail.runModal()
                self.reload()  // 卡片状态可能已变化，刷新
            }
        }
    }

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
