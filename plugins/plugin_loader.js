/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
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

const log = require('../util/logger.js')(__filename);
const config = require('../util/config.js').getConfig();

let pluginConfs = [];

const pluginCategoryMap = {};

const _ = require('lodash');

function initPlugins() {
  if(_.isEmpty(config.plugins)) {
    return;
  }

  pluginConfs = config.plugins.sort((a, b) => {
    return a.init_seq - b.init_seq
  });

  for (let pluginConf of pluginConfs) {
    try {
      const filePath = pluginConf.file_path;
      if (!pluginCategoryMap[pluginConf.category])
        pluginCategoryMap[pluginConf.category] = {};
      const pluginClass = require(filePath);
      pluginConf.c = pluginClass;
    } catch (err) {
      log.error("Failed to initialize plugin ", pluginConf, err);
    }
  }

  log.info("Plugin initialized", pluginConfs);
}

function createPluginInstance(category, name, constructor) {
  let instance = pluginCategoryMap[category] && pluginCategoryMap[category][name];
  if (instance)
    return instance;

  if (!pluginCategoryMap[category])
    pluginCategoryMap[category] = {};

  if (!constructor)
    return null;

  instance = new constructor(name);
  instance.name = name;
  pluginCategoryMap[category][name] = instance;
  log.info("Instance created", instance);
  return instance;
}

function getPluginInstance(category, name) {
  return pluginCategoryMap[category] && pluginCategoryMap[category][name];
}

async function reapply(config) {
  const newPluginCategoryMap = {};

  const reversedPluginConfs = pluginConfs.reverse();
  // remove or flush plugins in descending order by init sequence
  for (let pluginConf of reversedPluginConfs) {
    newPluginCategoryMap[pluginConf.category] = newPluginCategoryMap[pluginConf.category] || {};
    if (!pluginConf.c)
      continue;
    const instances = Object.values(pluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
    if (instances) {
      for (let instance of instances) {
        instance._mark = 0;
      }
    } else pluginCategoryMap[pluginConf.category] = {};

    const newInstances = {};
    const keys = pluginConf.config_path.split(".");
    let value = config;
    for (let key of keys) {
      if (value)
        value = value[key];
    }
    if (value) {
      for (let name in value) {
        log.info("Creating instance", pluginConf.category, name);
        const instance = createPluginInstance(pluginConf.category, name, pluginConf.c);
        if (!instance)
          continue;
        instance._mark = 1;
        const oldConfig = instance.networkConfig;
        if (oldConfig && !_.isEqual(oldConfig, value[name])) {
          // network config is changed, flush plugin instance with old config
          log.info(`Network config of ${pluginConf.category}-->${name} is changed, flush old config ...`);
          await instance.flush();
        }
        instance.configure(value[name]);
        if (!oldConfig) {
          // initialization of network config, flush instance with new config
          log.info(`Initial setup of ${pluginConf.category}-->${name}, flushing ...`);
          await instance.flush();
        }
        newInstances[name] = instance;
      }
    }

    if (instances) {
      const removedInstances = instances.filter(i => i._mark == 0);
      for (let instance of removedInstances) {
        log.info(`Removing plugin ${pluginConf.category}-->${instance.name} ...`)
        await instance.flush();
      }
    }
    // merge with new pluginCategoryMap
    newPluginCategoryMap[pluginConf.category] = Object.assign({}, newPluginCategoryMap[pluginConf.category], newInstances);
  }

  // apply plugin configs in ascending order by init sequence
  pluginConfs = reversedPluginConfs.reverse();
  for (let pluginConf of pluginConfs) {
    const instances = Object.values(newPluginCategoryMap[pluginConf.category]).filter(i => i.constructor.name === pluginConf.c.name);
    if (instances) {
      for (let instance of instances) {
        log.info("Applying config", pluginConf.category, instance.name);
        await instance.apply().catch((err) => {
          log.error(`Failed to apply config of ${pluginConf.category}-->${instance.name}`, instance.networkConfig, err);
        });
      }
    }
  }
}

module.exports = {
  initPlugins:initPlugins,
  getPluginInstance: getPluginInstance,
  reapply: reapply,
};