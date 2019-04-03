const Clutter     = imports.gi.Clutter;
const Gio         = imports.gi.Gio;
const Mainloop    = imports.mainloop;
const Meta        = imports.gi.Meta;
const Shell       = imports.gi.Shell;
const St          = imports.gi.St;
const PolicyType  = imports.gi.Gtk.PolicyType;
const Util        = imports.misc.util;
const MessageTray = imports.ui.messageTray;

const Main      = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const CheckBox  = imports.ui.checkBox.CheckBox;

const Gettext = imports.gettext;
const _ = Gettext.domain('clipboard-indicator').gettext;

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const SETTING_KEY_CLEAR_HISTORY = 'clear-history';
const SETTING_KEY_PREV_ENTRY = 'prev-entry';
const SETTING_KEY_NEXT_ENTRY = 'next-entry';
const SETTING_KEY_TOGGLE_MENU = 'toggle-menu';
const INDICATOR_ICON = 'edit-paste-symbolic';

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const Prefs = Me.imports.prefs;
const prettyPrint = Utils.prettyPrint;
const writeRegistry = Utils.writeRegistry;
const readRegistry = Utils.readRegistry;

let TIMEOUT_MS           = 1000;
let MAX_REGISTRY_LENGTH  = 15;
let MAX_ENTRY_LENGTH     = 50;
let CACHE_ONLY_FAVORITE  = false;
let DELETE_ENABLED       = true;
let ENABLE_KEYBINDING    = true;
let PRIVATEMODE          = false;
let NOTIFY_ON_COPY       = true;
let MAX_TOPBAR_LENGTH    = 15;
let TOPBAR_DISPLAY_MODE  = 1; //0 - only icon, 1 - only clipbord content, 2 - both

