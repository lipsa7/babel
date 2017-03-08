import * as context from "../../../index";
import type Logger from "../logger";
import Plugin from "../../plugin";
import * as messages from "babel-messages";
import { normaliseOptions } from "./index";
import resolvePlugin from "../../../helpers/resolve-plugin";
import resolvePreset from "../../../helpers/resolve-preset";
import cloneDeepWith from "lodash/cloneDeepWith";
import clone from "lodash/clone";
import merge from "../../../helpers/merge";
import config from "./config";
import removed from "./removed";
import buildConfigChain from "./build-config-chain";
import path from "path";

type PluginObject = {
  pre?: Function,
  post?: Function,
  manipulateOptions?: Function,

  visitor: ?{
    [key: string]:
      | Function
      | {
          enter?: Function | Array<Function>,
          exit?: Function | Array<Function>,
        },
  },
};

type MergeOptions = {
  options?: Object,
  extending?: Object,
  alias: string,
  loc?: string,
  dirname?: string,
};

export default class OptionManager {
  constructor(log?: Logger) {
    this.resolvedConfigs = [];
    this.options = OptionManager.createBareOptions();
    this.log = log;
  }

  resolvedConfigs: Array<string>;
  options: Object;
  log: ?Logger;

  static memoisedPlugins: Array<{
    container: Function,
    plugin: Plugin,
  }>;

  static memoisePluginContainer(fn, loc, i, alias) {
    for (const cache of (OptionManager.memoisedPlugins: Array<Object>)) {
      if (cache.container === fn) return cache.plugin;
    }

    let obj: ?PluginObject;

    if (typeof fn === "function") {
      obj = fn(context);
    } else {
      obj = fn;
    }

    if (typeof obj === "object") {
      const plugin = new Plugin(obj, alias);
      OptionManager.memoisedPlugins.push({
        container: fn,
        plugin: plugin,
      });
      return plugin;
    } else {
      throw new TypeError(
        messages.get("pluginNotObject", loc, i, typeof obj) + loc + i,
      );
    }
  }

  static createBareOptions() {
    const opts = {};

    for (const key in config) {
      const opt = config[key];
      opts[key] = clone(opt.default);
    }

    return opts;
  }

  static normalisePlugin(plugin, loc, i, alias) {
    plugin = plugin.__esModule ? plugin.default : plugin;

    if (!(plugin instanceof Plugin)) {
      // allow plugin containers to be specified so they don't have to manually require
      if (typeof plugin === "function" || typeof plugin === "object") {
        plugin = OptionManager.memoisePluginContainer(plugin, loc, i, alias);
      } else {
        throw new TypeError(
          messages.get("pluginNotFunction", loc, i, typeof plugin),
        );
      }
    }

    plugin.init(loc, i);

    return plugin;
  }

  static normalisePlugins(loc, dirname, plugins) {
    return plugins.map(function(val, i) {
      let plugin, options;

      if (!val) {
        throw new TypeError("Falsy value found in plugins");
      }

      // destructure plugins
      if (Array.isArray(val)) {
        [plugin, options] = val;
      } else {
        plugin = val;
      }

      const alias = typeof plugin === "string" ? plugin : `${loc}$${i}`;

      // allow plugins to be specified as strings
      if (typeof plugin === "string") {
        const pluginLoc = resolvePlugin(plugin, dirname);
        if (pluginLoc) {
          plugin = require(pluginLoc);
        } else {
          throw new ReferenceError(
            messages.get("pluginUnknown", plugin, loc, i, dirname),
          );
        }
      }

      plugin = OptionManager.normalisePlugin(plugin, loc, i, alias);

      return [plugin, options];
    });
  }

  /**
   * This is called when we want to merge the input `opts` into the
   * base options (passed as the `extendingOpts`: at top-level it's the
   * main options, at presets level it's presets options).
   *
   *  - `alias` is used to output pretty traces back to the original source.
   *  - `loc` is used to point to the original config.
   *  - `dirname` is used to resolve plugins relative to it.
   */

