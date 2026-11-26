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

// MARK: quota/limit 解析（窗口语义字段优先；无语义字段回退重置时间远近；非 TOKENS_LIMIT 忽略）

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

// 语义字段（unit 3=小时×5 → 5h；unit 6×1 → 周）优先于远近：构造周窗口重置更近的反例
// （周三早上北京 5h 滚动重置点可能晚于周重置点，按远近会接反）
const quotaSwapped = {success: true, data: {level: 'pro', limits: [
    {type: 'TOKENS_LIMIT', percentage: 59, nextResetTime: 1500000000000, unit: 6, number: 1},
    {type: 'TOKENS_LIMIT', percentage: 1, nextResetTime: 2000000000000, unit: 3, number: 5},
]}};
const qs = Lib.parseQuota(quotaSwapped);
eq(qs.fiveHourPct, 1, 'quota semantic 5h (unit3×5 beats reset order)');
eq(qs.weekPct, 59, 'quota semantic week (unit6×1 beats reset order)');
// 只有语义 5h、无周窗口字段：周保持未取
const qs5 = Lib.parseQuota({success: true, data: {limits: [
    {type: 'TOKENS_LIMIT', percentage: 7, nextResetTime: 1500000000000, unit: 3, number: 5},
]}});
eq(qs5.fiveHourPct, 7, 'quota semantic 5h only');
eq(qs5.weekPct, 0, 'quota semantic 5h only no week');
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

// MARK: 峰时状态（北京时间 = UTC+8；工作日 14:00–18:00 为峰时）

eq(Lib.isPeakTime(Date.UTC(2026, 10, 10, 7, 0)), true, 'peak 周二 15:00 北京');      // 周二 15:00
eq(Lib.isPeakTime(Date.UTC(2026, 10, 10, 5, 59)), false, 'offpeak 周二 13:59 北京'); // 周二 13:59
eq(Lib.isPeakTime(Date.UTC(2026, 10, 10, 10, 0)), false, 'offpeak 周二 18:00 北京'); // 周二 18:00 整
eq(Lib.isPeakTime(Date.UTC(2026, 10, 10, 9, 59)), true, 'peak 周二 17:59 北京');     // 周二 17:59
eq(Lib.isPeakTime(Date.UTC(2026, 10, 14, 7, 0)), false, 'offpeak 周六 15:00 北京');  // 周六 15:00
eq(Lib.isPeakTime(Date.UTC(2026, 10, 13, 7, 0)), true, 'peak 周五 15:00 北京');      // 周五（11-13）15:00
eq(Lib.isPeakTime(Date.UTC(2026, 10, 16, 1, 0)), false, 'offpeak 周一 09:00 北京');  // 周一 09:00 不在 14–18 点
eq(Lib.isPeakTime(Date.UTC(2026, 10, 13, 16, 30)), false,
    'offpeak 周六 00:30 北京（UTC 周五 16:30，须按北京判断）');                        // 北京周六凌晨
eq(Lib.isPeakTime(Date.UTC(2026, 10, 15, 16, 30)), false,
    'offpeak 周日 00:30 北京');                                                       // 北京周日凌晨
eq(Lib.peakIcon(Date.UTC(2026, 10, 10, 7, 0)), '🔥', 'peakIcon peak');
eq(Lib.peakIcon(Date.UTC(2026, 10, 14, 7, 0)), '❄️', 'peakIcon offpeak');
eq(Lib.PEAK_DEF.includes('14:00'), true, 'PEAK_DEF text');

// GLM 峰时窗口折算美西：UTC 固定 06:00–10:00 → PST 22:00–02:00 / PDT 23:00–03:00
eq(Lib.peakWindowsPacific(Date.UTC(2026, 0, 15, 12)), '22:00–02:00', 'GLM peak windows PST');
eq(Lib.peakWindowsPacific(Date.UTC(2026, 6, 15, 12)), '23:00–03:00', 'GLM peak windows PDT');

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
eq(mock.ds.balance.loaded && mock.ds.today.loaded && mock.ds.week.loaded, true, 'mock ds loaded');

// MARK: DeepSeek 金额 / 预算色

