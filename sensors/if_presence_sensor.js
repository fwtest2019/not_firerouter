/*    Copyright 2021 Firewalla Inc
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const Sensor = require('./sensor.js');
const pl = require('../plugins/plugin_loader.js');
const event = require('../core/event.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const fs = require('fs');
const ncm = require('../core/network_config_mgr.js');
const r = require('../util/firerouter.js');
const Message = require('../core/Message.js');
let scheduleUpdateWatchersTask = null;

class IfPresenceSensor extends Sensor {

  async run() {
    sclient.on("message", (channel, message) => {
      if (channel === Message.MSG_FR_IFACE_CHANGE_APPLIED) {
        if (scheduleUpdateWatchersTask)
          clearTimeout(scheduleUpdateWatchersTask);
        scheduleUpdateWatchersTask = setTimeout(() => {
          this._updateInterfaceWatchers().catch((err) => {
            this.log.error("Failed to update interface watchers", err.message);
          });
        }, 2000);
      }
    });
    sclient.subscribe(Message.MSG_FR_IFACE_CHANGE_APPLIED);
  }

  async _updateInterfaceWatchers() {
    if (this._watchedFiles) {
      for (const f of this._watchedFiles)
        fs.unwatchFile(f.file, f.listener);
    }
    this._watchedFiles = [];
    const interfaces = await ncm.getInterfaces();
    for (const intf of Object.keys(interfaces)) {
      const config = interfaces[intf].config;
      if (config.allowHotplug === true) {
        const listener = (curr, prev) => {
          if (curr.isDirectory() !== prev.isDirectory() || curr.ctimeMs > prev.ctimeMs) {
            const intfPlugin = pl.getPluginInstance("interface", intf);
            if (!intfPlugin)
              return;
            if (curr.ctimeMs > prev.ctimeMs) {
              const e = event.buildEvent(event.EVENT_IF_PRESENT, {intf: intf});
              this._sendEvent(e, intfPlugin);
            } else {
              if (!curr.isDirectory() && prev.isDirectory()) {
                const e = event.buildEvent(event.EVENT_IF_DISAPPEAR, {intf: intf});
                this._sendEvent(e, intfPlugin);
              }
            }
          }
        }
        this._watchedFiles.push({file: r.getInterfaceSysFSDirectory(intf), listener: listener});
        fs.watchFile(r.getInterfaceSysFSDirectory(intf), {interval: 2000}, listener);
      }
    }
  }

  _sendEvent(e, plugin) {
    if (pl.isApplyInProgress()) {
      // defer sending event if plugin_loader is applying another config
      setTimeout(() => {
        this._sendEvent(e, plugin);
      }, 3000);
    } else {
      plugin.propagateEvent(e);
    }
  }
}

module.exports = IfPresenceSensor;