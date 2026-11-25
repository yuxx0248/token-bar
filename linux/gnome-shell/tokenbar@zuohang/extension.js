//
//  extension.js — TokenBar GNOME Shell 扩展（macOS 菜单栏版的 Linux 移植）
//
//  顶栏：<GLM峰谷><5h>% · <周>% · <DS峰谷>$<余额>（🔥峰 / ❄️谷），点击弹面板；数据源见顶层 README。
//  安装：linux/gnome-shell/install.sh（Wayland 首次安装需注销重登）
//

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Lib from './lib.js';

const API_BASE = 'https://api.z.ai';
const DS_API_BASE = 'https://platform.deepseek.com';
const REFRESH_SEC = 300;              // 数据自动刷新间隔（macOS 版同款）
const RENDER_SEC = 30;                // 顶栏/菜单重绘间隔（重置倒计时、峰谷切换等相对时间）
const OPEN_REFRESH_THROTTLE_SEC = 30; // 打开菜单触发刷新的最小间隔

const Indicator = GObject.registerClass(
class TokenBarIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'TokenBar');
        // PanelMenu.Button 只稳定布局单个子 actor：四个 label 需包在一层 BoxLayout 里
        this._box = new St.BoxLayout({style_class: 'tokenbar-box'});
        this._peak = new St.Label({
            text: Lib.peakIcon(Date.now()), y_align: Clutter.ActorAlign.CENTER,
        });
        this._five = new St.Label({
            text: '–%', y_align: Clutter.ActorAlign.CENTER,
            style_class: 'tokenbar-strong tokenbar-dim',
        });
        this._sep = new St.Label({
            text: ' · ', y_align: Clutter.ActorAlign.CENTER, style_class: 'tokenbar-dim',
        });
        this._week = new St.Label({
            text: '–%', y_align: Clutter.ActorAlign.CENTER, style_class: 'tokenbar-dim',
        });
        this._dsSep = new St.Label({
            text: ' · ', y_align: Clutter.ActorAlign.CENTER, style_class: 'tokenbar-dim',
        });
        this._dsIcon = new St.Label({
            text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'tokenbar-dim',
        });
        this._dsBudget = new St.Label({
            text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'tokenbar-strong tokenbar-dim',
        });
        // PanelMenu.Button 只稳定布局单个子 actor：所有 label 包在一层 BoxLayout 里
        for (const w of [this._peak, this._five, this._sep, this._week,
            this._dsSep, this._dsIcon, this._dsBudget]) this._box.add_child(w);
        this.add_child(this._box);
    }

    render(snap) {
        this._peak.text = Lib.peakIcon(Date.now()); // GLM 峰时是纯时间推导，与数据无关
        const glmLoaded = snap.quota.loaded || snap.today.loaded;
        const ds = snap.ds;
        const dsLoaded = !!ds && (ds.balance.loaded || ds.today.loaded || ds.week.loaded);
        if (!glmLoaded && !dsLoaded) {
            // 没有任何真实数据（未配置 key 等）：显示 –
            this._five.text = '–%';
            this._five.style_class = 'tokenbar-strong tokenbar-dim';
            this._week.text = '–%';
            this._week.style_class = 'tokenbar-dim';
            this._dsSep.visible = this._dsIcon.visible = this._dsBudget.visible = false;
            return;
        }
        if (snap.quota.loaded) {
            this._five.text = `${snap.quota.fiveHourPct}%`;
            this._five.style_class = `tokenbar-strong ${Lib.pctClass(snap.quota.fiveHourPct)}`;
            this._week.text = `${snap.quota.weekPct}%`;
            this._week.style_class = Lib.pctClass(snap.quota.weekPct);
        } else {
            // GLM 不可用（或未配 key）但 DeepSeek 有数据：GLM 段显示 –，不让 0% 误导
            this._five.text = '–%';
            this._five.style_class = 'tokenbar-strong tokenbar-dim';
            this._week.text = '–%';
            this._week.style_class = 'tokenbar-dim';
        }
        const dsBal = ds && ds.balance.loaded;
        this._dsSep.visible = this._dsIcon.visible = this._dsBudget.visible = dsBal;
        if (dsBal) {
            this._dsIcon.text = Lib.dsPeakIcon(new Date());
            this._dsBudget.text = Lib.fmtMoney(ds.balance.balance, ds.balance.currency);
            this._dsBudget.style_class = `tokenbar-strong ${Lib.budgetClass(ds.balance.balance)}`;
        }
    }
});