eq(Lib.fmtMoney(49.912392548, 'USD'), '$49.91', 'fmtMoney USD');
eq(Lib.fmtMoney(12.34, 'CNY'), '¥12.34', 'fmtMoney CNY');
eq(Lib.fmtMoney('abc', 'USD'), '$0.00', 'fmtMoney bad input');
eq(Lib.budgetClass(9.99), 'tokenbar-budget-bad', 'budgetClass <10 red');
eq(Lib.budgetClass(10), 'tokenbar-budget-mid', 'budgetClass 10 orange');
eq(Lib.budgetClass(24.99), 'tokenbar-budget-mid', 'budgetClass <25 orange');
eq(Lib.budgetClass(25), 'tokenbar-budget-ok', 'budgetClass 25 green');
eq(Lib.budgetColorHex(5), '#f66151', 'budgetColorHex red');
eq(Lib.budgetColorHex(15), '#ff7800', 'budgetColorHex orange');
eq(Lib.budgetColorHex(100), '#33d17a', 'budgetColorHex green');

// MARK: DeepSeek 峰谷（官方：UTC 周一至五 01:00–04:00、06:00–10:00 峰价，其余半价）

eq(Lib.isDeepSeekPeak(new Date('2026-11-25T02:00:00Z')), true, 'peak Wed 02:00Z');    // 周三
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T03:59:00Z')), true, 'peak window1 edge');
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T04:00:00Z')), false, 'valley 04:00Z gap');
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T05:00:00Z')), false, 'valley Wed 05:00Z');
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T07:00:00Z')), true, 'peak Wed 07:00Z window2');
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T09:59:00Z')), true, 'peak window2 edge');
eq(Lib.isDeepSeekPeak(new Date('2026-11-25T10:00:00Z')), false, 'valley 10:00Z after');
eq(Lib.isDeepSeekPeak(new Date('2026-11-21T02:00:00Z')), false, 'valley Saturday');
eq(Lib.isDeepSeekPeak(new Date('2026-11-22T07:00:00Z')), false, 'valley Sunday');
eq(Lib.isDeepSeekPeak(new Date('2026-11-20T07:00:00Z')), true, 'peak Friday');
eq(Lib.dsPeakIcon(new Date('2026-11-25T02:00:00Z')), '🔥', 'icon peak flame');
eq(Lib.dsPeakIcon(new Date('2026-11-25T05:00:00Z')), '❄️', 'icon valley snow');

// 峰价窗口折算美西：冬季 PST(UTC-8)=17–20 · 22–02；夏季 PDT(UTC-7) 顺延 1h
eq(Lib.dsPeakWindowsPacific(new Date('2026-01-15T12:00:00Z')), '17:00–20:00 · 22:00–02:00',
    'peak windows PST');
eq(Lib.dsPeakWindowsPacific(new Date('2026-07-15T12:00:00Z')), '18:00–21:00 · 23:00–03:00',
    'peak windows PDT');
eq(Lib.dsStateText(new Date('2026-11-25T02:00:00Z')).includes('🔥 峰价 · 太平洋 18:00'), true,
    'dsStateText peak PST');
eq(Lib.dsStateText(new Date('2026-11-25T05:00:00Z')).includes('❄️ 谷价'), true,
    'dsStateText valley');

// MARK: DeepSeek 凭证读取

eq(Lib.extractDshToken('{"token": " tok1 "}'), 'tok1', 'dsh token json override');
const yamlCred = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: AAAA
  deepseek-account-platform/device:
    kind: grant
    payload:
      id: dev-id
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: TOK123
      issuer: https://platform.deepseek.com