  mergeOptions(
    {
      options: rawOpts,
      extending: extendingOpts,
      alias,
      loc,
      dirname,
    }: MergeOptions,
  ) {
    alias = alias || "foreign";
    if (!rawOpts) return;

    //
    if (typeof rawOpts !== "object" || Array.isArray(rawOpts)) {
      this.log.error(`Invalid options type for ${alias}`, TypeError);
    }

    //
    const opts = cloneDeepWith(rawOpts, val => {
      if (val instanceof Plugin) {
        return val;
      }
    });

    //
    dirname = dirname || process.cwd();
    loc = loc || alias;

    for (const key in opts) {
      const option = config[key];

      // check for an unknown option
      if (!option && this.log) {
        if (removed[key]) {
          this.log.error(
            `Using removed Babel 5 option: ${alias}.${key} - ${removed[key].message}`,
            ReferenceError,
          );
        } else {
          // eslint-disable-next-line max-len
          const unknownOptErr = `Unknown option: ${alias}.${key}. Check out http://babeljs.io/docs/usage/options/ for more information about options.`;

          this.log.error(unknownOptErr, ReferenceError);
        }
      }
    }

    // normalise options
    normaliseOptions(opts);

    // resolve plugins
    if (opts.plugins) {
      opts.plugins = OptionManager.normalisePlugins(loc, dirname, opts.plugins);
    }

    // resolve presets
    if (opts.presets) {
      // If we're in the "pass per preset" mode, we resolve the presets
      // and keep them for further execution to calculate the options.
      if (opts.passPerPreset) {
        opts.presets = this.resolvePresets(
          opts.presets,
          dirname,
          (preset, presetLoc) => {
            this.mergeOptions({
              options: preset,
              extending: preset,
              alias: presetLoc,
              loc: presetLoc,
              dirname: dirname,
            });
          },
        );
      } else {
        // Otherwise, just merge presets options into the main options.
        this.mergePresets(opts.presets, dirname);
        delete opts.presets;
      }
    }

    // Merge them into current extending options in case of top-level
    // options. In case of presets, just re-assign options which are got
    // normalized during the `mergeOptions`.
    if (rawOpts === extendingOpts) {
      Object.assign(extendingOpts, opts);
    } else {
      merge(extendingOpts || this.options, opts);
    }
  }

  /**
   * Merges all presets into the main options in case we are not in the
   * "pass per preset" mode. Otherwise, options are calculated per preset.
   */
  mergePresets(presets: Array<string | Object>, dirname: string) {
    this.resolvePresets(presets, dirname, (presetOpts, presetLoc) => {
      this.mergeOptions({
        options: presetOpts,
        alias: presetLoc,
        loc: presetLoc,
        dirname: path.dirname(presetLoc || ""),
      });
    });
  }

  /**
   * Resolves presets options which can be either direct object data,
   * or a module name to require.
   */
  resolvePresets(presets: Array<string | Object>, dirname: string, onResolve?) {
    return presets.map(preset => {
      let options;
      if (Array.isArray(preset)) {
        if (preset.length > 2) {
          throw new Error(
            `Unexpected extra options ${JSON.stringify(preset.slice(2))} passed to preset.`,
          );
        }

        [preset, options] = preset;
      }

      let presetLoc;
      try {
        if (typeof preset === "string") {
          presetLoc = resolvePreset(preset, dirname);

          if (!presetLoc) {
            throw new Error(
              `Couldn't find preset ${JSON.stringify(preset)} relative to directory ` +
                JSON.stringify(dirname),
            );
          }
        }
        const resolvedPreset = this.loadPreset(presetLoc || preset, options, {
          dirname,
        });

        if (onResolve) onResolve(resolvedPreset, presetLoc);

        return resolvedPreset;
      } catch (e) {
        if (presetLoc) {
          e.message += ` (While processing preset: ${JSON.stringify(presetLoc)})`;
        }
        throw e;
      }
    });
  }

  /**
   * Tries to load one preset. The input is either the module name of the preset,
   * a function, or an object
   */
  loadPreset(preset, options, meta) {
    let presetFactory = preset;
    if (typeof presetFactory === "string") {
      presetFactory = require(presetFactory);
    }

    if (typeof presetFactory === "object" && presetFactory.__esModule) {
      if (presetFactory.default) {
        presetFactory = presetFactory.default;
      } else {
        throw new Error(
          "Preset must export a default export when using ES6 modules.",
        );
      }
    }

    // Allow simple object exports
    if (typeof presetFactory === "object") {
      return presetFactory;
    }

    if (typeof presetFactory !== "function") {
      // eslint-disable-next-line max-len
      throw new Error(
        `Unsupported preset format: ${typeof presetFactory}. Expected preset to return a function.`,
      );
    }

    return presetFactory(context, options, meta);
  }

  normaliseOptions() {
    const opts = this.options;

    for (const key in config) {
      const option = config[key];
      const val = opts[key];

      // optional
      if (!val && option.optional) continue;

      // aliases
      if (option.alias) {
        opts[option.alias] = opts[option.alias] || val;
      } else {
        opts[key] = val;
      }
    }
  }

  init(opts: Object = {}): Object {
    for (const config of buildConfigChain(opts, this.log)) {
      this.mergeOptions(config);
    }

    // normalise
    this.normaliseOptions(opts);

    return this.options;
  }
}

OptionManager.memoisedPlugins = [];
