//
//  lib.js — TokenBar 纯逻辑（格式化 / 解析 / URL 构造），无 GI 依赖。
//  独立测试：cd 本目录上级 && gjs -m test-lib.js
//
//  与 macOS 版 main.swift 中的同名逻辑一一对应（见顶层 README 数据源一节）。
//

// MARK: 格式化

export function fmtTokens(n) {
    const d = Number(n) || 0;
    if (d >= 1e9) return (d / 1e9).toFixed(2) + 'B';
    if (d >= 1e6) return (d / 1e6).toFixed(2) + 'M';
    if (d >= 1e3) return (d / 1e3).toFixed(1) + 'K';
    return String(Math.round(d));
}

export function fmtCalls(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(Math.round(n));
}

export function fmtMoney(amount, currency) {
    const sym = currency === 'CNY' ? '¥' : '$'; // 非 USD/CNY 钱包不标符号，数值照显
    return `${sym}${(Number(amount) || 0).toFixed(2)}`;
}

export function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h >= 1) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m`;
    return `${s}s`;
}

const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values) {
    const vs = values.map(v => Math.max(0, Number(v) || 0));
    const mx = Math.max(1, ...vs);
    return vs.map(v => SPARK_BLOCKS[Math.max(0, Math.min(7, Math.floor(v / mx * 7)))]).join('');
}

// 今日走势图去掉末尾整小时的 0（macOS 版同款）
export function trimTrailingZeros(values) {
    const vs = values.slice();
    while (vs.length > 1 && vs[vs.length - 1] === 0) vs.pop();
    return vs;
}

// MARK: 颜色 / 标记（Pango markup）

const COLOR_OK = '#33d17a';   // GNOME 绿
const COLOR_WARN = '#e5a50a'; // GNOME 黄
const COLOR_BAD = '#f66151';  // GNOME 红

export function pctColorHex(p) {
    return p >= 90 ? COLOR_BAD : p >= 70 ? COLOR_WARN : COLOR_OK;
}

export function pctClass(p) {
    return p >= 90 ? 'tokenbar-pct-bad' : p >= 70 ? 'tokenbar-pct-warn' : 'tokenbar-pct-ok';
}

// DeepSeek 剩余预算色（按美金计）：<10 红，<25 橙，其余绿
const COLOR_MID = '#ff7800'; // GNOME 橙

export function budgetColorHex(balance) {
    return balance < 10 ? COLOR_BAD : balance < 25 ? COLOR_MID : COLOR_OK;
}

export function budgetClass(balance) {
    return balance < 10 ? 'tokenbar-budget-bad'
        : balance < 25 ? 'tokenbar-budget-mid' : 'tokenbar-budget-ok';
}

const BAR_BLOCKS = 14;

export function progressBar(pct) {
    const p = Math.min(Math.max(Math.round(Number(pct) || 0), 0), 100);
    const filled = Math.round(p / 100 * BAR_BLOCKS);
    return `<span foreground="${pctColorHex(p)}">${'█'.repeat(filled)}</span>` +
        `<span foreground="#9a9996">${'░'.repeat(BAR_BLOCKS - filled)}</span>` +
        `<tt>  ${p}%</tt>`;
}

export function sparkMarkup(spark) {
    return `<span foreground="#2fbfae"><tt>${spark}</tt></span>`;
}

export function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// MARK: 时间

function pad2(n) {
    return String(n).padStart(2, '0');
}

// yyyy-MM-dd HH:mm:ss，本地时区（macOS 版 paramFmt 同款）
export function paramStamp(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function clockHM(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dayMD(d) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullMDHM(d) {
    return `${dayMD(d)} ${clockHM(d)}`;
}

// 「重置 M/d HH:mm（约 3h 21m 后）」
export function resetText(resetMs, nowMs) {
    const ms = Number(resetMs);
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    return `重置 ${fullMDHM(new Date(ms))}（约 ${fmtDuration((ms - nowMs) / 1000)} 后）`;
}

// MARK: DeepSeek 峰谷（官方定价：峰价 = UTC 周一至五 01:00–04:00、06:00–10:00，其余半价；
// 周末与中国法定节假日全天谷价。节假日日历未内置，节假日会短暂显示为峰价，属已知偏差。）

const DS_TZ = 'America/Los_Angeles';

export function isDeepSeekPeak(date) {
    const d = date instanceof Date ? date : new Date(date);
    const wd = d.getUTCDay(); // 按 UTC 的周一至五计
    if (wd < 1 || wd > 5) return false;
    const h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function dsPeakIcon(date) {
    return isDeepSeekPeak(date) ? '🔥' : '❄️';
}

// UTC 时刻 → 美西（PDT/PST 自动）HH:mm；Intl 时区库缺失时回退 UTC
function pacificHM(utcMs) {
    try {
        const s = new Intl.DateTimeFormat('en-US',
            {timeZone: DS_TZ, hour: '2-digit', minute: '2-digit', hour12: false})
            .format(new Date(utcMs));
        return s === '24:00' ? '00:00' : s;
    } catch {
        const d = new Date(utcMs);
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }
}

// 峰价窗口折算成美西钟点（按今天 UTC 日期计算，DST 自动跟随）：「17:00–20:00 · 22:00–02:00」
export function dsPeakWindowsPacific(now) {
    const d = now instanceof Date ? now : new Date(now);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    const win = (sh, eh) =>
        `${pacificHM(Date.UTC(y, m, day, sh))}–${pacificHM(Date.UTC(y, m, day, eh))}`;
    return `${win(1, 4)} · ${win(6, 10)}`;
}

// 「🔥 峰价 · 太平洋 18:23」/「❄️ 谷价 · 太平洋 03:07」
export function dsStateText(now) {
    const d = now instanceof Date ? now : new Date(now);
    return `${dsPeakIcon(d)} ${isDeepSeekPeak(d) ? '峰价' : '谷价'} · 太平洋 ${pacificHM(d.getTime())}`;
}

// MARK: 请求 URL

export function usageUrl(startMs, endMs) {
    const s = encodeURIComponent(paramStamp(new Date(startMs)));
    const e = encodeURIComponent(paramStamp(new Date(endMs)));
    return `/api/monitor/usage/model-usage?startTime=${s}&endTime=${e}`;
}

// MARK: API key 读取

// 兼容两种布局：Linux ~/.config/tokenbar/config.json（{apiKey}）与
// macOS ~/.zcode/v2/config.json（provider.builtin:zai-coding-plan.options.apiKey）
export function extractApiKey(jsonText) {
    try {
        const obj = JSON.parse(jsonText);
        const key = obj?.apiKey ?? obj?.provider?.['builtin:zai-coding-plan']?.options?.apiKey;
        if (typeof key === 'string' && key.trim().length > 0) return key.trim();
    } catch { /* 非法 JSON 按无 key 处理 */ }
    return null;
}

// DeepSeek 凭证：优先 ~/.config/tokenbar/deepseek.json（{"token": "..."} 手动覆盖），
// 其次 DeepSeek Harness 的 ~/.dsh/.credentials.yaml（records → deepseek-account-platform/default → payload.token，
// Harness 重新登录会轮换，TokenBar 每次刷新重读，自动跟随）。
export function extractDshToken(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    if (text.trimStart().startsWith('{')) {
        try {
            const t = JSON.parse(text)?.token;
            if (typeof t === 'string' && t.trim().length > 0) return t.trim();
        } catch { /* 非法 JSON → 按 YAML 继续尝试 */ }
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^ {2}deepseek-account-platform\/default:\s*$/.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
            if (/^ {2}\S/.test(lines[j])) break; // 回到同级 key：该记录结束
            const m = lines[j].match(/^\s+token:\s*(\S+)\s*$/);
            if (m) return m[1];
        }
    }
    return null;
}

// MARK: 接口解析

// quota/limit：按重置时间排序，最近重置的当 5h 窗口，最远的当周窗口（macOS 版同款）
export function parseQuota(obj) {
    const q = {
        loaded: false, level: null,
        fiveHourPct: 0, fiveHourResetMs: null,
        weekPct: 0, weekResetMs: null,
    };
    const limits = obj?.data?.limits;
    if (!Array.isArray(limits)) return q;
    q.loaded = true;
    q.level = typeof obj.data.level === 'string' ? obj.data.level : null;
    const tokenLimits = [];
    for (const l of limits) {
        const pct = Number(l?.percentage);
        const reset = Number(l?.nextResetTime);
        if (l?.type === 'TOKENS_LIMIT' && Number.isFinite(pct) && Number.isFinite(reset) && reset > 0) {
            tokenLimits.push({reset, pct: Math.round(pct)});
        }
    }
    tokenLimits.sort((a, b) => a.reset - b.reset);
    if (tokenLimits.length > 0) {
        q.fiveHourPct = tokenLimits[0].pct;
        q.fiveHourResetMs = tokenLimits[0].reset;
    }
    if (tokenLimits.length > 1) {
        q.weekPct = tokenLimits[tokenLimits.length - 1].pct;
        q.weekResetMs = tokenLimits[tokenLimits.length - 1].reset;
    }
    return q;
}

export function parseModelUsage(obj) {
    const u = {loaded: false, totalTokens: 0, totalCalls: 0, models: [], hourly: []};
    const total = obj?.data?.totalUsage;
    const tokens = Number(total?.totalTokensUsage);
    const calls = Number(total?.totalModelCallCount);
    if (!Number.isFinite(tokens) || !Number.isFinite(calls)) return u;
    u.loaded = true;
    u.totalTokens = tokens;
    u.totalCalls = calls;
    if (Array.isArray(total.modelSummaryList)) {
        u.models = total.modelSummaryList
            .filter(m => typeof m?.modelName === 'string' && Number.isFinite(Number(m?.totalTokens)))
            .map(m => ({name: m.modelName, tokens: Math.round(Number(m.totalTokens))}))
            .sort((a, b) => b.tokens - a.tokens);
    }
    const list = obj?.data?.modelDataList;
    if (Array.isArray(list)) {
        const hourly = [];
        for (const m of list) {
            const series = m?.tokensUsage;
            if (!Array.isArray(series)) continue;
            for (let i = 0; i < series.length; i++) {
                const v = Number(series[i]) || 0;
                hourly[i] = (i < hourly.length ? hourly[i] : 0) + v;
            }
        }
        u.hourly = hourly.map(v => Math.round(v) || 0);
    }
    return u;
}

// MARK: DeepSeek 接口解析（platform.deepseek.com；成功 = code:0 且 data.biz_code:0）

// users/get_user_summary → 钱包余额（充值钱包 + 赠送钱包合并；余额为十进制字符串）
export function parseDsBalance(obj) {
    const out = {loaded: false, currency: 'USD', balance: 0};
    const biz = obj?.data?.biz_data;
    if (obj?.code !== 0 || obj?.data?.biz_code !== 0 || !biz) return out;
    let sum = 0;
    let currency = null;
    let ok = false;
    for (const list of [biz.normal_wallets, biz.bonus_wallets]) {
        if (!Array.isArray(list)) continue;
        for (const w of list) {
            const v = Number.parseFloat(w?.balance);
            if (!Number.isFinite(v)) continue;
            ok = true;
            sum += v;
            currency ??= typeof w?.currency === 'string' ? w.currency : null;
        }
    }
    if (!ok) return out;
    out.loaded = true;
    out.balance = Math.round(sum * 100) / 100;
    if (currency) out.currency = currency;
    return out;
}

// usage/by_api_key/cost → 按模型消耗金额（buckets 逐时/逐日）；单日窗口 bucket=3600 时附小时走势
export function parseDsCost(obj) {
    const out = {loaded: false, currency: 'USD', total: 0, models: [], hourly: []};
    const biz = obj?.data?.biz_data;
    if (obj?.code !== 0 || obj?.data?.biz_code !== 0 || !biz) return out;
    const start = Number(biz.start);
    const end = Number(biz.end);
    const bucket = Number(biz.bucket);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Array.isArray(biz.data)) return out;
    out.loaded = true;
    if (typeof biz.data[0]?.currency === 'string') out.currency = biz.data[0].currency;
    const hours = bucket === 3600 ? Math.round((end - start) / 3600) : 0;
    const hourly = hours > 0 ? Array.from({length: hours}, () => 0) : [];
    const per = new Map();
    for (const group of biz.data) {
        if (!Array.isArray(group?.series)) continue;
        for (const s of group.series) {
            if (typeof s?.model !== 'string' || !Array.isArray(s?.buckets)) continue;
            const e = per.get(s.model) ?? {name: s.model, cost: 0};
            for (const b of s.buckets) {
                const v = Number.parseFloat(b?.cost);
                if (!Number.isFinite(v)) continue;
                e.cost += v;
                out.total += v;
                if (hours > 0) {
                    const i = Math.floor((Number(b.time) - start) / 3600);
                    if (i >= 0 && i < hours) hourly[i] += v;
                }
            }
            per.set(s.model, e);
        }
    }
    const round6 = v => Math.round(v * 1e6) / 1e6; // 去浮点噪声；显示时再取 2 位
    out.total = round6(out.total);
    out.models = [...per.values()].map(m => ({...m, cost: round6(m.cost)}))
        .sort((a, b) => b.cost - a.cost);
    out.hourly = hourly.map(round6);
    return out;
}

// usage/by_api_key/amount → 按模型 token（cache hit/miss + response 合计）与请求次数
export function parseDsAmount(obj) {
    const out = {loaded: false, totalTokens: 0, totalCalls: 0, models: []};
    const biz = obj?.data?.biz_data;
    if (obj?.code !== 0 || obj?.data?.biz_code !== 0 || !biz || !Array.isArray(biz.series)) return out;
    out.loaded = true;
    const per = new Map();
    const add = (model, tokens, calls) => {
        const e = per.get(model) ?? {name: model, tokens: 0, calls: 0};
        e.tokens += tokens;
        e.calls += calls;
        per.set(model, e);
    };
    for (const s of biz.series) {
        if (typeof s?.model !== 'string' || !Array.isArray(s?.buckets)) continue;
        for (const b of s.buckets) {
            const u = b?.usage ?? {};
            add(s.model,
                (Number(u.PROMPT_CACHE_HIT_TOKEN) || 0)
                    + (Number(u.PROMPT_CACHE_MISS_TOKEN) || 0)
                    + (Number(u.RESPONSE_TOKEN) || 0),
                Number(u.REQUEST) || 0);
        }
    }
    for (const s of Array.isArray(biz.function_series) ? biz.function_series : []) {
        if (typeof s?.model !== 'string' || !Array.isArray(s?.buckets)) continue;
        for (const b of s.buckets) add(s.model, 0, Number(b?.usage?.REQUEST) || 0);
    }
    out.models = [...per.values()]
        .map(m => ({...m, tokens: Math.round(m.tokens), calls: Math.round(m.calls)}))
        .sort((a, b) => b.tokens - a.tokens);
    out.totalTokens = out.models.reduce((a, m) => a + m.tokens, 0);
    out.totalCalls = out.models.reduce((a, m) => a + m.calls, 0);
    return out;
}

// cost + amount 按模型名合并成面板用的一条记录
export function mergeDsUsage(cost, amount) {
    const map = new Map();
    for (const m of cost?.models ?? []) {
        map.set(m.name, {name: m.name, cost: m.cost, tokens: 0, calls: 0});
    }
    for (const m of amount?.models ?? []) {
        const e = map.get(m.name) ?? {name: m.name, cost: 0, tokens: 0, calls: 0};
        e.tokens = m.tokens;
        e.calls = m.calls;
        map.set(m.name, e);
    }
    return {
        loaded: !!(cost?.loaded || amount?.loaded),
        hasCost: !!cost?.loaded,
        currency: cost?.currency ?? 'USD',
        totalCost: cost?.total ?? 0,
        totalTokens: amount?.totalTokens ?? 0,
        totalCalls: amount?.totalCalls ?? 0,
        models: [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
        hourly: cost?.hourly ?? [],
    };
}

// MARK: 模拟数据 / 来源标注

export function mockSnapshot(nowMs) {
    const t = (nowMs ?? Date.now()) / 1000;
    const pct = (base, amp, w, ph) =>
        Math.round(Math.min(100, Math.max(0, base + amp * (0.5 + 0.5 * Math.sin(t / w + ph)))));
    const mk = scale => {
        const totalTokens = Math.round((60 + 30 * Math.sin(t / 3600)) * 1e6 * scale);
        return {
            loaded: true,
            totalTokens,
            totalCalls: Math.round(2700 * scale),
            models: [
                {name: 'GLM-5.3', tokens: Math.round(totalTokens * 0.96)},
                {name: 'GLM-5.3-Flash', tokens: Math.round(totalTokens * 0.04)},
            ],
            hourly: Array.from({length: 24}, () =>
                Math.round(2e6 * scale * (0.3 + Math.random() * 0.7))),
        };
    };
    return {
        quota: {
            loaded: true, level: 'pro',
            fiveHourPct: pct(40, 25, 5000, 0), fiveHourResetMs: (nowMs ?? Date.now()) + 3 * 3600e3,
            weekPct: pct(84, 10, 200000, 3), weekResetMs: (nowMs ?? Date.now()) + 36 * 3600e3,
        },
        today: mk(1.0),
        week: mk(3.2),
        ds: {
            balance: {loaded: true, currency: 'USD', balance: 18.42}, // 橙色档示例
            today: {
                loaded: true, hasCost: true, currency: 'USD',
                totalCost: 0.34, totalTokens: 2489866, totalCalls: 39,
                models: [{name: 'deepseek-flash', cost: 0.34, tokens: 2489866, calls: 39}],
                hourly: Array.from({length: 24}, () => Math.round(Math.random() * 500) / 1e4),
            },
            week: {
                loaded: true, hasCost: true, currency: 'USD',
                totalCost: 3.21, totalTokens: 12300000, totalCalls: 260,
                models: [{name: 'deepseek-flash', cost: 3.21, tokens: 12300000, calls: 260}],
                hourly: [],
            },
        },
    };
}

// 「官方 · GLM Coding Pro + 账户级 API」；都没有时返回 null，由调用方决定降级文案
export function sourceLabel(quotaLoaded, quotaLevel, todayLoaded) {
    const parts = [];
    if (quotaLoaded) {
        const lvl = quotaLevel
            ? quotaLevel.charAt(0).toUpperCase() + quotaLevel.slice(1)
            : 'Plan';
        parts.push('GLM Coding ' + lvl);
    }
    if (todayLoaded) parts.push('账户级 API');
    return parts.length ? '官方 · ' + parts.join(' + ') : null;
}
