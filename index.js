/**
 * ShowHiddenChannels for Unbound (v1.1.0)
 *
 * Based on working mobile implementations:
 * - Lioncat6/revenge-plugins (hidden-channels)
 * - c10udburst vendetta hidden-channels
 * - yofukashino tharkidetta ShowHiddenChannels
 *
 * Core idea: patch PermissionStore.can so VIEW_CHANNEL always returns true
 * for the channel list, while keeping a realCheck flag for isHidden().
 * Then force ChannelListStore / PermissionStore to rebuild.
 *
 * You still cannot read messages — Discord never sends them.
 */

const api =
  (typeof unbound !== 'undefined' && unbound) ||
  (typeof require === 'function' ? require('@unbound-app/api') : null);

if (!api) {
  console.error('[ShowHiddenChannels] Unbound API not found');
}

const metro = api && api.metro;
const patcher = api && api.patcher;
const Patcher = patcher ? patcher.createPatcher('show-hidden-channels') : null;

function findPermissions() {
  try {
    const store = metro.findStore && metro.findStore('Permission');
    if (store && typeof store.can === 'function') return store;
  } catch (_) {}

  try {
    const m = metro.findByProps('getChannelPermissions', 'can');
    if (m && typeof m.can === 'function') return m;
  } catch (_) {}

  try {
    const m = metro.findByProps('can', 'canWithPartialContext');
    if (m && typeof m.can === 'function') return m;
  } catch (_) {}

  try {
    const m = metro.findByProps('can');
    if (m && typeof m.can === 'function') return m;
  } catch (_) {}

  return null;
}

function findChannelStore() {
  try {
    const s = metro.findStore && metro.findStore('Channel');
    if (s && typeof s.getChannel === 'function') return s;
  } catch (_) {}
  try {
    return metro.findByProps('getChannel', 'getMutableGuildChannelsForGuild');
  } catch (_) {}
  try {
    return metro.findByProps('getChannel');
  } catch (_) {}
  return null;
}

function findViewChannelPermission() {
  try {
    if (metro.common && metro.common.Constants && metro.common.Constants.Permissions) {
      return metro.common.Constants.Permissions.VIEW_CHANNEL;
    }
  } catch (_) {}

  try {
    const c = metro.findByProps('Permissions', 'ChannelTypes');
    if (c && c.Permissions && c.Permissions.VIEW_CHANNEL != null) {
      return c.Permissions.VIEW_CHANNEL;
    }
  } catch (_) {}

  try {
    const c = metro.findByProps('VIEW_CHANNEL', 'SEND_MESSAGES');
    if (c && c.VIEW_CHANNEL != null) return c.VIEW_CHANNEL;
  } catch (_) {}

  try {
    return BigInt(1024);
  } catch (_) {
    return 1024;
  }
}

function findChannelTypes() {
  try {
    if (metro.common && metro.common.Constants && metro.common.Constants.ChannelTypes) {
      return metro.common.Constants.ChannelTypes;
    }
  } catch (_) {}
  try {
    const c = metro.findByProps('ChannelTypes');
    return c && c.ChannelTypes;
  } catch (_) {}
  return { DM: 1, GROUP_DM: 3, GUILD_CATEGORY: 4 };
}

function getChannel(idOrChannel) {
  if (!idOrChannel) return null;
  if (typeof idOrChannel === 'object' && idOrChannel.id) return idOrChannel;
  const ChannelStore = findChannelStore();
  if (!ChannelStore || typeof ChannelStore.getChannel !== 'function') return null;
  try {
    return ChannelStore.getChannel(idOrChannel);
  } catch (_) {
    return null;
  }
}

function isHidden(channelOrId) {
  try {
    let channel = getChannel(channelOrId);
    if (!channel) return false;

    const types = findChannelTypes();
    const skip = [types.DM, types.GROUP_DM, types.GUILD_CATEGORY];
    if (skip.includes(channel.type)) return false;

    const Permissions = findPermissions();
    const VIEW = findViewChannelPermission();
    if (!Permissions || typeof Permissions.can !== 'function' || VIEW == null) {
      return false;
    }

    channel.realCheck = true;
    let hidden = false;
    try {
      hidden = !Permissions.can(VIEW, channel);
    } finally {
      try {
        delete channel.realCheck;
      } catch (_) {
        channel.realCheck = false;
      }
    }
    return hidden;
  } catch (e) {
    console.warn('[ShowHiddenChannels] isHidden error', e);
    return false;
  }
}