`;
eq(Lib.extractDshToken(yamlCred), 'TOK123', 'dsh token yaml default record');
eq(Lib.extractDshToken('records: {}\n'), null, 'dsh token missing record');
eq(Lib.extractDshToken(''), null, 'dsh token empty');

// MARK: DeepSeek 接口解析

const dsBalFixture = {code: 0, msg: '', data: {biz_code: 0, biz_msg: '', biz_data: {
    normal_wallets: [{currency: 'USD', balance: '49.9123925480000000', token_estimation: '0'}],
    bonus_wallets: [{currency: 'USD', balance: '0', token_estimation: '0'}],
    total_costs: [{currency: 'USD', amount: '0.0876074520000000'}],
}}};
const dsBal = Lib.parseDsBalance(dsBalFixture);
eq(dsBal, {loaded: true, currency: 'USD', balance: 49.91}, 'ds balance merged');
eq(Lib.parseDsBalance({code: 0, data: {biz_code: 1, biz_msg: 'INVALID_PARAM', biz_data: null}}).loaded,
    false, 'ds balance biz error');
eq(Lib.parseDsBalance({detail: 'Not Found'}).loaded, false, 'ds balance http json error');

// cost：单日窗口 bucket=3600 → 小时走势；7 天窗口 bucket=86400 → 无走势
const mkCost = bucket => ({code: 0, msg: '', data: {biz_code: 0, biz_msg: '', biz_data: {
    start: 1000, end: 1000 + 3600 * 24, bucket,
    models: ['deepseek-flash'], functions: [],
    data: [{currency: 'USD', series: [
        {api_key: {tracking_id: 't1', name: 'DeepSeek Harness'}, model: 'deepseek-flash',
            buckets: [{time: 1000, cost: '0.0876074520000000'}, {time: 4600, cost: '0.0124'}]},
        ],
        function_series: []},
    ]}}});
const dsCostDay = Lib.parseDsCost(mkCost(3600));
eq(dsCostDay.loaded, true, 'ds cost loaded');
eq(dsCostDay.total, 0.100007, 'ds cost total');
eq(dsCostDay.currency, 'USD', 'ds cost currency');
eq(dsCostDay.models, [{name: 'deepseek-flash', cost: 0.100007}], 'ds cost models');
eq(dsCostDay.hourly[0], 0.087607, 'ds cost hourly[0]');
eq(dsCostDay.hourly[1], 0.0124, 'ds cost hourly[1]');
eq(dsCostDay.hourly.length, 24, 'ds cost hourly length');
eq(Lib.parseDsCost(mkCost(86400)).hourly, [], 'ds cost weekly no hourly');
eq(Lib.parseDsCost({code: 0, data: {biz_code: 1, biz_data: null}}).loaded, false, 'ds cost biz error');

// amount：token = cache hit + miss + response；调用次数含 function_series
const dsAmtFixture = {code: 0, msg: '', data: {biz_code: 0, biz_msg: '', biz_data: {
    start: 1000, end: 4600, bucket: 3600,
    models: ['deepseek-flash'], functions: [],
    series: [{api_key: {tracking_id: 't1'}, model: 'deepseek-flash', buckets: [
        {time: 1000, usage: {
            RESPONSE_TOKEN: 27929, REQUEST: 39,
            PROMPT_CACHE_HIT_TOKEN: 2328192, PROMPT_CACHE_MISS_TOKEN: 133745}},
        {time: 4600, usage: {RESPONSE_TOKEN: 71, REQUEST: 1,
            PROMPT_CACHE_HIT_TOKEN: 8, PROMPT_CACHE_MISS_TOKEN: 0}},
    ]}],
    function_series: [{api_key: {tracking_id: 't1'}, model: 'deepseek-flash', unit: 'USD', buckets: [
        {time: 1000, usage: {FUNCTION_CALL: 2, REQUEST: 3}},
    ]}],
}}};
const dsAmt = Lib.parseDsAmount(dsAmtFixture);
eq(dsAmt.loaded, true, 'ds amount loaded');
eq(dsAmt.totalTokens, 2489866 + 79, 'ds amount tokens (hit+miss+response)');
eq(dsAmt.totalCalls, 43, 'ds amount calls incl function series');
eq(dsAmt.models, [{name: 'deepseek-flash', tokens: 2489945, calls: 43}], 'ds amount models');

const dsMerged = Lib.mergeDsUsage(dsCostDay, dsAmt);
eq(dsMerged.loaded && dsMerged.hasCost, true, 'ds merge flags');
eq(dsMerged.currency, 'USD', 'ds merge currency');
eq(dsMerged.totalCost, 0.100007, 'ds merge cost');
eq(dsMerged.totalTokens, 2489945, 'ds merge tokens');
eq(dsMerged.models, [{name: 'deepseek-flash', cost: 0.100007, tokens: 2489945, calls: 43}],
    'ds merge models joined');
eq(Lib.mergeDsUsage(null, null),
    {loaded: false, hasCost: false, currency: 'USD', totalCost: 0, totalTokens: 0, totalCalls: 0,
        models: [], hourly: []},
    'ds merge empty');

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall ok');
if (failed) throw new Error(`${failed} test(s) failed`);
