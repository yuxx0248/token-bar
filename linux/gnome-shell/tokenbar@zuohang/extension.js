//
//  extension.js — TokenBar GNOME Shell 扩展（macOS 菜单栏版的 Linux 移植）
//
//  顶栏：⚡<5h>% · <周>%，点击弹面板；数据源与刷新策略见顶层 README。
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
const REFRESH_SEC = 300;              // 数据自动刷新间隔（macOS 版同款）
const RENDER_SEC = 30;                // 菜单重绘间隔（刷新重置倒计时等相对时间）
const OPEN_REFRESH_THROTTLE_SEC = 30; // 打开菜单触发刷新的最小间隔

const Indicator = GObject.registerClass(
class TokenBarIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'TokenBar');
        this._bolt = new St.Label({text: '⚡', y_align: Clutter.ActorAlign.CENTER});
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
        for (const w of [this._bolt, this._five, this._sep, this._week]) this.add_child(w);
    }

    render(snap) {
        if (!snap.quota.loaded && !snap.today.loaded) {
            // 没有任何真实数据（未配置 key 等）：显示 –
            this._five.text = '–%';
            this._five.style_class = 'tokenbar-strong tokenbar-dim';
            this._week.text = '–%';
            this._week.style_class = 'tokenbar-dim';
            return;
        }
        this._five.text = `${snap.quota.fiveHourPct}%`;
        this._five.style_class = `tokenbar-strong ${Lib.pctClass(snap.quota.fiveHourPct)}`;
        this._week.text = `${snap.quota.weekPct}%`;
        this._week.style_class = Lib.pctClass(snap.quota.weekPct);
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
        Main.panel.addToStatusArea('tokenbar', this._indicator);
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
            source: '加载中…',
            noKey: false,
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

    async _refresh() {
        if (this._refreshing) return;
        this._refreshing = true;
        try {
            const now = new Date();
            const forcedMock = GLib.getenv('TOKENBAR_MOCK') === '1';
            const key = forcedMock ? null : this._readApiKey();
            const s = this._emptySnapshot();
            let noKey = false;

            if (!key) {
                noKey = !forcedMock;
            } else {
                const todayStart = new Date(now);
                todayStart.setHours(0, 0, 0, 0);
                const end = new Date(now);
                end.setHours(23, 59, 59, 999);
                const weekStart = new Date(todayStart);
                weekStart.setDate(weekStart.getDate() - 6);

                const [quota, today, week] = await Promise.all([
                    this._fetchJSON('/api/monitor/usage/quota/limit', key)
                        .then(Lib.parseQuota)
                        .catch(() => this._emptySnapshot().quota),
                    this._fetchJSON(Lib.usageUrl(todayStart.getTime(), end.getTime()), key)
                        .then(Lib.parseModelUsage)
                        .catch(() => this._emptySnapshot().today),
                    this._fetchJSON(Lib.usageUrl(weekStart.getTime(), end.getTime()), key)
                        .then(Lib.parseModelUsage)
                        .catch(() => this._emptySnapshot().week),
                ]);
                s.quota = quota;
                s.today = today;
                s.week = week;
            }

            // 全部失败（或强制模拟）→ 展示模拟数据便于看 UI；未配置 key 则不造假数据
            if (forcedMock || (!noKey && !s.quota.loaded && !s.today.loaded)) {
                const mock = Lib.mockSnapshot(now.getTime());
                s.quota = mock.quota;
                s.today = mock.today;
                s.week = mock.week;
            }
            const src = Lib.sourceLabel(s.quota.loaded, s.quota.level, s.today.loaded);
            s.source = src ?? (noKey
                ? '未配置 API key'
                : forcedMock ? '模拟数据（TOKENBAR_MOCK）' : '模拟数据（接口不可用）');
            s.noKey = noKey;
            s.lastRefresh = now;
            this._lastRefreshAt = now.getTime();
            this._snapshot = s;
            log(`TokenBar refresh: ${s.source} 5h=${s.quota.fiveHourPct}% week=${s.quota.weekPct}% ` +
                `today=${Lib.fmtTokens(s.today.totalTokens)}/${s.today.totalCalls}`);
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

        this._addInfo(menu, `<b>Z.ai 用量</b>  <small>${Lib.esc(s.source)}</small>`);

        if (s.quota.loaded) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addInfo(menu,
                `<small>5 小时窗口（Coding Plan${s.quota.level ? ' · ' + Lib.esc(s.quota.level) : ''}）</small>`);
            this._addInfo(menu, Lib.progressBar(s.quota.fiveHourPct));
            this._addInfo(menu, `<small>${Lib.resetText(s.quota.fiveHourResetMs, Date.now())}</small>`);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addInfo(menu, '<small>周窗口（Coding Plan）</small>');
            this._addInfo(menu, Lib.progressBar(s.quota.weekPct));
            this._addInfo(menu, `<small>${Lib.resetText(s.quota.weekResetMs, Date.now())}</small>`);
        }

        if (s.today.loaded) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addInfo(menu, '<small>今日 API 用量（账户级 · 含所有 agent）</small>');
            this._addInfo(menu,
                `<tt>${Lib.fmtTokens(s.today.totalTokens)}</tt> tokens · <tt>${Lib.fmtCalls(s.today.totalCalls)}</tt> 次调用`);
            for (const m of s.today.models.slice(0, 4)) {
                this._addInfo(menu, `${Lib.esc(m.name)}  <tt>${Lib.fmtTokens(m.tokens)}</tt>`);
            }
            if (s.today.hourly.length) {
                const spark = Lib.sparkline(Lib.trimTrailingZeros(s.today.hourly));
                this._addInfo(menu, Lib.sparkMarkup(spark));
            }
        }

        if (s.week.loaded) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addInfo(menu, '<small>近 7 天 API 用量</small>');
            this._addInfo(menu,
                `<tt>${Lib.fmtTokens(s.week.totalTokens)}</tt> tokens · <tt>${Lib.fmtCalls(s.week.totalCalls)}</tt> 次调用`);
            for (const m of s.week.models.slice(0, 4)) {
                this._addInfo(menu, `${Lib.esc(m.name)}  <tt>${Lib.fmtTokens(m.tokens)}</tt>`);
            }
        }

        if (s.noKey) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addInfo(menu, '<small>未读取到 API key，请写入：</small>');
            this._addInfo(menu, '<tt>~/.config/tokenbar/config.json</tt>');
            this._addInfo(menu, '<small>格式 {"apiKey": "..."}，或重跑 install.sh --api-key …</small>');
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
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

    _addInfo(menu, markup) {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        item.label.clutter_text.set_markup(markup);
        menu.addMenuItem(item);
        return item;
    }
}