export default class TokenBarExtension extends Extension {
    enable() {
        this._session = new Soup.Session({timeout: 15, user_agent: 'tokenbar/1.0'});
        this._snapshot = this._emptySnapshot();
        this._refreshing = false;
        this._lastRefreshAt = 0;

        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheet);

        this._indicator = new Indicator();
        Main.panel.addToStatusArea('tokenbar', this._indicator, 1, 'left'); // 左上角（appMenu 之后）
        this._menuOpenId = this._indicator.menu.connect('open-state-changed',
            (_menu, open) => {
                if (open) this._onMenuOpen();
            });

        this._rebuildMenu();
        this._indicator.render(this._snapshot);
        this._refresh();

        this._dataTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SEC,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        this._renderTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RENDER_SEC,
            () => {
                this._indicator.render(this._snapshot); // 峰谷图标与预算色随时间实时翻转
                this._rebuildMenu();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        for (const id of [this._dataTimerId, this._renderTimerId]) {
            if (id) GLib.source_remove(id);
        }
        this._dataTimerId = this._renderTimerId = 0;
        if (this._menuOpenId && this._indicator) {
            this._indicator.menu.disconnect(this._menuOpenId);
        }
        this._menuOpenId = 0;
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._theme && this._stylesheet) {
            this._theme.unload_stylesheet(this._stylesheet);
            this._stylesheet = null;
        }
        this._session = null;
        this._theme = null;
    }

    // MARK: 数据

    _emptySnapshot() {
        return {
            quota: {
                loaded: false, level: null,
                fiveHourPct: 0, fiveHourResetMs: null,
                weekPct: 0, weekResetMs: null,
            },
            today: {loaded: false, totalTokens: 0, totalCalls: 0, models: [], hourly: []},
            week: {loaded: false, totalTokens: 0, totalCalls: 0, models: [], hourly: []},
            ds: {
                balance: {loaded: false, currency: 'USD', balance: 0},
                today: Lib.mergeDsUsage(null, null),
                week: Lib.mergeDsUsage(null, null),
            },
            source: '加载中…',
            noKey: false,
            noDs: false,
            lastRefresh: null,
        };
    }

    _readApiKey() {
        const home = GLib.get_home_dir();
        const paths = [
            GLib.build_filenamev([home, '.config', 'tokenbar', 'config.json']),
            GLib.build_filenamev([home, '.zcode', 'v2', 'config.json']), // macOS 版布局
        ];
        for (const path of paths) {
            try {
                const [, bytes] = GLib.file_get_contents(path);
                const key = Lib.extractApiKey(new TextDecoder().decode(bytes));
                if (key) return key;
            } catch { /* 文件不存在/不可读 → 尝试下一个路径 */ }
        }
        return null;
    }

    // DeepSeek 凭证：~/.config/tokenbar/deepseek.json 覆盖 → ~/.dsh/.credentials.yaml（Harness）
    _readDsToken() {
        const home = GLib.get_home_dir();
        const paths = [
            GLib.build_filenamev([home, '.config', 'tokenbar', 'deepseek.json']),
            GLib.build_filenamev([home, '.dsh', '.credentials.yaml']),
        ];
        for (const path of paths) {
            try {
                const [, bytes] = GLib.file_get_contents(path);
                const token = Lib.extractDshToken(new TextDecoder().decode(bytes));
                if (token) return token;
            } catch { /* 文件不存在/不可读 → 尝试下一个路径 */ }
        }
        return null;
    }

    async _fetchJSON(url, key) {
        const msg = Soup.Message.new('GET', API_BASE + url);
        msg.request_headers.append('authorization', key); // 直接传 key，不加 Bearer（macOS 版同款）
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        resolve(this._session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        // 注意：接口鉴权失败也返回 HTTP 200 + success:false，两层都要查
        if (msg.status_code !== Soup.Status.OK) throw new Error(`HTTP ${msg.status_code}`);
        const obj = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (obj?.success !== true) throw new Error(`API error: ${obj?.msg ?? 'unknown'}`);
        return obj;
    }

    async _fetchDsJSON(url, token) {
        const msg = Soup.Message.new('GET', DS_API_BASE + url);
        msg.request_headers.append('x-dsh-auth-token', token);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        resolve(this._session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        // 平台同样是 HTTP 200 包业务错误码（code/biz_code），两层都要查
        if (msg.status_code !== Soup.Status.OK) throw new Error(`HTTP ${msg.status_code}`);
        const obj = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (obj?.code !== 0 || obj?.data?.biz_code !== 0) {
            throw new Error(`DS API error: ${obj?.data?.biz_msg ?? obj?.msg ?? 'unknown'}`);
        }
        return obj;
    }

    // 平台要求 start/end 对齐本地日界；tz 只传整小时部分，剩余分钟并入 start/end（平台 Web 同款逻辑）
    _dsUsageUrl(path, startMs, endMs) {
        const offsetSec = -new Date().getTimezoneOffset() * 60;
        const whole = Math.floor(offsetSec / 3600) * 3600;
        const rem = offsetSec - whole;
        const s = Math.floor(startMs / 1000 + rem);
        const e = Math.floor(endMs / 1000 + rem);
        return `${path}?start=${s}&end=${e}&tz=${whole}`;
    }

    async _refresh() {
        if (this._refreshing) return;
        this._refreshing = true;
        try {
            const now = new Date();
            const forcedMock = GLib.getenv('TOKENBAR_MOCK') === '1';
            const key = forcedMock ? null : this._readApiKey();
            const dsToken = forcedMock ? null : this._readDsToken();
            const s = this._emptySnapshot();
            const empty = part => this._emptySnapshot()[part];

            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);
            const end = new Date(now);
            end.setHours(23, 59, 59, 999);
            const weekStart = new Date(todayStart);
            weekStart.setDate(weekStart.getDate() - 6);
            const tomorrowStart = todayStart.getTime() + 86400e3;

            const [quota, today, week, dsBalance, dsCostToday, dsCostWeek, dsAmountToday, dsAmountWeek] =
                await Promise.all([
                    key
                        ? this._fetchJSON('/api/monitor/usage/quota/limit', key)
                            .then(Lib.parseQuota).catch(() => empty('quota'))
                        : empty('quota'),
                    key
                        ? this._fetchJSON(Lib.usageUrl(todayStart.getTime(), end.getTime()), key)
                            .then(Lib.parseModelUsage).catch(() => empty('today'))
                        : empty('today'),
                    key
                        ? this._fetchJSON(Lib.usageUrl(weekStart.getTime(), end.getTime()), key)
                            .then(Lib.parseModelUsage).catch(() => empty('week'))
                        : empty('week'),
                    dsToken
                        ? this._fetchDsJSON('/api/v0/users/get_user_summary', dsToken)
                            .then(Lib.parseDsBalance).catch(() => empty('ds').balance)
                        : empty('ds').balance,
                    dsToken
                        ? this._fetchDsJSON(
                            this._dsUsageUrl('/api/v0/usage/by_api_key/cost',
                                todayStart.getTime(), tomorrowStart), dsToken)
                            .then(Lib.parseDsCost).catch(() => null)
                        : null,
                    dsToken
                        ? this._fetchDsJSON(
                            this._dsUsageUrl('/api/v0/usage/by_api_key/cost',
                                weekStart.getTime(), tomorrowStart), dsToken)
                            .then(Lib.parseDsCost).catch(() => null)
                        : null,
                    dsToken
                        ? this._fetchDsJSON(
                            this._dsUsageUrl('/api/v0/usage/by_api_key/amount',
                                todayStart.getTime(), tomorrowStart), dsToken)
                            .then(Lib.parseDsAmount).catch(() => null)
                        : null,
                    dsToken
                        ? this._fetchDsJSON(
                            this._dsUsageUrl('/api/v0/usage/by_api_key/amount',
                                weekStart.getTime(), tomorrowStart), dsToken)
                            .then(Lib.parseDsAmount).catch(() => null)
                        : null,
                ]);
            s.quota = quota;
            s.today = today;
            s.week = week;
            s.ds.balance = dsBalance;
            s.ds.today = Lib.mergeDsUsage(dsCostToday, dsAmountToday);
            s.ds.week = Lib.mergeDsUsage(dsCostWeek, dsAmountWeek);

            const noKey = !key;
            const glmFailed = !s.quota.loaded && !s.today.loaded;
            const src = Lib.sourceLabel(s.quota.loaded, s.quota.level, s.today.loaded); // 按真实抓取结果标注

            // GLM 全部失败（或强制模拟）→ 模拟数据便于看 UI；未配置 key 则不造假数据。
            // DeepSeek 失败只标注不造假（余额/金额不演戏）；仅强制模拟时才给 DeepSeek 模拟值。
            const mock = (forcedMock || (!noKey && glmFailed)) ? Lib.mockSnapshot(now.getTime()) : null;
            if (mock) {
                s.quota = mock.quota;
                s.today = mock.today;
                s.week = mock.week;
                if (forcedMock) s.ds = mock.ds;
            }
            const dsLoaded = s.ds.balance.loaded || s.ds.today.loaded || s.ds.week.loaded;
            s.source = src ?? (mock
                ? (forcedMock ? '模拟数据（TOKENBAR_MOCK）' : '模拟数据（接口不可用）')
                : dsLoaded ? 'DeepSeek 平台账户'
                    : noKey ? '未配置 API key' : '接口不可用');
            s.noKey = noKey;
            s.noDs = !dsToken;
            s.lastRefresh = now;
            this._lastRefreshAt = now.getTime();
            this._snapshot = s;
            log(`TokenBar refresh: ${s.source} 5h=${s.quota.fiveHourPct}% week=${s.quota.weekPct}% ` +
                `today=${Lib.fmtTokens(s.today.totalTokens)}/${s.today.totalCalls} ` +
                `ds=${s.ds.balance.loaded ? '$' + s.ds.balance.balance : '–'} ` +
                `dsToday=${s.ds.today.hasCost ? '$' + s.ds.today.totalCost : '–'}`);
        } catch (e) {
            logError(e, 'TokenBar refresh');
        } finally {
            this._refreshing = false;
            if (this._indicator) {
                this._indicator.render(this._snapshot);
                this._rebuildMenu();
            }
        }
    }

    _onMenuOpen() {
        this._rebuildMenu();
        if (Date.now() - this._lastRefreshAt > OPEN_REFRESH_THROTTLE_SEC * 1000) {
            this._refresh();
        }
    }

    // MARK: 菜单（与 macOS 版下拉面板结构一致）

    _rebuildMenu() {
        if (!this._indicator) return;
        const menu = this._indicator.menu;
        menu.removeAll();
        const s = this._snapshot;

        this._addInfo(menu, `<b>Z.ai / DeepSeek 用量</b>  <small>${Lib.esc(s.source)}</small>`);
        const peak = Lib.isPeakTime(Date.now());
        this._addInfo(menu,
            `<small>${peak ? '🔥 峰时' : '❄️ 闲时'} · ${Lib.esc(Lib.PEAK_DEF)} · ${peak ? '2x' : '1x'} 计费</small>`);

        if (s.quota.loaded) {
            // 只留百分比数字（不画进度条），窗口名 + 着色百分比一行，重置倒计时一行
            this._addSep(menu);
            this._addInfo(menu,
                `<small>5 小时窗口（Coding Plan${s.quota.level ? ' · ' + Lib.esc(s.quota.level) : ''}）</small>` +
                `  <span foreground="${Lib.pctColorHex(s.quota.fiveHourPct)}"><tt><b>${s.quota.fiveHourPct}%</b></tt></span>`);
            this._addInfo(menu, `<small>${Lib.resetText(s.quota.fiveHourResetMs, Date.now())}</small>`);

            this._addSep(menu);
            this._addInfo(menu,
                `<small>周窗口（Coding Plan）</small>` +
                `  <span foreground="${Lib.pctColorHex(s.quota.weekPct)}"><tt><b>${s.quota.weekPct}%</b></tt></span>`);
            this._addInfo(menu, `<small>${Lib.resetText(s.quota.weekResetMs, Date.now())}</small>`);
        }

        // MARK: DeepSeek（余额 + 峰谷；模型明细合并在下方用量列表里）
        const dsAny = s.ds.balance.loaded || s.ds.today.loaded || s.ds.week.loaded;
        if (dsAny || s.noDs) {
            this._addSep(menu);
            this._addInfo(menu, '<small>DeepSeek</small>');
            if (s.ds.balance.loaded) {
                const b = s.ds.balance;
                this._addInfo(menu,
                    `<span foreground="${Lib.budgetColorHex(b.balance)}">余额 ${Lib.fmtMoney(b.balance, b.currency)}</span>`);
            }
            this._addInfo(menu,
                `<small>峰价（太平洋时间）<tt>${Lib.esc(Lib.dsPeakWindowsPacific(Date.now()))}</tt> · 周一至五</small>`);
            this._addInfo(menu,
                `<small>当前 ${Lib.esc(Lib.dsStateText(Date.now()))}，其余时段 ❄️ 半价（周末、节假日全天谷价）</small>`);
            if (s.noDs) {
                this._addInfo(menu, '<small>未读取到 DeepSeek 凭证：登录 DeepSeek Harness 后自动读取</small>');
                this._addInfo(menu, '<tt>~/.dsh/.credentials.yaml</tt>');
                this._addInfo(menu,
                    '<small>或写入 <tt>~/.config/tokenbar/deepseek.json</tt>（{"token": "..."}）</small>');
            } else if (!dsAny) {
                this._addInfo(menu,
                    '<small>DeepSeek 接口不可用（重新登录 Harness 轮换凭证后会自动恢复）</small>');
            }
        }

        // MARK: 按模型用量（GLM + DeepSeek 合并一个列表，用了哪些列哪些）
        if (s.today.loaded || s.ds.today.loaded) {
            this._addSep(menu);
            this._addUsageSection(menu, '今日 API 用量', s.today, s.ds.today);
        }
        if (s.week.loaded || s.ds.week.loaded) {
            this._addSep(menu);
            this._addUsageSection(menu, '近 7 天 API 用量', s.week, s.ds.week);
        }

        if (s.noKey) {
            this._addSep(menu);
            this._addInfo(menu, '<small>未读取到 API key，请写入：</small>');
            this._addInfo(menu, '<tt>~/.config/tokenbar/config.json</tt>');
            this._addInfo(menu, '<small>格式 {"apiKey": "..."}，或重跑 install.sh --api-key …</small>');
        }

        this._addSep(menu);
        if (s.lastRefresh) {
            this._addInfo(menu, `<small>更新于 ${Lib.clockHM(s.lastRefresh)}，每 5 分钟自动刷新</small>`);
        }
        const refresh = new PopupMenu.PopupMenuItem('立即刷新');
        refresh.connect('activate', () => {
            this._lastRefreshAt = 0;
            this._refresh();
        });
        menu.addMenuItem(refresh);
        const disable = new PopupMenu.PopupMenuItem('禁用 TokenBar');
        disable.connect('activate', () => {
            try {
                Main.extensionManager.disableExtension(this.uuid);
            } catch (e) {
                logError(e, 'TokenBar disable');
            }
        });
        menu.addMenuItem(disable);
    }

    // 分隔线（收紧上下留白）
    _addSep(menu) {
        const sep = new PopupMenu.PopupSeparatorMenuItem();
        sep.set_style('padding-top: 3px; padding-bottom: 3px;');
        menu.addMenuItem(sep);
    }

    // GLM + DeepSeek 合并的按模型用量：用了哪些列哪些；能直接换算钱的（DeepSeek 有
    // 真实计费）在模型行末尾括号里加金额。GLM 是订阅制没有直接费用，只列 token。
    _addUsageSection(menu, title, glm, ds) {
        const parts = [];
        if (glm.loaded && (glm.totalTokens || glm.totalCalls)) {
            parts.push(`GLM <tt>${Lib.fmtTokens(glm.totalTokens)}</tt> tok · <tt>${Lib.fmtCalls(glm.totalCalls)}</tt> 次`);
        }
        if (ds.loaded && ds.hasCost) {
            parts.push(`DS <tt>${Lib.fmtMoney(ds.totalCost, ds.currency)}</tt>`);
        }
        this._addInfo(menu, `<small>${Lib.esc(title)}</small>${parts.length ? '  ' + parts.join(' · ') : ''}`);
        const rows = [
            ...glm.models.map(m => ({name: m.name, tokens: m.tokens, cost: null})),
            ...ds.models.map(m => ({name: m.name, tokens: m.tokens, cost: ds.hasCost ? m.cost : null})),
        ].sort((a, b) => b.tokens - a.tokens);
        for (const m of rows.slice(0, 6)) {
            const cost = m.cost != null ? `（约 ${Lib.fmtMoney(m.cost, ds.currency)}）` : '';
            this._addInfo(menu, `${Lib.esc(m.name)}  <tt>${Lib.fmtTokens(m.tokens)}</tt>${cost}`);
        }
    }

    // 信息行（收紧行距：默认 popup 行 padding 偏大）
    _addInfo(menu, markup) {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        item.set_style('padding-top: 2px; padding-bottom: 2px;');
        item.label.clutter_text.set_markup(markup);
        menu.addMenuItem(item);
        return item;
    }
}