function forceChannelListRefresh() {
  try {
    const Dispatcher =
      (metro.common && metro.common.Dispatcher) ||
      metro.findByProps('_currentDispatchActionType', '_processingWaitQueue') ||
      metro.findByProps('dispatch', 'subscribe');

    if (!Dispatcher) return;

    const nodes =
      Dispatcher._actionHandlers &&
      Dispatcher._actionHandlers._dependencyGraph &&
      Dispatcher._actionHandlers._dependencyGraph.nodes
        ? Object.values(Dispatcher._actionHandlers._dependencyGraph.nodes)
        : [];

    for (const node of nodes) {
      try {
        if (node && node.name === 'PermissionStore') {
          const h =
            node.actionHandler &&
            (node.actionHandler.CONNECTION_OPEN ||
              node.actionHandler.handleConnectionOpen ||
              node.actionHandler.OVERLAY_INITIALIZE);
          if (typeof h === 'function') h({});
        }
        if (node && node.name === 'ChannelListStore') {
          const h =
            node.actionHandler &&
            (node.actionHandler.CONNECTION_OPEN ||
              node.actionHandler.handleReset ||
              node.actionHandler.OVERLAY_INITIALIZE);
          if (typeof h === 'function') h({});
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[ShowHiddenChannels] refresh failed', e);
  }
}

function start() {
  if (!metro || !Patcher) {
    console.error('[ShowHiddenChannels] metro/patcher missing — abort');
    return;
  }

  const Permissions = findPermissions();
  const VIEW = findViewChannelPermission();

  if (!Permissions || typeof Permissions.can !== 'function') {
    console.error(
      '[ShowHiddenChannels] PermissionStore.can NOT FOUND — plugin cannot work on this Discord build'
    );
    return;
  }

  if (VIEW == null) {
    console.error('[ShowHiddenChannels] VIEW_CHANNEL constant not found');
    return;
  }

  console.log('[ShowHiddenChannels] patching Permissions.can, VIEW_CHANNEL=', String(VIEW));

  Patcher.after(Permissions, 'can', ({ args, result }) => {
    try {
      const permID = args[0];
      const channel = args[1];
      if (!channel || channel.realCheck) return result;

      const isView =
        permID === VIEW ||
        String(permID) === String(VIEW);

      if (isView) return true;
    } catch (_) {}
    return result;
  });

  try {
    const MessageActions =
      metro.findByProps('jumpToMessage', '_sendMessage') ||
      metro.findByProps('fetchMessages', 'sendMessage') ||
      metro.findByProps('fetchMessages');

    if (MessageActions && typeof MessageActions.fetchMessages === 'function') {
      Patcher.instead(MessageActions, 'fetchMessages', ({ args, original }) => {
        try {
          const payload = args[0];
          const id =
            (payload && (payload.channelId || payload.id)) || payload;
          if (isHidden(id)) return;
        } catch (_) {}
        return original(...args);
      });
    }
  } catch (e) {
    console.warn('[ShowHiddenChannels] fetchMessages patch skipped', e);
  }

  try {
    const Router =
      metro.findByProps('transitionToGuild') ||
      metro.findByProps('transitionToChannel');

    if (Router) {
      for (const key of Object.keys(Router)) {
        if (typeof Router[key] !== 'function') continue;
        Patcher.instead(Router, key, ({ args, original }) => {
          try {
            if (typeof args[0] === 'string') {
              const m = args[0].match(/(\d+)$/);
              if (m && m[1] && isHidden(m[1])) {
                console.log('[ShowHiddenChannels] blocked open of hidden channel', m[1]);
                return {};
              }
            }
            if (args[1] && isHidden(args[1])) return {};
          } catch (_) {}
          return original(...args);
        });
      }
    }
  } catch (e) {
    console.warn('[ShowHiddenChannels] router patch skipped', e);
  }

  try {
    forceChannelListRefresh();
  } catch (_) {}

  console.log('[ShowHiddenChannels] started OK');
}

function stop() {
  if (Patcher) Patcher.unpatchAll();
  try {
    forceChannelListRefresh();
  } catch (_) {}
  console.log('[ShowHiddenChannels] stopped');
}

module.exports = { start, stop };
module.exports.default = module.exports;
