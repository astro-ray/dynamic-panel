import Meta from "gi://Meta";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Colors from "./colors.js";

import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

export default class DynamicPanelExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.floatingPanelClass = "dynamic-panel";
        this.floatingPanelMenuClass = "floating-menu";
        this._actorSignalIds = null;
        this._windowSignalIds = null;
        this._delayedTimeoutId = null;
        this.bgcolor = [];
        this.fgcolor = [];
        this._ani = null;
        this._ani2 = null;
        this._updateBgDelay = null;
        this._panelHiddenConnect = null;
        this._squeezeCount = null;
        this._addonTriggers = null;
    }

    enable() {
        // 初始化角色和窗口數組
        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();

        this._animations = new Map();

        this._panelHiddenConnect = null;
        this._squeezeCount = 0;
        this._addonTriggers = {};

        // 讀取設定並開始監控變化
        this._settings = this.getSettings();
        this._actorSignalIds.set(this._settings, [
            this._settings.connect("changed::transparent", () => { this._updatePanelSingleStyle("bg-changed") }),
            this._settings.connect("changed::transparent-menus", () => { this._updatePanelSingleStyle("transparent-menus") }),
            this._settings.connect("changed::transparent-menus-keep-alpha", () => { this._updatePanelSingleStyle("transparent-menus") }),
            this._settings.connect("changed::radius-times", () => { this._updatePanelSingleStyle("radius-times") }),
            this._settings.connect("changed::float-width", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::float-align", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::top-margin", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::side-margin", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::auto-width", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::solid-type", () => { this._updatePanelSingleStyle("allocation-changed") }),
            this._settings.connect("changed::dark-bg-color", () => { this._updatePanelSingleStyle("color-changed") }),
            this._settings.connect("changed::dark-fg-color", () => { this._updatePanelSingleStyle("color-changed") }),
            this._settings.connect("changed::light-bg-color", () => { this._updatePanelSingleStyle("color-changed") }),
            this._settings.connect("changed::light-fg-color", () => { this._updatePanelSingleStyle("color-changed") }),
            this._settings.connect("changed::auto-background", () => { this._updatePanelSingleStyle("color-changed") }),
            this._settings.connect("changed::colors-use-in-static", () => { this._updatePanelSingleStyle("bg-changed") }),
            this._settings.connect("changed::background-mode", () => { this._updatePanelSingleStyle("bg-changed") }),
            this._settings.connect("changed::blur", () => { this._updatePanelSingleStyle("wallpaper-changed") }),
            this._settings.connect("changed::addon-trigger-left", () => { this._updatePanelSingleStyle("trigger-changed") }),
            this._settings.connect("changed::addon-trigger-center", () => { this._updatePanelSingleStyle("trigger-changed") }),
            this._settings.connect("changed::addon-trigger-right", () => { this._updatePanelSingleStyle("trigger-changed") })
        ])

        // 監控總覽界面顯示狀態
        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect("showing", this._updatePanelStyle.bind(this)),
            Main.overview.connect("hidden", this._updatePanelStyle.bind(this))
        ]);

        // 將當前已有窗口加入監控
        for (const metaWindowActor of global.get_window_actors()) {
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);
        }

        // 監控窗口增加和移除
        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect("child-added", this._onWindowActorAdded.bind(this)),
            global.window_group.connect("child-removed", this._onWindowActorRemoved.bind(this))
        ]);

        // 監控工作區切換
        this._actorSignalIds.set(global.window_manager, [
            global.window_manager.connect("switch-workspace", this._updatePanelStyleDelayed.bind(this))
        ]);

        // 監控系統暗黑模式變化
        const settings = new Gio.Settings({ schema: "org.gnome.desktop.interface" });
        this._actorSignalIds.set(settings, [
            settings.connect("changed::color-scheme", () => { this._updatePanelSingleStyle("color-changed") })
        ])
        const bgsettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._actorSignalIds.set(bgsettings, [
            bgsettings.connect('changed::picture-uri', () => { this._updatePanelSingleStyle("wallpaper-changed") })
        ])

        // 更新顏色設定
        this._updateColorSettings();

        // 更新模糊背景
        this._updateBlurredBG();

        // 首次應用主題和樣式
        this._updatePanelStyle();
    }

    disable() {
        // 根據角色和窗口數組移除監控
        for (const actorSignalIds of [this._actorSignalIds, this._windowSignalIds]) {
            for (const [actor, signalIds] of actorSignalIds) {
                for (const signalId of signalIds) {
                    actor.disconnect(signalId);
                }
            }
        }

        // 設定為false，恢復到默認樣式，帶動畫用以優雅退場。（此時所有附加內容就應該已經被清除了）
        this._updatePanelStyle(true, false);

        // 清除自動隱藏功能產生的影響
        this._clearPeekEffect();

        // 二次清理確保附加的內容被清除

        // -- 清除動畫計時器
        GLib.Source.remove(this._delayedTimeoutId);
        GLib.Source.remove(this._ani);
        GLib.Source.remove(this._ani2);
        GLib.Source.remove(this._updateBgDelay);

        // -- 清除基本變量
        this._actorSignalIds = null;
        this._windowSignalIds = null;
        this._delayedTimeoutId = null;
        this._settings = null;
        this.bgcolor = null;
        this.fgcolor = null;
        this._ani = null;
        this._ani2 = null;
        this._updateBgDelay = null;
        this._panelHiddenConnect = null;
        this._squeezeCount = null;

        // -- 清除面板樣式
        Main.panel.remove_style_class_name(this.floatingPanelClass);
        Main.panel.set_style("");
        Main.panel._leftBox.set_style("");
        Main.panel._centerBox.set_style("");
        Main.panel._rightBox.set_style("");

        // -- 清除面板前景色
        for (const element of Object.values(Main.panel.statusArea)) {
            if (element) {
                element.set_style("");
            }
        }
        for (const dot of Main.panel.statusArea.activities.first_child.get_children()) {
            dot._dot.set_style("");
        }

        // -- 清除面板選單樣式
        let panelMenus = [];
        for (const panelButton of Object.values(Main.panel.statusArea)) {
            if (panelButton.menu && panelButton.menu.actor && panelButton.menu.box) panelMenus.push(panelButton.menu);
        }
        for (const pmenu of panelMenus) {
            pmenu.actor.remove_style_class_name(this.floatingPanelMenuClass);
            pmenu.box.set_style("");
        }
        // -- -- 日曆
        const dateMenu = Main.panel.statusArea.dateMenu;
        dateMenu._date.set_style("");
        for (const item of [...dateMenu._calendar.get_children(), ...dateMenu._calendar._topBox.get_children()]) {
            item.set_style("");
        }

        // -- 清除附加觸發區
        for (const trigger of Object.values(this._addonTriggers)) {
            trigger.destroy();
        }
        this._addonTriggers = null;

    }

    // 窗口添加事件
    _onWindowActorAdded(container, metaWindowActor) {
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect("notify::allocation", this._updatePanelStyle.bind(this)),
            metaWindowActor.connect("notify::visible", this._updatePanelStyle.bind(this))
        ]);
    }

    // 窗口被移除事件
    _onWindowActorRemoved(container, metaWindowActor) {
        for (const signalId of this._windowSignalIds.get(metaWindowActor)) {
            metaWindowActor.disconnect(signalId);
        }
        this._windowSignalIds.delete(metaWindowActor);
        this._updatePanelStyle();
    }

    // 切換worksapce時延遲判定
    _updatePanelStyleDelayed() {
        GLib.Source.remove(this._delayedTimeoutId);
        this._delayedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._updatePanelStyle();
            this._delayedTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    // 更新顏色設定
    _updateColorSettings() {
        [this.bgcolor, this.fgcolor] = Colors.getCustomColor(this._settings);

        if (this._settings.get_boolean("auto-background")) {
            const wallpaperSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const wallpaperUri = wallpaperSettings.get_string('picture-uri');
            const imagePath = wallpaperUri.replace(/^file:\/\//, "");
            const modifier = this._isDarkMode() ? "dark" : "light";
            const autoBGC = Colors.getThemeColor(imagePath, modifier);
            this.bgcolor = [autoBGC, autoBGC];
        }

        if (this._settings.get_boolean("blur")) {
            let file = Gio.File.new_for_path('/tmp/vel-dynamic-panel-blurred-bg.jpg');
            let colorIndex = this._isDarkMode() ? 0 : 1;
            if (file.query_exists(null)) {
                const mixed = Colors.colorMix({ r: this.bgcolor[colorIndex][0], g: this.bgcolor[colorIndex][1], b: this.bgcolor[colorIndex][2], a: this._settings.get_int("transparent") / 100 });
                mixed.savev('/tmp/vel-dynamic-panel-mixed-bg.jpg', 'jpeg', [], []);
            }
        }
    }

    // 更新模糊背景
    _updateBlurredBG() {
        if (this._settings.get_boolean("blur")) {
            const wallpaperSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const wallpaperUri = wallpaperSettings.get_string('picture-uri');
            const imagePath = wallpaperUri.replace(/^file:\/\//, "");
            let colorIndex = this._isDarkMode() ? 0 : 1;
            const blurred = Colors.gaussianBlur(this._settings, imagePath, 30);
            blurred.savev('/tmp/vel-dynamic-panel-blurred-bg.jpg', 'jpeg', [], []);
            const mixed = Colors.colorMix({ r: this.bgcolor[colorIndex][0], g: this.bgcolor[colorIndex][1], b: this.bgcolor[colorIndex][2], a: this._settings.get_int("transparent") / 100 });
            mixed.savev('/tmp/vel-dynamic-panel-mixed-bg.jpg', 'jpeg', [], []);
        }
    }

    // 設定附加觸發區域
    _setAddonTrigger(floating) {
        // 清理現有觸發區域
        for (const trigger of Object.values(this._addonTriggers)) {
            trigger.destroy();
        }
        this._addonTriggers = {};
        if (floating) {
            // Activities
            let h = this._settings.get_int("top-margin");
            if (this._settings.get_boolean("addon-trigger-left")) {
                let activities = Main.panel.statusArea.activities;
                let w = Main.panel._leftBox.get_preferred_width(0)[1] + 20;
                let overlay = this._addonTriggers["Activities"] = new St.Bin({
                    style_class: "vel-dp-addon-trigger-left",
                    opacity: 1,
                    reactive: true,
                    x: 0,
                    y: 0,
                    width: w,
                    height: h
                });

                Main.uiGroup.add_child(overlay);

                overlay.connect('button-press-event', () => {
                    activities.menu.open()
                });
            }
            // Date Menu
            if (this._settings.get_boolean("addon-trigger-center")) {
                let dateMenu = Main.panel.statusArea.dateMenu;
                let w = Main.panel._centerBox.get_preferred_width(0)[1] + 20;
                let x = (Main.layoutManager.primaryMonitor.width - w) / 2;
                let overlay = this._addonTriggers["dateMenu"] = new St.Bin({
                    style_class: "vel-dp-addon-trigger-center",
                    opacity: 1,
                    reactive: true,
                    x: x,
                    y: 0,
                    width: w,
                    height: h
                });

                Main.uiGroup.add_child(overlay);

                overlay.connect('button-press-event', () => {
                    dateMenu.menu.open()
                });
            }
            // Quick Settings
            if (this._settings.get_boolean("addon-trigger-right")) {
                let quickSettings = Main.panel.statusArea.quickSettings;
                let w = Main.panel._rightBox.get_preferred_width(0)[1] + 20;
                let overlay = this._addonTriggers["quickSettings"] = new St.Bin({
                    style_class: "vel",
                    opacity: 1,
                    reactive: true,
                    x: Main.layoutManager.primaryMonitor.width - w,
                    y: 0,
                    width: w,
                    height: h
                });

                Main.uiGroup.add_child(overlay);

                overlay.connect('button-press-event', () => {
                    quickSettings.menu.open()
                });
            }
        }
    }

    // 是否為暗黑模式
    _isDarkMode() {
        let settings = new Gio.Settings({ schema: "org.gnome.desktop.interface" });
        return settings.get_string("color-scheme") === "prefer-dark";
    }

    // 是否應用懸浮模式
    _isFloating() {
        const activeWorkspace = global.workspace_manager.get_active_workspace();

        const isNearEnough = activeWorkspace.list_windows().some(metaWindow => {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            if (this._settings.get_int('detection-mode') === 1) {
                return metaWindow.is_on_primary_monitor()
                    && metaWindow.showing_on_its_workspace()
                    && !metaWindow.is_hidden()
                    && metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
                    && !metaWindow.skip_taskbar
                    && (metaWindow.get_maximized() == 3 || metaWindow.get_maximized() == 2);
            } else {
                const verticalPosition = metaWindow.get_frame_rect().y;
                return metaWindow.is_on_primary_monitor()
                    && metaWindow.showing_on_its_workspace()
                    && !metaWindow.is_hidden()
                    && metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
                    && !metaWindow.skip_taskbar
                    && verticalPosition < (this._settings.get_int("top-margin") + Main.layoutManager.panelBox.get_height() + 5) * scale;
            }
        });

        return !isNearEnough;
    }

    // 獲取現有樣式
    _getStyle(obj) {
        const style = obj.get_style();
        const propertiesAndValues = new Object();
        if (style) {
            const regex = /\s*([^:;]+)\s*:\s*([^;]+)\s*;?/g;
            const matches = style.matchAll(regex);
            for (const match of matches) {
                const property = match[1].trim();
                const value = match[2].trim();
                propertiesAndValues[property] = value;
            }
            return propertiesAndValues;
        }
        return {};
    }
    // 更新單個樣式
    _updateStyle(obj, prop, value) {
        // 獲取現有樣式
        const propertiesAndValues = this._getStyle(obj);
        // 更新新樣式並設定回
        let newStyle = [];
        propertiesAndValues[prop] = value;
        if (value == "") {
            delete propertiesAndValues[prop];
        }
        for (const property in propertiesAndValues) {
            const value = propertiesAndValues[property];
            newStyle.push(`${property}: ${value};`);
        }
        newStyle = newStyle.join(" ");
        obj.set_style(newStyle);
    }

    // 清除自動隱藏相關影響
    _clearPeekEffect() {
        PointerWatcher.getPointerWatcher()._removeWatch(this._panelHiddenConnect);
        this._panelHiddenConnect = null;
        Main.panel.remove_style_class_name("peeking");
        Main.panel._leftBox.visible = true;
        Main.panel._centerBox.visible = true;
        Main.panel._rightBox.visible = true;
    }

    // 更新單獨樣式
    _updatePanelSingleStyle(propname) {
        const floating = this._isFloating();
        const bg_areas = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        switch (propname) {
            case "color-changed":
            case "wallpaper-changed":
            case "bg-changed":
                for (const bg_area of bg_areas) {
                    bg_area.set_style("");
                }
                this._updateColorSettings();
                this._setPanelBackground(floating);
                this._setPanelForeground(floating);
                this._setPanelMenuStyle(floating);

                if (propname === "wallpaper-changed") {
                    this._updateBlurredBG();
                }
                break;
            case "transparent-menus":
                this._setPanelMenuStyle(floating);
                break;
            case "radius-times":
                this._setPanelRadius(floating);
                break;
            case "allocation-changed":
                this._setPanelAllocation(floating);
                this._setAddonTrigger(floating);
                if (this._settings.get_boolean("blur")) {
                    GLib.Source.remove(this._updateBgDelay);
                    const startTime = new Date().getTime();
                    const duration = this._settings.get_int("duration");
                    this._updateBgDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                        const currentTime = new Date().getTime();
                        this._setPanelBackground(floating);
                        if (currentTime - startTime <= duration) {
                            return true;
                        }
                    })
                }
                break;
            case "trigger-changed":
                this._setAddonTrigger(floating);
                break;
        }
    }

    // 更新樣式
    _updatePanelStyle(forceUpdate = false, forceFloating = null) {
        if (typeof forceUpdate != "boolean") forceUpdate = false;
        if (Main.panel.has_style_pseudo_class("overview")) {
            this._setPanelBackground(false);
            this._setPanelForeground(false);
            this._setPanelMenuStyle(false);
            this._setPanelAllocation(false);
            this._setPanelRadius(false);
            this._setAddonTrigger(false);
            return;
        }
        if (!Main.layoutManager.primaryMonitor) {
            return;
        }

        const floating = this._isFloating(); // 獲取是否應該懸浮

        if (
            (floating && !Main.panel.has_style_class_name(this.floatingPanelClass)) || // 應該懸浮但未懸浮
            (!floating && Main.panel.has_style_class_name(this.floatingPanelClass))// 不應該懸浮但懸浮
        ) {
            this._clearPeekEffect();
            this._setPanelBackground(floating);
            this._setPanelForeground(floating);
            this._setPanelMenuStyle(floating);
            this._setPanelAllocation(floating);
            this._setPanelRadius(floating);
            this._setAddonTrigger(floating);
        } else if (forceUpdate) {
            if (forceFloating === null) forceFloating = floating;
            this._clearPeekEffect();
            this._setPanelBackground(forceFloating);
            this._setPanelForeground(forceFloating);
            this._setPanelMenuStyle(forceFloating);
            this._setPanelAllocation(forceFloating);
            this._setPanelRadius(forceFloating);
            this._setAddonTrigger(forceFloating);
        }
    }

    // 設定面板背景
    _setPanelBackground(floating) {
        this._ani2 = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            const _transparent = this._settings.get_int("transparent") / 100;
            this._updateStyle(Main.panel, "transition", `${this._settings.get_int("duration")}ms`);
            let bg_areas = [Main.panel];
            if (this._settings.get_int('background-mode') === 1) {
                this._updateStyle(Main.panel, "background-color", `rgba(0, 0, 0, 0)`);
                this._updateStyle(Main.panel, "background-image", "");
                this._updateStyle(Main.panel, "background-size", "");
                this._updateStyle(Main.panel, "background-position", "");
                bg_areas = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
                const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const panelHeight = Main.panel.get_height() / 2 * (this._settings.get_int("radius-times") / 100) * scale;
                for (const bg_area of bg_areas) {
                    this._updateStyle(bg_area, "border-radius", `${panelHeight}px`);
                }
            }

            if (Main.panel.has_style_pseudo_class("overview")) {
                Main.panel.remove_style_class_name(this.floatingPanelClass);
                for (const bg_area of bg_areas) {
                    this._updateStyle(bg_area, "background-color", `rgba(0, 0, 0, 0)`);
                    this._updateStyle(bg_area, "background-image", "");
                }
            } else if (floating) {
                Main.panel.add_style_class_name(this.floatingPanelClass);
                if (this._settings.get_boolean("blur")) {
                    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    const panelHeight = Main.panel.get_height();
                    const maxHeight = (this._settings.get_int("top-margin") + panelHeight + 5) * scale;
                    if (this._settings.get_int('background-mode') === 1) {
                        for (const bg_area of bg_areas) {
                            this._updateStyle(bg_area, "background-image", "url(/tmp/vel-dynamic-panel-mixed-bg.jpg)");
                            this._updateStyle(bg_area, "background-size", `${Main.layoutManager.primaryMonitor.width}px ${maxHeight + 20}px`);
                            this._updateStyle(bg_area, "background-position", `-${Main.layoutManager.panelBox.translation_x + bg_area.x}px -${Main.layoutManager.panelBox.translation_y + bg_area.y + 20}px`);
                        }
                    } else {
                        for (const bg_area of bg_areas) {
                            this._updateStyle(bg_area, "background-image", "url(/tmp/vel-dynamic-panel-mixed-bg.jpg)");
                            this._updateStyle(bg_area, "background-size", `${Main.layoutManager.primaryMonitor.width}px ${maxHeight + 20}px`);
                            this._updateStyle(bg_area, "background-position", `-${Main.layoutManager.panelBox.translation_x}px -${Main.layoutManager.panelBox.translation_y + 20}px`);
                        }
                    }
                } else {
                    this._updateStyle(Main.panel, "background-image", "");
                    this._updateStyle(Main.panel, "background-size", "");
                    this._updateStyle(Main.panel, "background-position", "");
                    for (const bg_area of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
                        this._updateStyle(bg_area, "background-image", "");
                        this._updateStyle(bg_area, "background-size", "");
                        this._updateStyle(bg_area, "background-position", "");
                    }
                    if (this._isDarkMode()) {
                        for (const bg_area of bg_areas) {
                            this._updateStyle(bg_area, "background-color", `rgba(${this.bgcolor[0][0]}, ${this.bgcolor[0][1]}, ${this.bgcolor[0][2]}, ${_transparent})`);
                        }
                    } else {
                        for (const bg_area of bg_areas) {
                            this._updateStyle(bg_area, "background-color", `rgba(${this.bgcolor[1][0]}, ${this.bgcolor[1][1]}, ${this.bgcolor[1][2]}, ${_transparent})`);
                        }
                    }
                }
            } else if (this._settings.get_int("solid-type") == 1) {
                Main.panel.remove_style_class_name(this.floatingPanelClass);
                this._updateStyle(Main.panel, "background-image", "");
                if (this._isDarkMode()) {
                    for (const bg_area of bg_areas) {
                        this._updateStyle(bg_area, "background-color", `rgba(${this.bgcolor[0][0]}, ${this.bgcolor[0][1]}, ${this.bgcolor[0][2]}, ${_transparent})`);
                    }
                } else {
                    for (const bg_area of bg_areas) {
                        this._updateStyle(bg_area, "background-color", `rgba(${this.bgcolor[1][0]}, ${this.bgcolor[1][1]}, ${this.bgcolor[1][2]}, ${_transparent})`);
                    }
                }
            } else if (this._settings.get_boolean("colors-use-in-static")) {
                Main.panel.remove_style_class_name(this.floatingPanelClass);
                this._updateStyle(Main.panel, "background-image", "");
                for (const bg_area of bg_areas) {
                    bg_area.set_style("");
                }
                if (this._isDarkMode()) {
                    this._updateStyle(Main.panel, "background-color", `rgba(${this.bgcolor[0][0]}, ${this.bgcolor[0][1]}, ${this.bgcolor[0][2]}, 1)`);
                } else {
                    this._updateStyle(Main.panel, "background-color", `rgba(${this.bgcolor[1][0]}, ${this.bgcolor[1][1]}, ${this.bgcolor[1][2]}, 1)`);
                }
            } else {
                for (const bg_area of bg_areas) {
                    bg_area.set_style("");
                }
                Main.panel.remove_style_class_name(this.floatingPanelClass);
                Main.panel.set_style("");
            }
        })
    }

    // 設定面板前景
    _setPanelForeground(floating) {
        const colorSet = this._isDarkMode() ? 0 : 1;
        const _panelButtons = Object.values(Main.panel.statusArea);
        if (floating || this._settings.get_boolean("colors-use-in-static")) {
            for (const element of _panelButtons) {
                this._updateStyle(element, "color", `rgb(${this.fgcolor[colorSet][0]}, ${this.fgcolor[colorSet][1]}, ${this.fgcolor[colorSet][2]})`);
            }
            for (const dot of Main.panel.statusArea.activities.first_child.get_children()) {
                this._updateStyle(dot._dot, "background-color", `rgb(${this.fgcolor[colorSet][0]}, ${this.fgcolor[colorSet][1]}, ${this.fgcolor[colorSet][2]})`);
            }
        } else {
            for (const element of _panelButtons) {
                element.set_style("");
            }
            for (const dot of Main.panel.statusArea.activities.first_child.get_children()) {
                dot._dot.set_style("");
            }
        }
    }

    // 設定面板選單樣式
    _setPanelMenuStyle(floating) {
        const _transparent = this._settings.get_int("transparent") / 100;
        let panelMenus = [];
        for (const panelButton of Object.values(Main.panel.statusArea)) {
            if (panelButton.menu && panelButton.menu.actor && panelButton.menu.box) panelMenus.push(panelButton.menu);
        }
        if (this._settings.get_boolean("transparent-menus")) { // 總開關：是否對面板選單應用樣式
            // Background
            if (floating || (this._settings.get_boolean("transparent-menus-keep-alpha") && this._settings.get_boolean("colors-use-in-static")) || this._settings.get_int("solid-type") == 1) { // 浮動 或 保持透明度的同時將顏色應用到實體模式 或 實體模式為自動隱藏
                for (const pmenu of panelMenus) {
                    pmenu.actor.add_style_class_name(this.floatingPanelMenuClass);
                    if (this._isDarkMode()) {
                        this._updateStyle(pmenu.box, "background-color", `rgba(${this.bgcolor[0][0]}, ${this.bgcolor[0][1]}, ${this.bgcolor[0][2]}, ${_transparent})`);
                    } else {
                        this._updateStyle(pmenu.box, "background-color", `rgba(${this.bgcolor[1][0]}, ${this.bgcolor[1][1]}, ${this.bgcolor[1][2]}, ${_transparent})`);
                    }
                }
            } else if (this._settings.get_boolean("transparent-menus-keep-alpha")) { // 實體模式 未應用自訂顏色 但保持透明度
                for (const pmenu of panelMenus) {
                    pmenu.actor.add_style_class_name(this.floatingPanelMenuClass);
                    if (this._isDarkMode()) {
                        this._updateStyle(pmenu.box, "background-color", `rgba(53, 53, 53, ${_transparent})`);
                    } else {
                        this._updateStyle(pmenu.box, "background-color", `rgba(245, 245, 245, ${_transparent})`);
                    }
                }
            } else if (this._settings.get_boolean("colors-use-in-static")) { // 實體模式 不保持透明度 但應用自訂顏色
                for (const pmenu of panelMenus) {
                    pmenu.actor.add_style_class_name(this.floatingPanelMenuClass);
                    if (this._isDarkMode()) {
                        this._updateStyle(pmenu.box, "background-color", `rgba(${this.bgcolor[0][0]}, ${this.bgcolor[0][1]}, ${this.bgcolor[0][2]}, 1)`);
                    } else {
                        this._updateStyle(pmenu.box, "background-color", `rgba(${this.bgcolor[1][0]}, ${this.bgcolor[1][1]}, ${this.bgcolor[1][2]}, 1)`);
                    }
                }
            } else { // 實體模式 不保持透明度 不應用自訂顏色
                for (const pmenu of panelMenus) {
                    pmenu.actor.add_style_class_name(this.floatingPanelMenuClass);
                    pmenu.box.set_style("");
                }
            }
            // Foreground 
            if (floating || this._settings.get_boolean("colors-use-in-static") || this._settings.get_int("solid-type") == 1) {
                // 普通選單
                for (const pmenu of panelMenus) {
                    if (this._isDarkMode()) {
                        this._updateStyle(pmenu.box, "color", `rgb(${this.fgcolor[0][0]}, ${this.fgcolor[0][1]}, ${this.fgcolor[0][2]})`);
                    } else {
                        this._updateStyle(pmenu.box, "color", `rgb(${this.fgcolor[1][0]}, ${this.fgcolor[1][1]}, ${this.fgcolor[1][2]})`);
                    }
                }
                // 日曆
                const dateMenu = Main.panel.statusArea.dateMenu;
                let fgcolor_rgb = "";
                if (this._isDarkMode()) {
                    fgcolor_rgb = `${this.fgcolor[0][0]}, ${this.fgcolor[0][1]}, ${this.fgcolor[0][2]}`;
                } else {
                    fgcolor_rgb = `${this.fgcolor[1][0]}, ${this.fgcolor[1][1]}, ${this.fgcolor[1][2]}`;
                }
                this._updateStyle(dateMenu._date, "color", `rgba(${fgcolor_rgb}, 0.6)`);
                for (const item of dateMenu._calendar.get_children()) {
                    if (item.has_style_class_name && item.has_style_class_name("calendar-day-heading")) {
                        this._updateStyle(item, "color", `rgba(${fgcolor_rgb}, 0.6)`);
                    }
                }
                this._updateStyle(dateMenu._calendar._backButton, "color", `rgb(${fgcolor_rgb})`);
                this._updateStyle(dateMenu._calendar._monthLabel, "color", `rgb(${fgcolor_rgb})`);
                this._updateStyle(dateMenu._calendar._forwardButton, "color", `rgb(${fgcolor_rgb})`);
            } else {
                // 普通選單
                for (const pmenu of panelMenus) {
                    pmenu.box.set_style("");
                }
                // 日曆
                const dateMenu = Main.panel.statusArea.dateMenu;
                dateMenu._date.set_style("");
                for (const item of [...dateMenu._calendar.get_children(), ...dateMenu._calendar._topBox.get_children()]) {
                    item.set_style("");
                }
            }
        } else { // 未應用樣式 清除樣式
            // 普通選單
            for (const pmenu of panelMenus) {
                pmenu.actor.remove_style_class_name(this.floatingPanelMenuClass);
                pmenu.box.set_style("");
            }
            // 日曆
            const dateMenu = Main.panel.statusArea.dateMenu;
            dateMenu._date.set_style("");
            for (const item of [...dateMenu._calendar.get_children(), ...dateMenu._calendar._topBox.get_children()]) {
                item.set_style("");
            }
        }
    }

    // 設定面板大小和位址
    _setPanelAllocation(floating) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const duration = this._settings.get_int("duration");
        const screenWidth = Main.layoutManager.primaryMonitor.width;
        if (floating) {
            this._clearPeekEffect();

            const align = this._settings.get_int("float-align");
            const topMargin = this._settings.get_int("top-margin");
            const sideMargin = this._settings.get_int("side-margin");
            const minWidth = Main.panel._leftBox.get_preferred_width(0)[1] + Main.panel._centerBox.get_preferred_width(0)[1] + Main.panel._rightBox.get_preferred_width(0)[1] + 20;
            const floating_width = (this._settings.get_boolean('auto-width')) ? minWidth : Math.max(screenWidth * (this._settings.get_int("float-width") / 100), minWidth);
            let x = 0;
            switch (align) {
                case 0:
                    x = sideMargin * scale;
                    break;
                case 1:
                    x = (screenWidth - floating_width) / 2;
                    break;
                case 2:
                    x = (screenWidth - floating_width) - (sideMargin * scale);
                    break
            }
            Main.layoutManager.panelBox.ease({
                translation_y: topMargin * scale,
                translation_x: x,
                width: floating_width,
                duration: duration,
                mode: Clutter.AnimationMode.EASE_OUT_SINE
            })
            if (this._settings.get_boolean("blur")) {
                GLib.Source.remove(this._updateBgDelay);
                const startTime = new Date().getTime();
                const duration = this._settings.get_int("duration");
                this._updateBgDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                    const currentTime = new Date().getTime();
                    this._setPanelBackground(floating);
                    if (currentTime - startTime <= duration) {
                        return true;
                    }
                })
            }
        } else if (this._settings.get_int('solid-type') === 0) {
            this._clearPeekEffect();

            Main.layoutManager.panelBox.ease({
                translation_y: 0,
                translation_x: 0,
                width: screenWidth,
                duration: duration,
                mode: Clutter.AnimationMode.EASE_OUT_SINE
            })
            if (this._settings.get_boolean("blur")) {
                GLib.Source.remove(this._updateBgDelay);
                const startTime = new Date().getTime();
                const duration = this._settings.get_int("duration");
                this._updateBgDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                    const currentTime = new Date().getTime();
                    this._setPanelBackground(floating);
                    if (currentTime - startTime <= duration) {
                        return true;
                    }
                })
            }
        } else {
            if (!this._panelHiddenConnect) {
                Main.layoutManager.panelBox.ease({
                    translation_y: -Main.panel.get_height(),
                    translation_x: screenWidth * 0.01 / 2,
                    width: screenWidth * 0.99,
                    duration: duration,
                    mode: Clutter.AnimationMode.EASE_OUT_SINE
                })
                this._panelHiddenConnect = PointerWatcher.getPointerWatcher().addWatch(100, (x, y) => {
                    if (y > Main.panel.get_height() + 1 && Main.panel.has_style_class_name("peeking")) {
                        Main.panel.remove_style_class_name("peeking");
                        Main.layoutManager.panelBox.ease({
                            translation_y: -Main.panel.get_height(),
                            duration: duration,
                            mode: Clutter.AnimationMode.EASE_IN_SINE
                        })
                        this._squeezeCount = 0;
                    } else if (y == 0 && this._squeezeCount <= 2) {
                        this._squeezeCount++;
                    } else if (this._squeezeCount > 2 && !Main.panel.has_style_class_name("peeking")) {
                        if (this._settings.get_int("background-mode") == 1) {
                            if (x < screenWidth * 0.33) {
                                Main.panel._leftBox.visible = true;
                                Main.panel._centerBox.visible = false;
                                Main.panel._rightBox.visible = false;
                            } else if (x < screenWidth * 0.66) {
                                Main.panel._leftBox.visible = false;
                                Main.panel._centerBox.visible = true;
                                Main.panel._rightBox.visible = false;
                            } else {
                                Main.panel._leftBox.visible = false;
                                Main.panel._centerBox.visible = false;
                                Main.panel._rightBox.visible = true;
                            }
                        } else {
                            Main.panel._leftBox.visible = true;
                            Main.panel._centerBox.visible = true;
                            Main.panel._rightBox.visible = true;
                        }
                        Main.panel.add_style_class_name("peeking");
                        Main.layoutManager.panelBox.ease({
                            translation_y: 1,
                            duration: duration,
                            mode: Clutter.AnimationMode.EASE_OUT_SINE
                        })
                        this._setPanelBackground();
                        this._setPanelRadius();
                    }
                })
            }
        }
    }

    // 設定面板圓角
    _setPanelRadius(floating) {
        const startTime = new Date().getTime();
        const duration = this._settings.get_int("duration");
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panelHeight = Main.panel.get_height() / 2 * (this._settings.get_int("radius-times") / 100) * scale;

        GLib.Source.remove(this._ani);
        let progress = 0;
        this._ani = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            let currentTime = new Date().getTime();
            let elapsedTime = currentTime - startTime;
            progress = Math.min(elapsedTime / duration, 1);
            let currentValue;
            if (floating || this._settings.get_int("solid-type") == 1) {
                currentValue = progress;
            } else {
                currentValue = 1 - progress;
            }

            this._updateStyle(Main.panel, `border-radius`, `${panelHeight * currentValue}px`);

            if (progress < 1) {
                return true;
            }
        })
    }
}