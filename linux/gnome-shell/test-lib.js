//
//  test-lib.js — lib.js 逻辑测试（无 UI、无网络）
//  运行：cd linux/gnome-shell && gjs -m test-lib.js
//

import * as Lib from './tokenbar@zuohang/lib.js';

let failed = 0;

function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok  ${label}`);
    } else {
        failed++;
        console.error(`FAIL  ${label}\n      expected: ${e}\n      actual:   ${a}`);
    }
}

// MARK: 格式化（与 macOS 版 fmtTokens/fmtCalls/fmtDuration 对齐）

eq(Lib.fmtTokens(87_000_000), '87.00M', 'fmtTokens 87M');
eq(Lib.fmtTokens(1_500_000_000), '1.50B', 'fmtTokens 1.5B');
eq(Lib.fmtTokens(1234), '1.2K', 'fmtTokens 1.2K');
eq(Lib.fmtTokens(999), '999', 'fmtTokens 999');
eq(Lib.fmtTokens(0), '0', 'fmtTokens 0');

eq(Lib.fmtCalls(27000), '2.7万', 'fmtCalls 2.7万');
eq(Lib.fmtCalls(123), '123', 'fmtCalls 123');
eq(Lib.fmtCalls(10000), '1.0万', 'fmtCalls 1.0万');

eq(Lib.fmtDuration(3 * 3600 + 120), '3h 2m', 'fmtDuration 3h2m');
eq(Lib.fmtDuration(45), '45s', 'fmtDuration 45s');
eq(Lib.fmtDuration(90), '1m', 'fmtDuration 90s');
eq(Lib.fmtDuration(25 * 3600 + 61), '1d 1h', 'fmtDuration 1d1h');

// MARK: 走势图

eq(Lib.sparkline([0, 10, 5]), '▁█▄', 'sparkline scale'); // Int 截断与 Swift 版一致：blocks[3]='▄'
eq(Lib.sparkline([0, 0, 1]), '▁▁█', 'sparkline flat');
eq(Lib.trimTrailingZeros([1, 2, 0, 0]), [1, 2], 'trimTrailingZeros');
eq(Lib.trimTrailingZeros([0]), [0], 'trimTrailingZeros keeps 1');

// MARK: 转义 / 时间 / URL

eq(Lib.esc('<a&b>'), '&lt;a&amp;b&gt;', 'esc');

eq(Lib.paramStamp(new Date(2026, 10, 13, 9, 5, 3)), '2026-11-13 09:05:03', 'paramStamp');
eq(Lib.clockHM(new Date(2026, 10, 13, 9, 5)), '09:05', 'clockHM');
eq(Lib.fullMDHM(new Date(2026, 10, 13, 9, 5)), '11/13 09:05', 'fullMDHM');

const url = Lib.usageUrl(new Date(2026, 10, 13, 1, 2, 3).getTime(), 0);
eq(url.includes('/api/monitor/usage/model-usage?startTime=2026-11-13%2001%3A02%3A03'), true,
    'usageUrl encodes local time');

// MARK: API key

eq(Lib.extractApiKey('{"apiKey":"abc"}'), 'abc', 'key flat layout');
eq(Lib.extractApiKey('{"provider":{"builtin:zai-coding-plan":{"options":{"apiKey":"xyz"}}}}'),
    'xyz', 'key macOS layout');
eq(Lib.extractApiKey('{"apiKey":"  "}'), null, 'key blank');
eq(Lib.extractApiKey('not json'), null, 'key bad json');
eq(Lib.extractApiKey('{"other":1}'), null, 'key missing');

// MARK: quota/limit 解析（最近重置=5h，最远=周；非 TOKENS_LIMIT 忽略）

const quotaFixture = {success: true, data: {level: 'pro', limits: [
    {type: 'TOKENS_LIMIT', percentage: 88, nextResetTime: 2000000000000},
    {type: 'CONCURRENCY_LIMIT', percentage: 10, nextResetTime: 1000000000000},
    {type: 'TOKENS_LIMIT', percentage: 37.4, nextResetTime: 1500000000000},
]}};
const q = Lib.parseQuota(quotaFixture);
eq(q.loaded, true, 'quota loaded');
eq(q.level, 'pro', 'quota level');
eq(q.fiveHourPct, 37, 'quota 5h pct (nearest reset, rounded)');
eq(q.fiveHourResetMs, 1500000000000, 'quota 5h reset');
eq(q.weekPct, 88, 'quota week pct (farthest)');
eq(q.weekResetMs, 2000000000000, 'quota week reset');
eq(Lib.parseQuota({data: {}}).loaded, false, 'quota missing limits');

// MARK: model-usage 解析

const usageFixture = {success: true, data: {
    totalUsage: {
        totalTokensUsage: 87000000,
        totalModelCallCount: 2700,
        modelSummaryList: [
            {modelName: 'GLM-5.3-Flash', totalTokens: 3480000},
            {modelName: 'GLM-5.3', totalTokens: 83520000},
        ],
    },
    modelDataList: [
        {tokensUsage: [1, 2, 3]},
        {tokensUsage: [10, 20]},
    ],
}};
const u = Lib.parseModelUsage(usageFixture);
eq(u.loaded, true, 'usage loaded');
eq(u.totalTokens, 87000000, 'usage tokens');
eq(u.totalCalls, 2700, 'usage calls');
eq(u.models, [{name: 'GLM-5.3', tokens: 83520000}, {name: 'GLM-5.3-Flash', tokens: 3480000}],
    'usage models sorted');
eq(u.hourly, [11, 22, 3], 'usage hourly merged');
eq(Lib.parseModelUsage({data: {totalUsage: {}}}).loaded, false, 'usage missing fields');

// MARK: 进度条 / 走势 markup

eq(Lib.progressBar(0),
    '<span foreground="#33d17a"></span><span foreground="#9a9996">' + '░'.repeat(14) + '</span><tt>  0%</tt>',
    'bar 0%');
eq(Lib.progressBar(100).includes('█'.repeat(14)), true, 'bar 100% filled');
eq(Lib.progressBar(72).includes('█'.repeat(10)) && Lib.progressBar(72).startsWith('<span foreground="#e5a50a">'),
    true, 'bar 72% warn color');
eq(Lib.sparkMarkup('▁█').startsWith('<span foreground='), true, 'spark markup');
eq(Lib.pctClass(95), 'tokenbar-pct-bad', 'pctClass 95');
eq(Lib.pctClass(70), 'tokenbar-pct-warn', 'pctClass 70');
eq(Lib.pctClass(10), 'tokenbar-pct-ok', 'pctClass 10');

// MARK: 来源标注

eq(Lib.sourceLabel(true, 'pro', true), '官方 · GLM Coding Pro + 账户级 API', 'sourceLabel full');
eq(Lib.sourceLabel(false, null, true), '官方 · 账户级 API', 'sourceLabel usage only');
eq(Lib.sourceLabel(true, null, false), '官方 · GLM Coding Plan', 'sourceLabel quota only');
eq(Lib.sourceLabel(false, null, false), null, 'sourceLabel none');

// MARK: 重置文案

const t = Lib.resetText(1500000000000, 1500000000000 - 3 * 3600e3 - 21 * 60e3);
eq(t.includes('3h 21m'), true, 'resetText countdown');
eq(Lib.resetText(null, Date.now()), '—', 'resetText missing');

// MARK: 模拟数据结构

const mock = Lib.mockSnapshot(Date.now());
eq(mock.quota.loaded && mock.today.loaded && mock.week.loaded, true, 'mock loaded');
eq(mock.today.hourly.length, 24, 'mock hourly 24');

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall ok');
if (failed) throw new Error(`${failed} test(s) failed`);
