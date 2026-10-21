/**
 * ShowHiddenChannels — Unbound
 *
 * Affiche dans la liste des salons ceux auxquels tu n'as pas accès
 * (restriction de rôle). Tu vois le nom, le topic et quelques métadonnées.
 * Tu ne peux PAS lire les messages : Discord ne les envoie jamais au client.
 *
 * Inspiré des plugins Vendetta/Bunny (c10udburst, yofukashino) et Vencord.
 * Best-effort : les modules Discord bougent souvent après une update.
 */

const { metro, patcher, utils } = require('@unbound-app/api');

const Patcher = patcher.createPatcher('show-hidden-channels');

// Channel types to never treat as "hidden guild channels"
const SKIP_TYPES = new Set([
  1, // DM
  3, // GROUP_DM
  4, // GUILD_CATEGORY
]);

function safeFind(...propsList) {
  for (const props of propsList) {
    try {
      const mod = metro.findByProps(...props);
      if (mod) return mod;
    } catch (_) {}
  }
  return null;
}

function safeFindName(name) {
  try {
    if (typeof metro.findByName === 'function') {
      return metro.findByName(name);
    }
  } catch (_) {}
  return null;
}

function resolvePermissions() {
  return (
    safeFind(['getChannelPermissions', 'can']) ||
    safeFind(['can', 'getGuildPermissions']) ||
    safeFind(['can'])
  );
}

function resolveChannelStore() {
  return (
    safeFind(['getChannel', 'getMutableGuildChannelsForGuild']) ||
    safeFind(['getChannel', 'getDMFromUserId']) ||
    safeFind(['getChannel'])
  );
}

function resolveConstants() {
  // VIEW_CHANNEL is typically a bigint permission flag
  const perms =
    safeFind(['VIEW_CHANNEL', 'SEND_MESSAGES']) ||
    safeFind(['Permissions']) ||
    null;
  if (!perms) return null;
  if (perms.VIEW_CHANNEL != null) return perms;
  if (perms.Permissions && perms.Permissions.VIEW_CHANNEL != null) {
    return perms.Permissions;
  }
  return perms;
}

function getChannel(idOrChannel) {
  if (!idOrChannel) return null;
  if (typeof idOrChannel === 'object' && idOrChannel.id) return idOrChannel;
  const store = resolveChannelStore();
  if (!store || typeof store.getChannel !== 'function') return null;
  try {
    return store.getChannel(idOrChannel);
  } catch (_) {
    return null;
  }
}

/**
 * Real permission check (bypasses our own patch via channel.realCheck).
 */
function isHiddenChannel(channelOrId) {
  try {
    let channel = getChannel(channelOrId);
    if (!channel) return false;
    if (SKIP_TYPES.has(channel.type)) return false;
    // DMs / group DMs
    if (channel.isDM && channel.isDM()) return false;
    if (channel.isGroupDM && channel.isGroupDM()) return false;

    const Permissions = resolvePermissions();
    const Constants = resolveConstants();
    if (!Permissions || typeof Permissions.can !== 'function') return false;

    const VIEW =
      (Constants && Constants.VIEW_CHANNEL) ||
      (Permissions.VIEW_CHANNEL);

    if (VIEW == null) return false;

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
    return false;
  }
}

function patchPermissions() {
  const Permissions = resolvePermissions();
  if (!Permissions || typeof Permissions.can !== 'function') {
    console.warn('[ShowHiddenChannels] Permissions.can not found');
    return;
  }

  const Constants = resolveConstants();
  const VIEW =
    (Constants && Constants.VIEW_CHANNEL) || Permissions.VIEW_CHANNEL;

  Patcher.after(Permissions, 'can', ({ args, result }) => {
    try {
      const [permID, channel] = args;
      // Only rewrite VIEW_CHANNEL checks that are not our internal realCheck
      if (channel && !channel.realCheck && VIEW != null && permID === VIEW) {
        return true;
      }
    } catch (_) {}
    return result;
  });
}

function patchFetchMessages() {
  // Prevent 403 spam when Discord tries to load messages for a hidden channel
  const Fetcher =
    safeFind(['fetchMessages', 'sendMessage']) ||
    safeFind(['fetchMessages']) ||
    safeFind(['stores', 'fetchMessages']);

  if (!Fetcher || typeof Fetcher.fetchMessages !== 'function') {
    console.warn('[ShowHiddenChannels] fetchMessages not found');
    return;
  }

  Patcher.instead(Fetcher, 'fetchMessages', ({ args, original }) => {
    try {
      const channelArg = args[0];
      const id =
        typeof channelArg === 'object'
          ? channelArg?.channelId || channelArg?.id || channelArg
          : channelArg;
      if (isHiddenChannel(id)) return undefined;
    } catch (_) {}
    return original.apply(Fetcher, args);
  });
}

function patchNavigation() {
  // Soft-block switching into a hidden channel (still show it in the list)
  const Router =
    safeFind(['transitionToGuild']) ||
    safeFind(['transitionTo', 'transitionToGuild']) ||
    safeFind(['selectChannel']);

  if (Router && typeof Router.transitionToGuild === 'function') {
    Patcher.instead(Router, 'transitionToGuild', ({ args, original }) => {
      try {
        // common signature: (guildId, channelId) or similar
        const channelId = args[1] ?? args[0];
        if (isHiddenChannel(channelId)) {
          console.log('[ShowHiddenChannels] blocked navigation to hidden channel');
          return undefined;
        }
      } catch (_) {}
      return original.apply(Router, args);
    });
  }

  if (Router && typeof Router.selectChannel === 'function') {
    Patcher.instead(Router, 'selectChannel', ({ args, original }) => {
      try {
        const channelId = args[0]?.channelId || args[0];
        if (isHiddenChannel(channelId)) return undefined;
      } catch (_) {}
      return original.apply(Router, args);
    });
  }
}

function patchMessagesUI() {
  // When the messages view opens on a hidden channel, avoid broken UI.
  // Prefer replacing with a simple no-op if we can find the connected wrapper.
  const MessagesConnected =
    safeFindName('MessagesWrapperConnected') ||
    safeFind(['MessagesWrapperConnected']) ||
    null;

  if (!MessagesConnected) return;

  // Some builds export the component as default, others as the module itself
  const target =
    typeof MessagesConnected.default === 'function'
      ? MessagesConnected
      : MessagesConnected;

  const key = typeof target.default === 'function' ? 'default' : null;
  if (!key) return;

  Patcher.instead(target, key, ({ args, original }) => {
    try {
      const channel = args[0]?.channel || args[0]?.channelId;
      if (isHiddenChannel(channel)) {
        // Return null / empty — list still shows the channel; chat area stays empty
        return null;
      }
    } catch (_) {}
    return original.apply(target, args);
  });
}

module.exports = {
  start() {
    patchPermissions();
    patchFetchMessages();
    patchNavigation();
    patchMessagesUI();
    console.log('[ShowHiddenChannels] started');
  },
  stop() {
    Patcher.unpatchAll();
    console.log('[ShowHiddenChannels] stopped');
  },
};