var ClipboardIndicator = class ClipboardIndicator {
    constructor () {
        this.panelMenuBtn = new PanelMenu.Button(0.0, "Clipboard Indicator", false);
        this.shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];
        this.settingsChangedId = null;
        this.clipboardTimeoutId = null;
        this.historyLabelTimeoutId = null;
        this.historyLabel = null;
        this.buttonText = null;

        let hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box clipboard-indicator-hbox' });
        this.icon = new St.Icon({ icon_name: INDICATOR_ICON,
                  style_class: 'system-status-icon clipboard-indicator-icon' });
        hbox.add_child(this.icon);
        this.buttonText = new St.Label({
            text: _("Text will be here"),
            y_align: Clutter.ActorAlign.CENTER
        });
        hbox.add_child(this.buttonText);
        hbox.add(PopupMenu.arrowIcon(St.Side.BOTTOM));
        this.panelMenuBtn.actor.add_child(hbox);

        this.createHistoryLabel();
        this.loadSettings();
        this.buildMenu();
        this.updateTopbarLayout();
        this.setupTimeout();
    }

    destroy () {
        this.disconnectSettings();
        this.unbindShortcuts();
        this.clearClipboardTimeout();
        this.clearLabelTimeout();
        this.clearDelayedSelectionTimeout();

        // Call parent
        this.panelMenuBtn.destroy();
    }

    updateButtonText (content) {
        if (!content || PRIVATEMODE) {
            this.buttonText.set_text('…');
        } else {
            this.buttonText.set_text(this.truncate(content, MAX_TOPBAR_LENGTH));
        }
    }

    buildMenu () {
        let that = this;
        this.getCache(function (clipHistory) {
            let lastIdx = clipHistory.length - 1;
            let clipItemsArr = that.clipItemsRadioGroup;

            /* This create the search entry, which is add to a menuItem.
            The searchEntry is connected to the function for research.
            The menu itself is connected to some shitty hack in order to
            grab the focus of the keyboard. */
            that.entryItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            that.searchEntry = new St.Entry({
                name: 'searchEntry',
                style_class: 'search-entry',
                can_focus: true,
                hint_text: ('Type here to search…'),
                track_hover: true
            });

            that.searchEntry.get_clutter_text().connect(
                'text-changed',
                that.onSearchTextChanged.bind(that)
            );

            that.entryItem.actor.add(that.searchEntry, { expand: true });

            that.panelMenuBtn.menu.addMenuItem(that.entryItem);

            that.panelMenuBtn.menu.connect('open-state-changed', (self, open) => {
                let a = Mainloop.timeout_add(50, () => {
                    if (open) {
                        that.searchEntry.set_text('');
                        global.stage.set_key_focus(that.searchEntry);
                    }
                    Mainloop.source_remove(a);
                });
            });

            // Create menu sections for items
            // Favorites
            that.favoritesSection = new PopupMenu.PopupMenuSection();

            that.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
            let favoritesScrollView = new St.ScrollView({
                style_class: 'ci-history-menu-section',
                overlay_scrollbars: true
            });
            favoritesScrollView.add_actor(that.favoritesSection.actor);

            that.scrollViewFavoritesMenuSection.actor.add_actor(favoritesScrollView);

            that.panelMenuBtn.menu.addMenuItem(that.scrollViewFavoritesMenuSection);

            // History
            that.historySection = new PopupMenu.PopupMenuSection();

            that.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
            let historyScrollView = new St.ScrollView({
                style_class: 'ci-history-menu-section',
                overlay_scrollbars: true
            });
            historyScrollView.add_actor(that.historySection.actor);

            that.scrollViewMenuSection.actor.add_actor(historyScrollView);

            that.panelMenuBtn.menu.addMenuItem(that.scrollViewMenuSection);

            // Add cached items
            clipHistory.forEach(function (buffer) {
                if (typeof buffer === 'string') {
                    // Old cache format
                    that.addEntry(buffer);
                } else {
                    that.addEntry(buffer["contents"], buffer["favorite"]);
                }
            });

            // Add separator
            that.panelMenuBtn.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Private mode switch
            that.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
                _("Private mode"), PRIVATEMODE, { reactive: true });
            that.privateModeMenuItem.connect('toggled', that.onPrivateModeSwitch.bind(that));
            that.panelMenuBtn.menu.addMenuItem(that.privateModeMenuItem);
            that.onPrivateModeSwitch();

            // Add 'Clear' button which removes all items from cache
            let clearMenuItem = new PopupMenu.PopupMenuItem(_("Clear history"));
            that.panelMenuBtn.menu.addMenuItem(clearMenuItem);
            clearMenuItem.connect('activate', that.removeAll.bind(that));

            // Add 'Settings' menu item to open settings
            let settingsMenuItem = new PopupMenu.PopupMenuItem(_("Settings"));
            that.panelMenuBtn.menu.addMenuItem(settingsMenuItem);
            settingsMenuItem.connect('activate', that.openSettings.bind(that));

            if (lastIdx >= 0) {
                that.selectMenuItem(clipItemsArr[lastIdx]);
            }
        });
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    onSearchTextChanged () {
        let searchedText = this.searchEntry.get_text().toLowerCase();

        if (searchedText === '') {
            this.getAllIMenuItems().forEach(function(mItem){
                mItem.actor.visible = true;
            });
        } else {
            this.getAllIMenuItems().forEach(function(mItem){
                let text = mItem.clipContents.toLowerCase();
                let isMatching = text.indexOf(searchedText) >= 0;
                mItem.actor.visible = isMatching
            });
        }
    }

    truncate (string, length) {
        let shortened = string.replace(/\s+/g, ' ');
        if (shortened.length > length)
            shortened = shortened.substring(0,length-1) + '…';

        return shortened;
    }

    setEntryLabel (menuItem) {
        let buffer = menuItem.clipContents;
        menuItem.label.set_text(this.truncate(buffer, MAX_ENTRY_LENGTH));
    }

    addEntry (buffer, favorite, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.panelMenuBtn.menu;
        menuItem.clipContents = buffer;
        menuItem.clipFavorite = favorite;
        menuItem.radioGroup = this.clipItemsRadioGroup;
        menuItem.buttonPressId = menuItem.connect('activate',
                           this.onMenuItemSelectedAndMenuClose.bind(menuItem));

        this.setEntryLabel(menuItem);
        this.clipItemsRadioGroup.push(menuItem);

        // Favorite button
        let icon_name = favorite ? 'starred-symbolic' : 'non-starred-symbolic';
        let iconfav = new St.Icon({
            icon_name: icon_name,
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-action-btn',
            x_fill: true,
            can_focus: true,
            child: iconfav
        });

        icofavBtn.set_x_align(Clutter.ActorAlign.END);
        icofavBtn.set_x_expand(true);
        icofavBtn.set_y_expand(true);

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        menuItem.favoritePressId = icofavBtn.connect('button-press-event',
                                     () => { this.favoriteToggle(menuItem); });

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            x_fill: true,
            can_focus: true,
            child: icon
        });

        icoBtn.set_x_align(Clutter.ActorAlign.END);
        icoBtn.set_x_expand(false);
        icoBtn.set_y_expand(true);

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('button-press-event',
                              () => { this.removeEntry(menuItem, 'delete'); });

        if (favorite) {
            this.favoritesSection.addMenuItem(menuItem, 0);
        } else {
            this.historySection.addMenuItem(menuItem, 0);
        }

        if (autoSelect === true) this.selectMenuItem(menuItem, autoSetClip);

        if (TOPBAR_DISPLAY_MODE === 1 || TOPBAR_DISPLAY_MODE === 2)
            this.updateButtonText(buffer);

        this.updateCache();
    }

    favoriteToggle (menuItem) {
        menuItem.clipFavorite = menuItem.clipFavorite ? false : true;
        this.moveItemFirst(menuItem);
        this.updateCache();
    }

    removeAll () {
        let that = this;
        // We can't actually remove all items, because the clipboard still
        // has data that will be re-captured on next refresh, so we remove
        // all except the currently selected item
        // Don't remove favorites here
        that.historySection.getMenuItems().forEach(function (mItem) {
            if (!mItem.currentlySelected) {
                let idx = that.clipItemsRadioGroup.indexOf(mItem);
                mItem.destroy();
                that.clipItemsRadioGroup.splice(idx,1);
            }
        });
        that.updateCache();
        that.showNotification(_("Clipboard history cleared"));
    }

    removeEntry (menuItem, event) {
        let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

        if (event === 'delete' && menuItem.currentlySelected)
            Clipboard.set_text(CLIPBOARD_TYPE, "");

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(itemIdx,1);
        this.updateCache();
    }

    removeOldestEntries () {
        let that = this;

        let clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
            item => item.clipFavorite === false);

        while (clipItemsRadioGroupNoFavorite.length > MAX_REGISTRY_LENGTH) {
            let oldestNoFavorite = clipItemsRadioGroupNoFavorite.shift();
            that.removeEntry(oldestNoFavorite);

            clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
                item => item.clipFavorite === false);
        }

        that.updateCache();
    }

    onMenuItemSelected (autoSet) {
        var that = this;
        that.radioGroup.forEach(function (menuItem) {
            let clipContents = that.clipContents;

            if (menuItem === that && clipContents) {
                that.setOrnament(PopupMenu.Ornament.DOT);
                that.currentlySelected = true;
                if (autoSet !== false)
                    Clipboard.set_text(CLIPBOARD_TYPE, clipContents);
            } else {
                menuItem.setOrnament(PopupMenu.Ornament.NONE);
                menuItem.currentlySelected = false;
            }
        });
    }

    selectMenuItem (menuItem, autoSet) {
        let fn = this.onMenuItemSelected.bind(menuItem);
        fn(autoSet);
    }

    onMenuItemSelectedAndMenuClose (autoSet) {
        var that = this;
        that.radioGroup.forEach(function (menuItem) {
            let clipContents = that.clipContents;

            if (menuItem === that && clipContents) {
                that.setOrnament(PopupMenu.Ornament.DOT);
                that.currentlySelected = true;
                if (autoSet !== false)
                    Clipboard.set_text(CLIPBOARD_TYPE, clipContents);
            } else {
                menuItem.setOrnament(PopupMenu.Ornament.NONE);
                menuItem.currentlySelected = false;
            }
        });

        that.panelMenuBtn.menu.close();
    }

    getCache (cb) {
        return readRegistry(cb);
    }

    updateCache () {
        let registry = this.clipItemsRadioGroup.map(function (menuItem) {
            return {
                      "contents" : menuItem.clipContents,
                      "favorite" : menuItem.clipFavorite
                   };
        });

        writeRegistry(registry.filter(function (menuItem) {
            if (CACHE_ONLY_FAVORITE) {
                if (menuItem['favorite']) {
                    return menuItem;
                }
            } else {
                return menuItem;
            }
        }));
    }

    refreshIndicator () {
//        if (PRIVATEMODE) return; // Private mode, do not.

        let that = this;

        Clipboard.get_text(CLIPBOARD_TYPE, function (clipBoard, text) {
            if (text !== "") {
                let registry = that.clipItemsRadioGroup.map(function (menuItem) {
                    return menuItem.clipContents;
                });

                if (text && registry.indexOf(text) < 0) {
                    that.addEntry(text, false, true, false);
                    that.removeOldestEntries();
                    if (NOTIFY_ON_COPY)
                        that.showNotification(_("Copied to clipboard"));
                } else if (text && registry.indexOf(text) >= 0 &&
                           registry.indexOf(text) < registry.length - 1) {
                    // If exists
                    let item = that.findItem(text);
                    if (item.clipFavorite) {
                        that.selectMenuItem(item);
                    } else {
                        item.currentlySelected = true;
                        that.moveItemFirst(item);
                    }
                }
            }
        });
    }

    moveItemFirst (item) {
        this.removeEntry(item);
        this.addEntry(item.clipContents, item.clipFavorite, item.currentlySelected, false);
    }

    findItem (text) {
        return this.clipItemsRadioGroup.filter(item => item.clipContents === text)[0];
    }

    getAllIMenuItems (text) {
        return this.historySection.getMenuItems().concat(this.favoritesSection.getMenuItems());
    }

    setupTimeout (reiterate) {
        let that = this;
        reiterate = typeof reiterate === 'boolean' ? reiterate : true;

        this.clipboardTimeoutId = Mainloop.timeout_add(TIMEOUT_MS, function () {
            that.refreshIndicator();

            // If the timeout handler returns `false`, the source is
            // automatically removed, so we reset the timeout-id so it won't
            // be removed on `.destroy()`
            if (reiterate === false)
                that.clipboardTimeoutId = null;

            // As long as the timeout handler returns `true`, the handler
            // will be invoked again and again as an interval
            return reiterate;
        });
    }

    openSettings () {
        Util.spawn(['gnome-shell-extension-prefs', Me.uuid]);
    }

    initNotifSource () {
        if (!this.notifSource) {
            this.notifSource = new MessageTray.Source('ClipboardIndicator',
                                                       INDICATOR_ICON);
            this.notifSource.connect('destroy', () => { this.notifSource = null; });
            Main.messageTray.add(this.notifSource);
        }
    }

    showNotification (message) {
        let notification = null;
        this.initNotifSource();

        if (this.notifSource.count === 0) {
            notification = new MessageTray.Notification(this.notifSource, message);
        } else {
            notification = this.notifSource.notifications[0];
            notification.update(message, '', { clear: true });
        }

        notification.setTransient(true);
        this.notifSource.notify(notification);
    }

    createHistoryLabel () {
        this.historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_actor(this.historyLabel);
        this.historyLabel.hide();
    }

    onPrivateModeSwitch () {
        let that = this;
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            let selectList = this.clipItemsRadioGroup.filter((item) => !!item.currentlySelected);
            Clipboard.get_text(CLIPBOARD_TYPE, function (clipBoard, text) {
                that.updateButtonText(text);
            });
            if (selectList.length) {
                this.selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                Clipboard.set_text(CLIPBOARD_TYPE, "");
            }

            this.icon.remove_style_class_name('private-mode');
        } else {
            this.buttonText.set_text('…');
            this.icon.add_style_class_name('private-mode');
        }
    }

    loadSettings () {
        this.settings = Prefs.SettingsSchema;
        this.settingsChangedId = this.settings.connect('changed', this.onSettingsChange.bind(this));
        this.fetchSettings();
        if (ENABLE_KEYBINDING) this.bindShortcuts();
    }

    fetchSettings () {
        TIMEOUT_MS           = this.settings.get_int(Prefs.Fields.INTERVAL);
        MAX_REGISTRY_LENGTH  = this.settings.get_int(Prefs.Fields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH     = this.settings.get_int(Prefs.Fields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE  = this.settings.get_boolean(Prefs.Fields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED       = this.settings.get_boolean(Prefs.Fields.DELETE);
        NOTIFY_ON_COPY       = this.settings.get_boolean(Prefs.Fields.NOTIFY_ON_COPY);
        ENABLE_KEYBINDING    = this.settings.get_boolean(Prefs.Fields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH    = this.settings.get_int(Prefs.Fields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE  = this.settings.get_int(Prefs.Fields.TOPBAR_DISPLAY_MODE_ID);
    }

    onSettingsChange () {
        var that = this;

        // Load the settings into variables
        that.fetchSettings();

        // Remove old entries in case the registry size changed
        that.removeOldestEntries();

        // Re-set menu-items lables in case preview size changed
        this.getAllIMenuItems().forEach(function (mItem) {
            that.setEntryLabel(mItem);
        });

        //update topbar
        this.updateTopbarLayout();
        if (TOPBAR_DISPLAY_MODE === 1 || TOPBAR_DISPLAY_MODE === 2) {
            Clipboard.get_text(CLIPBOARD_TYPE, function (clipBoard, text) {
                that.updateButtonText(text);
            });
        }

        // Bind or unbind shortcuts
        if (ENABLE_KEYBINDING) {
            that.bindShortcuts();
        } else {
            that.unbindShortcuts();
        }
    }

    bindShortcuts () {
        this.unbindShortcuts();
        this.bindShortcut(SETTING_KEY_CLEAR_HISTORY, this.removeAll);
        this.bindShortcut(SETTING_KEY_PREV_ENTRY, this.previousEntry);
        this.bindShortcut(SETTING_KEY_NEXT_ENTRY, this.nextEntry);
        this.bindShortcut(SETTING_KEY_TOGGLE_MENU, this.toggleMenu);
    }

    unbindShortcuts () {
        this.shortcutsBindingIds.forEach((id) => Main.wm.removeKeybinding(id));
        this.shortcutsBindingIds = [];
    }

    bindShortcut(name, cb) {
        var ModeType = Shell.hasOwnProperty('ActionMode') ?
            Shell.ActionMode : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            name,
            this.settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            cb.bind(this)
        );

        this.shortcutsBindingIds.push(name);
    }

    updateTopbarLayout () {
        if (TOPBAR_DISPLAY_MODE === 0) {
            this.icon.visible = true;
            this.buttonText.visible = false;
        } else if (TOPBAR_DISPLAY_MODE === 1) {
            this.icon.visible = false;
            this.buttonText.visible = true;
        } else if (TOPBAR_DISPLAY_MODE === 2) {
            this.icon.visible = true;
            this.buttonText.visible = true;
        }
    }

    disconnectSettings () {
        if (!this.settingsChangedId) return;
        this.settings.disconnect(this.settingsChangedId);
        this.settingsChangedId = null;
    }

    clearClipboardTimeout () {
        if (!this.clipboardTimeoutId) return;
        Mainloop.source_remove(this.clipboardTimeoutId);
        this.clipboardTimeoutId = null;
    }

    clearLabelTimeout () {
        if (!this.historyLabelTimeoutId) return;
        Mainloop.source_remove(this.historyLabelTimeoutId);
        this.historyLabelTimeoutId = null;
    }

    clearDelayedSelectionTimeout () {
        if (this.delayedSelectionTimeoutId)
            Mainloop.source_remove(this.delayedSelectionTimeoutId);
    }

    selectEntryWithDelay (entry) {
        let that = this;
        that.selectMenuItem(entry, false);

        that.delayedSelectionTimeoutId = Mainloop.timeout_add(TIMEOUT_MS * 0.75,
                                                               function () {
            that.selectMenuItem(entry); //select the item
            that.delayedSelectionTimeoutId = null;
            return false;
        });
    }

    previousEntry () {
        let that = this;
        that.clearDelayedSelectionTimeout();

        this.getAllIMenuItems().some(function (mItem, i, menuItems) {
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed
                that.showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].label.text);
                that.selectEntryWithDelay(menuItems[i]);
                return true;
            }
            return false;
        });
    }

    nextEntry () {
        let that = this;
        that.clearDelayedSelectionTimeout();

        this.getAllIMenuItems().some(function (mItem, i, menuItems) {
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                   //index to be displayed
                that.showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].label.text);
                that.selectEntryWithDelay(menuItems[i]);
                return true;
            }
            return false;
        });
    }

    toggleMenu () {
        this.panelMenuBtn.menu.toggle();
    }

};


function init () {
    let localeDir = Me.dir.get_child('locale');
    Gettext.bindtextdomain('clipboard-indicator', localeDir.get_path());
}

let clipboardIndicator;
function enable () {
    clipboardIndicator = new ClipboardIndicator();
    Main.panel.addToStatusArea('clipboardIndicator', clipboardIndicator.panelMenuBtn, 1);
}

function disable () {
    clipboardIndicator.destroy();
}

