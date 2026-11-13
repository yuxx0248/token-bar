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
