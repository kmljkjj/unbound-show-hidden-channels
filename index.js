(function () {
	'use strict';

	// ShowHiddenChannels - port Unbound v1.7.0
	// IMPORTANT : ce fichier doit rester UNE seule expression qui retourne
	// l'objet du plugin. Unbound evalue les bundles avec eval('(() => { return
	// ' + bundle + ' })') : un fichier CommonJS (require / exports de module)
	// ou un commentaire AVANT l'expression fait retourner undefined au loader,
	// et start() n'est jamais appele (bug des versions <= 1.3.0).
	//
	// v1.7.0 - fiabilisation :
	// - statut a trois etats ACCESSIBLE / RESTRICTED / UNKNOWN : une erreur de
	//   PermissionStore, un module absent ou un contexte incomplet ne rend
	//   JAMAIS un salon visible et ne bloque JAMAIS une action : l'inconnu est
	//   neutre (le vrai can continue de tourner, le plugin ne fait qu'inverser
	//   un verdict deja rendu, sans aucun recalcul).
	// - cache de permissions contextualise : cle userId:guildId:channelId,
	//   entrees { restricted, timestamp, generation }, TTL cacheTtlMs (30 s par
	//   defaut), limite 2000 entrees avec purge par anciennete, statistiques
	//   (lectures, echecs, expirations, ecritures, purges), generation globale
	//   pour invalidation paresseuse, detection de changement de compte sur les
	//   dispatchs Discord.
	// - resolution Metro METHODE PAR METHODE : fetchMessages, jumpToMessage,
	//   joinVoiceChannel, selectVoiceChannel et acknowledge sont cherches
	//   independamment ; un module renomme ou scinde ne desactive plus les
	//   autres gardes. ChannelTypes/Permissions depuis Constants avec replis
	//   numeriques.
	// - extractChannelId recursif (profondeur 3) : channelId, channel_id,
	//   channel, targetChannelId, valeurs primitives et tableaux.
	// - isHidden : ajoute au prototype seulement s'il est absent, restauration
	//   EXACTE a l'arret (une implementation apparue entre-temps est preservee).
	// - reconstruction coalescee : plusieurs invalidations successives
	//   declenchent une seule reconstruction, emitChange du store en priorite,
	//   handlers internes en tout dernier recours.
	// - collecte d'erreurs bornee (50, sans donnees sensibles), mode debug
	//   desactive par defaut, dump() enrichi (modules, cache, erreurs, runtime)
	//   et formatDump() texte copiable pour les rapports de bug.
	// - reglages valides par type, setSettings avec rapport changed/rejected,
	//   resetSettings, persistance storage avec repli propriete brute.
	// - gardes parametrees : safety (maitre), preventNetworkRequests
	//   (fetch/jump), preventOpenAttempt (vocal/acknowledge), blockUnreads,
	//   diagnosticToasts (toasts de blocage), toasts de blocage limites par
	//   cooldown (toastOnce).
	// - patches descriptifs { label, critical, unpatch, installedAt },
	//   desinstallation en ordre inverse.

	var VERSION = '1.7.0';
	var STORE_KEY = 'show-hidden-channels';
	var SETTINGS_KEY = 'settings';

	var DEFAULT_SETTINGS = {
		showText: true,
		showVoice: true,
		showStage: true,
		showForum: true,
		showDirectory: true,
		showHiddenCategories: true,
		showThreads: true,
		showArchivedThreads: false,
		showPrivateThreads: false,
		markHidden: true,
		blockUnreads: true,
		safety: true,
		preventNetworkRequests: true,
		preventOpenAttempt: true,
		diagnosticToasts: true,
		debug: false,
		cacheTtlMs: 30000
	};

	var STATUS = { ACCESSIBLE: 1, RESTRICTED: 2, UNKNOWN: 3 };
	var MAX_CACHE_ENTRIES = 2000;
	var MAX_ERRORS = 50;
	var TOAST_COOLDOWN_MS = 3000;

	var INVALIDATE = {
		GUILD_ROLE_UPDATE: 1,
		GUILD_ROLE_DELETE: 1,
		GUILD_MEMBER_UPDATE: 1,
		GUILD_MEMBER_ROLES_UPDATE: 1,
		CHANNEL_UPDATE: 1,
		CHANNEL_CREATE: 1,
		CHANNEL_DELETE: 1,
		CHANNEL_OVERWRITE_CREATE: 1,
		CHANNEL_OVERWRITE_UPDATE: 1,
		CHANNEL_OVERWRITE_DELETE: 1,
		THREAD_CREATE: 1,
		THREAD_UPDATE: 1,
		THREAD_DELETE: 1,
		GUILD_DELETE: 1,
		CONNECTION_OPEN: 1,
		USER_GUILD_SETTINGS_UPDATE: 1
	};

	function resolveApi() {
		try {
			if (typeof unbound === 'object' && unbound && unbound.metro) return unbound;
		} catch (e) {}
		try {
			if (typeof window === 'object' && window && window.unbound && window.unbound.metro) return window.unbound;
		} catch (e) {}
		try {
			if (typeof globalThis === 'object' && globalThis.unbound && globalThis.unbound.metro) return globalThis.unbound;
		} catch (e) {}
		return null;
	}

	var api = resolveApi();
	var metro = api ? api.metro : null;
	var patcher = api ? api.patcher : null;
	var toasts = api ? api.toasts : null;

	var Patcher = null;
	try {
		if (patcher && typeof patcher.createPatcher === 'function') {
			Patcher = patcher.createPatcher('show-hidden-channels');
		}
	} catch (e) {}

	var state = {
		started: false,
		patches: [],
		isHiddenInfo: null,
		permCache: {},
		cacheSize: 0,
		permissionGeneration: 1,
		cacheStats: { hits: 0, misses: 0, expirations: 0, writes: 0, trims: 0 },
		userId: null,
		toastCooldown: {},
		settings: {},
		missing: [],
		optionalMissing: [],
		errors: [],
		modules: {},
		refreshScheduled: false
	};

	var refs = {
		realCan: null,
		channelStore: null,
		dispatcher: null,
		userStore: null,
		VIEW: 1024,
		CONNECT: 1048576,
		SEND: 2048
	};

	var CT = {
		text: [0, 5, 6, 16],
		voice: [2],
		stage: [13],
		forum: [15],
		directory: [14],
		category: [4],
		publicThread: [11],
		privateThread: [12],
		dm: [1, 3]
	};

	function now() {
		try { return Date.now(); } catch (e) { return 0; }
	}

	function recordError(scope, error) {
		try {
			state.errors.push({
				scope: String(scope),
				message: error && error.message ? String(error.message) : String(error),
				timestamp: now()
			});
			if (state.errors.length > MAX_ERRORS) state.errors.shift();
		} catch (e) {}
	}

	function debugLog(scope, data) {
		if (state.settings.debug !== true) return;
		try { console.log('[ShowHiddenChannels][' + scope + '] ' + String(data)); } catch (e) {}
	}

	function toast(content) {
		try {
			if (toasts && typeof toasts.showToast === 'function') {
				toasts.showToast({ title: 'ShowHiddenChannels', content: String(content) });
				return;
			}
		} catch (e) {}
		try { console.log('[ShowHiddenChannels] ' + content); } catch (e) {}
	}

	function toastOnce(key, content) {
		try {
			if (state.settings.diagnosticToasts === false) return;
			var t = now();
			var prev = state.toastCooldown[key];
			if (prev != null && t - prev < TOAST_COOLDOWN_MS) return;
			state.toastCooldown[key] = t;
			toast(content);
		} catch (e) {}
	}

	function firstResult(tries) {
		for (var i = 0; i < tries.length; i++) {
			try {
				var value = tries[i]();
				if (value != null) return value;
			} catch (e) {}
		}
		return null;
	}

	function samePerm(a, b) {
		if (a === b) return true;
		try {
			if (typeof BigInt === 'function') return BigInt(a) === BigInt(b);
		} catch (e) {}
		return String(a) === String(b);
	}

	function typeIn(t, list) {
		for (var i = 0; i < list.length; i++) {
			if (list[i] === t) return true;
		}
		return false;
	}

	function isDmType(t) {
		return t === 1 || t === 3;
	}

	function isArchived(channel) {
		try {
			var tm = channel && channel.threadMetadata;
			return !!(tm && tm.archived === true);
		} catch (e) {
			return false;
		}
	}

	function typeShown(channel) {
		try {
			var t = channel.type;
			if (isDmType(t)) return false;
			if (typeIn(t, CT.category)) return !!state.settings.showHiddenCategories;
			if (typeIn(t, CT.text)) return !!state.settings.showText;
			if (typeIn(t, CT.voice)) return !!state.settings.showVoice;
			if (typeIn(t, CT.stage)) return !!state.settings.showStage;
			if (typeIn(t, CT.forum)) return !!state.settings.showForum;
			if (typeIn(t, CT.directory)) return !!state.settings.showDirectory;
			if (typeIn(t, CT.publicThread)) {
				if (!state.settings.showThreads) return false;
				if (isArchived(channel)) return !!state.settings.showArchivedThreads;
				return true;
			}
			if (typeIn(t, CT.privateThread)) {
				if (!state.settings.showThreads) return false;
				if (!state.settings.showPrivateThreads) return false;
				if (isArchived(channel)) return !!state.settings.showArchivedThreads;
				return true;
			}
			return true;
		} catch (e) {
			return false;
		}
	}

	function isChannelLike(value) {
		try {
			return !!(value && typeof value === 'object' && value.id != null &&
				(value.type != null || value.guild_id != null || value.guildId != null || value.parent_id != null));
		} catch (e) {
			return false;
		}
	}

	function getUserId() {
		try {
			var us = refs.userStore;
			if (!us) return null;
			if (typeof us.getCurrentUserId === 'function') {
				var id = us.getCurrentUserId();
				return id != null ? String(id) : null;
			}
			if (typeof us.getCurrentUser === 'function') {
				var u = us.getCurrentUser();
				return u && u.id != null ? String(u.id) : null;
			}
		} catch (e) {}
		return null;
	}

	function cacheKey(channel) {
		var uid = state.userId != null ? state.userId : '?';
		var gid = '?';
		var cid = '?';
		try {
			if (channel) {
				if (channel.guild_id != null) gid = String(channel.guild_id);
				else if (channel.guildId != null) gid = String(channel.guildId);
				if (channel.id != null) cid = String(channel.id);
			}
		} catch (e) {}
		return uid + ':' + gid + ':' + cid;
	}

	function getCached(key) {
		try {
			var entry = state.permCache[key];
			if (!entry) {
				state.cacheStats.misses++;
				return null;
			}
			if (entry.generation !== state.permissionGeneration) {
				delete state.permCache[key];
				state.cacheSize--;
				state.cacheStats.misses++;
				return null;
			}
			if (now() - entry.timestamp >= state.settings.cacheTtlMs) {
				delete state.permCache[key];
				state.cacheSize--;
				state.cacheStats.expirations++;
				return null;
			}
			state.cacheStats.hits++;
			return entry.restricted;
		} catch (e) {
			return null;
		}
	}

	function trimCache() {
		try {
			if (state.cacheSize <= MAX_CACHE_ENTRIES) return;
			var keys = Object.keys(state.permCache);
			keys.sort(function (a, b) {
				var ta = state.permCache[a].timestamp;
				var tb = state.permCache[b].timestamp;
				if (ta !== tb) return ta < tb ? -1 : 1;
				return 0;
			});
			var removeCount = keys.length - MAX_CACHE_ENTRIES;
			if (removeCount <= 0) return;
			for (var i = 0; i < removeCount; i++) delete state.permCache[keys[i]];
			state.cacheSize -= removeCount;
			state.cacheStats.trims++;
		} catch (e) {
			recordError('trimCache', e);
		}
	}

	function setCached(key, restricted) {
		try {
			var isNew = !Object.prototype.hasOwnProperty.call(state.permCache, key);
			state.permCache[key] = {
				restricted: !!restricted,
				timestamp: now(),
				generation: state.permissionGeneration
			};
			state.cacheStats.writes++;
			if (isNew) {
				state.cacheSize++;
				if (state.cacheSize > MAX_CACHE_ENTRIES) trimCache();
			}
		} catch (e) {
			recordError('setCached', e);
		}
	}

	function invalidateAll(reason) {
		state.permissionGeneration++;
		debugLog('invalidation', reason);
	}

	function realStatus(channel) {
		if (!channel || channel.id == null) return STATUS.UNKNOWN;
		if (typeof refs.realCan !== 'function') return STATUS.UNKNOWN;
		try {
			return refs.realCan(refs.VIEW, channel) ? STATUS.ACCESSIBLE : STATUS.RESTRICTED;
		} catch (e) {
			recordError('PermissionStore.can', e);
			return STATUS.UNKNOWN;
		}
	}

	function isRestricted(channel) {
		try {
			if (!channel || channel.id == null) return false;
			var key = cacheKey(channel);
			var cached = getCached(key);
			if (cached != null) return cached;
			var status = realStatus(channel);
			if (status === STATUS.UNKNOWN) return false;
			var restricted = (status === STATUS.RESTRICTED);
			setCached(key, restricted);
			return restricted;
		} catch (e) {
			recordError('isRestricted', e);
			return false;
		}
	}

	function resolveChannel(target) {
		if (!target || typeof target !== 'object') return null;
		if (isChannelLike(target)) return target;
		try {
			if (target.channel && typeof target.channel === 'object' && isChannelLike(target.channel)) {
				return target.channel;
			}
		} catch (e) {}
		var cs = refs.channelStore;
		if (cs && typeof cs.getChannel === 'function') {
			var cid = target.channelId != null ? target.channelId :
				(target.channel_id != null ? target.channel_id : null);
			if (cid != null) {
				try { return cs.getChannel(cid); } catch (e) { return null; }
			}
		}
		return null;
	}

	function resolvePartialChannel(target) {
		if (!target || typeof target !== 'object') return null;
		var cid = target.channelId != null ? target.channelId :
			(target.channel_id != null ? target.channel_id : null);
		if (cid == null) return null;
		var gid = target.guildId != null ? target.guildId :
			(target.guild_id != null ? target.guild_id : null);
		return {
			id: String(cid),
			guild_id: gid != null ? String(gid) : null,
			type: target.type != null ? target.type : null
		};
	}

	function findChannelId(value, depth) {
		try {
			if (depth > 3 || value == null) return null;
			if (typeof value === 'string' || typeof value === 'number') return String(value);
			if (typeof value !== 'object') return null;
			var keys = ['channelId', 'channel_id', 'channel', 'targetChannelId'];
			for (var i = 0; i < keys.length; i++) {
				var key = keys[i];
				if (!(key in value)) continue;
				var found = value[key];
				if (found && typeof found === 'object' && found.id != null) return String(found.id);
				if (typeof found === 'string' || typeof found === 'number') return String(found);
			}
			if (typeof value.length === 'number') {
				for (var j = 0; j < value.length; j++) {
					var nested = findChannelId(value[j], depth + 1);
					if (nested != null) return nested;
				}
			}
			return null;
		} catch (e) {
			return null;
		}
	}

	function extractChannelId(args) {
		try {
			if (!args || !args.length) return null;
			for (var i = 0; i < args.length; i++) {
				var id = findChannelId(args[i], 0);
				if (id != null) return id;
			}
		} catch (e) {}
		return null;
	}

	function refreshChannelList() {
		var cs = refs.channelStore;
		try {
			if (cs && typeof cs.emitChange === 'function') {
				cs.emitChange();
				debugLog('refresh', 'emitChange');
				return;
			}
		} catch (e) {
			recordError('refresh:emitChange', e);
		}
		try {
			var Dispatcher = refs.dispatcher;
			var handlers = Dispatcher && Dispatcher._actionHandlers;
			var graph = handlers && handlers._dependencyGraph;
			if (!graph || !graph.nodes) return;
			var nodes = Object.values(graph.nodes);
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (!node || !node.actionHandler) continue;
				try {
					if (node.name === 'PermissionStore') {
						var h = node.actionHandler.handleConnectionOpen || node.actionHandler.CONNECTION_OPEN;
						if (typeof h === 'function') h.call(node.actionHandler);
					} else if (node.name === 'ChannelListStore') {
						var h2 = node.actionHandler.handleReset || node.actionHandler.CONNECTION_OPEN;
						if (typeof h2 === 'function') h2.call(node.actionHandler);
					}
				} catch (e) {}
			}
			debugLog('refresh', 'handlers internes');
		} catch (e) {
			recordError('refresh:handlers', e);
		}
	}

	function scheduleRefresh() {
		if (state.refreshScheduled) return;
		state.refreshScheduled = true;
		var run = function () {
			state.refreshScheduled = false;
			try { refreshChannelList(); } catch (e) { recordError('refresh', e); }
		};
		try {
			if (typeof setTimeout === 'function') {
				setTimeout(run, 0);
				return;
			}
		} catch (e) {}
		run();
	}

	function defaultSettings() {
		var s = {};
		for (var k in DEFAULT_SETTINGS) s[k] = DEFAULT_SETTINGS[k];
		return s;
	}

	function isValidValue(name, value) {
		if (!(name in DEFAULT_SETTINGS)) return false;
		var expected = DEFAULT_SETTINGS[name];
		if (typeof expected === 'number') {
			return typeof value === 'number' && isFinite(value) && value >= 0;
		}
		if (typeof expected === 'boolean') return typeof value === 'boolean';
		return false;
	}

	function getStore() {
		try {
			if (api && api.storage && typeof api.storage.getStore === 'function') {
				return api.storage.getStore(STORE_KEY);
			}
		} catch (e) {}
		return null;
	}

	function loadSettings() {
		var s = defaultSettings();
		var raw = null;
		try {
			var store = getStore();
			if (store) {
				try {
					if (typeof store.get === 'function') raw = store.get(SETTINGS_KEY);
				} catch (e) {}
				if (raw == null) {
					try {
						if (SETTINGS_KEY in store) raw = store[SETTINGS_KEY];
					} catch (e) {}
				}
			}
		} catch (e) {}
		if (raw != null) {
			try {
				var parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
				if (parsed && typeof parsed === 'object') {
					for (var k in DEFAULT_SETTINGS) {
						if (isValidValue(k, parsed[k])) s[k] = parsed[k];
					}
				}
			} catch (e) {
				recordError('loadSettings', e);
			}
		}
		state.settings = s;
		return s;
	}

	function saveSettings() {
		try {
			var store = getStore();
			if (!store) return;
			var raw = JSON.stringify(state.settings);
			try {
				if (typeof store.set === 'function') {
					store.set(SETTINGS_KEY, raw);
					return;
				}
			} catch (e) {}
			try { store[SETTINGS_KEY] = raw; } catch (e) {}
		} catch (e) {}
	}

	function setSetting(name, value) {
		try {
			if (!isValidValue(name, value)) return false;
			state.settings[name] = value;
			saveSettings();
			toast('Reglage ' + name + ' = ' + String(value));
			return true;
		} catch (e) {
			return false;
		}
	}

	function setSettings(obj) {
		var out = { changed: [], rejected: [], values: {} };
		try {
			if (!obj || typeof obj !== 'object') return out;
			for (var k in obj) {
				if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
				if (isValidValue(k, obj[k])) {
					state.settings[k] = obj[k];
					out.changed.push(k);
				} else {
					out.rejected.push(k);
				}
			}
			if (out.changed.length) {
				saveSettings();
				toast('Reglages appliques : ' + out.changed.join(', '));
			}
		} catch (e) {
			recordError('setSettings', e);
		}
		for (var k2 in DEFAULT_SETTINGS) out.values[k2] = state.settings[k2];
		return out;
	}

	function getSetting(name) {
		try {
			return (name in state.settings) ? state.settings[name] : undefined;
		} catch (e) {
			return undefined;
		}
	}

	function getSettings() {
		var o = {};
		for (var k in state.settings) o[k] = state.settings[k];
		return o;
	}

	function resetSettings() {
		state.settings = defaultSettings();
		saveSettings();
		toast('Reglages par defaut restaures');
		return getSettings();
	}

	function getHiddenChannelIds() {
		var out = [];
		try {
			var keys = Object.keys(state.permCache);
			for (var i = 0; i < keys.length; i++) {
				var k = keys[i];
				if (state.permCache[k] && state.permCache[k].restricted) {
					var idx = k.lastIndexOf(':');
					out.push(idx >= 0 ? k.slice(idx + 1) : k);
				}
			}
		} catch (e) {
			recordError('getHiddenChannelIds', e);
		}
		return out;
	}

	function countGuilds() {
		try {
			var cs = refs.channelStore;
			if (cs && typeof cs.getGuildIds === 'function') return cs.getGuildIds().length;
			if (cs && typeof cs.getGuilds === 'function') return Object.keys(cs.getGuilds()).length;
		} catch (e) {}
		return null;
	}

	function buildDump() {
		var installed = [];
		for (var i = 0; i < state.patches.length; i++) installed.push(state.patches[i].label);
		var keys = Object.keys(state.permCache);
		var restricted = 0;
		for (var j = 0; j < keys.length; j++) {
			if (state.permCache[keys[j]].restricted) restricted++;
		}
		var mods = {};
		for (var m in state.modules) mods[m] = state.modules[m];
		return {
			version: VERSION,
			started: state.started,
			patchCount: state.patches.length,
			installedPatches: installed,
			missing: state.missing.slice(),
			optionalMissing: state.optionalMissing.slice(),
			errors: state.errors.slice(),
			settings: getSettings(),
			cache: {
				entries: keys.length,
				restricted: restricted,
				generation: state.permissionGeneration,
				hits: state.cacheStats.hits,
				misses: state.cacheStats.misses,
				expirations: state.cacheStats.expirations,
				writes: state.cacheStats.writes,
				trims: state.cacheStats.trims
			},
			modules: mods,
			hiddenChannelIds: getHiddenChannelIds(),
			runtime: {
				userId: state.userId != null ? 'present' : null,
				guildCount: countGuilds()
			}
		};
	}

	function formatDump() {
		try {
			var d = buildDump();
			var lines = [];
			lines.push('ShowHiddenChannels v' + d.version + (d.started ? ' [actif]' : ' [arrete]'));
			lines.push('patches installes : ' + d.patchCount + (d.installedPatches.length ? ' (' + d.installedPatches.join(', ') + ')' : ''));
			if (d.missing.length) lines.push('manquants CRITIQUES : ' + d.missing.join(', '));
			if (d.optionalMissing.length) lines.push('manquants optionnels : ' + d.optionalMissing.join(', '));
			var absent = [];
			for (var m in d.modules) {
				if (!d.modules[m]) absent.push(m);
			}
			lines.push('modules absents : ' + (absent.length ? absent.join(', ') : 'aucun'));
			lines.push('cache : ' + d.cache.entries + ' entrees (' + d.cache.restricted + ' restreintes), generation ' + d.cache.generation + ', lectures ' + d.cache.hits + ', echecs ' + d.cache.misses + ', expirations ' + d.cache.expirations + ', ecritures ' + d.cache.writes + ', purges ' + d.cache.trims);
			lines.push('salons restreints connus : ' + (d.hiddenChannelIds.length ? d.hiddenChannelIds.join(', ') : 'aucun'));
			lines.push('erreurs recentes : ' + d.errors.length);
			for (var e = 0; e < d.errors.length; e++) {
				lines.push('  [' + d.errors[e].scope + '] ' + d.errors[e].message);
			}
			lines.push('reglages : ' + JSON.stringify(d.settings));
			lines.push('compte : ' + (d.runtime.userId || 'inconnu'));
			var out = '';
			for (var i = 0; i < lines.length; i++) out += (i > 0 ? '\n' : '') + lines[i];
			return out;
		} catch (e) {
			return 'formatDump indisponible : ' + (e && e.message ? e.message : String(e));
		}
	}

	function okPatch(label, critical, factory) {
		var stamp = now();
		try {
			var unpatch = factory();
			if (typeof unpatch === 'function') {
				state.patches.push({ label: label, critical: !!critical, unpatch: unpatch, installedAt: stamp });
				debugLog('patch', label + ' ok');
				return true;
			}
		} catch (e) {
			recordError('patch:' + label, e);
		}
		if (critical) state.missing.push(label);
		else state.optionalMissing.push(label);
		debugLog('patch', label + ' manquant');
		return false;
	}

	function guardAction(label, obj, method, opts) {
		opts = opts || {};
		return okPatch(label, false, function () {
			if (!obj || typeof obj[method] !== 'function') return null;
			return Patcher.instead(obj, method, function (ctx) {
				try {
					if (opts.gate) {
						for (var i = 0; i < opts.gate.length; i++) {
							if (state.settings[opts.gate[i]] !== true) {
								return ctx.original.apply(ctx.this, ctx.args);
							}
						}
					}
					var cid = extractChannelId(ctx.args);
					if (cid != null) {
						var cs = refs.channelStore;
						if (cs && typeof cs.getChannel === 'function') {
							var channel = cs.getChannel(cid);
							if (channel && isRestricted(channel)) {
								if (typeof opts.onBlock === 'function') {
									try { opts.onBlock(channel); } catch (e2) { recordError('onBlock:' + label, e2); }
								}
								debugLog('garde', label + ' bloque ' + cid);
								return ('blockValue' in opts) ? opts.blockValue : null;
							}
						}
					}
				} catch (e) {
					recordError('garde:' + label, e);
				}
				return ctx.original.apply(ctx.this, ctx.args);
			});
		});
	}

	function installIsHidden(ChannelRecordBase) {
		try {
			if (!ChannelRecordBase || !ChannelRecordBase.prototype) return;
			var proto = ChannelRecordBase.prototype;
			var had = Object.prototype.hasOwnProperty.call(proto, 'isHidden');
			var original = proto.isHidden;
			if (had) {
				debugLog('isHidden', 'implementation existante preservee');
				return;
			}
			proto.isHidden = function () {
				try {
					if (!state.settings.markHidden) return false;
					if (isDmType(this.type)) return false;
					return isRestricted(this);
				} catch (e) {
					recordError('isHidden', e);
					return false;
				}
			};
			state.isHiddenInfo = { proto: proto, had: had, original: original };
			debugLog('isHidden', 'installe');
		} catch (e) {
			recordError('installIsHidden', e);
		}
	}

	function start() {
		if (state.started) {
			toast('Deja actif - v' + VERSION);
			return;
		}
		if (!metro || !Patcher) {
			toast('ERREUR v' + VERSION + ' : patcher indisponible');
			return;
		}

		var PermissionStore = firstResult([
			function () { return metro.findStore && metro.findStore('Permission'); },
			function () { return metro.findByProps && metro.findByProps('can', 'canWithPartialContext'); },
			function () { return metro.findByProps && metro.findByProps('getChannelPermissions', 'can'); }
		]);

		var Constants = firstResult([
			function () { return metro.common && metro.common.Constants; },
			function () { return metro.findByProps && metro.findByProps('Permissions', 'ChannelTypes'); },
			function () { return metro.findByProps && metro.findByProps('VIEW_CHANNEL', 'SEND_MESSAGES'); }
		]);

		var perms = (Constants && Constants.Permissions) || null;
		var ctt = (Constants && Constants.ChannelTypes) || null;
		refs.VIEW = perms && perms.VIEW_CHANNEL != null ? perms.VIEW_CHANNEL : 1024;
		refs.CONNECT = perms && perms.CONNECT != null ? perms.CONNECT : 1048576;
		refs.SEND = perms && perms.SEND_MESSAGES != null ? perms.SEND_MESSAGES : 2048;

		function pick(name, fallback) {
			return (ctt && ctt[name] != null) ? ctt[name] : fallback;
		}
		CT.text = [pick('GUILD_TEXT', 0), pick('GUILD_ANNOUNCEMENT', 5), pick('GUILD_MEDIA', 16), 6];
		CT.voice = [pick('GUILD_VOICE', 2)];
		CT.stage = [pick('GUILD_STAGE_VOICE', 13)];
		CT.forum = [pick('GUILD_FORUM', 15)];
		CT.directory = [pick('GUILD_DIRECTORY', 14)];
		CT.category = [pick('GUILD_CATEGORY', 4)];
		CT.publicThread = [pick('PUBLIC_THREAD', 11)];
		CT.privateThread = [pick('PRIVATE_THREAD', 12)];

		var ChannelStore = firstResult([
			function () { return metro.findStore && metro.findStore('Channel'); },
			function () { return metro.findByProps && metro.findByProps('getChannel', 'getMutableGuildChannelsForGuild'); }
		]);

		var FetchModule = firstResult([function () { return metro.findByProps && metro.findByProps('fetchMessages'); }]);
		var JumpModule = firstResult([function () { return metro.findByProps && metro.findByProps('jumpToMessage'); }]);
		var JoinModule = firstResult([function () { return metro.findByProps && metro.findByProps('joinVoiceChannel'); }]);
		var SelectModule = firstResult([function () { return metro.findByProps && metro.findByProps('selectVoiceChannel'); }]);
		var AckModule = firstResult([function () { return metro.findByProps && metro.findByProps('acknowledge'); }]);

		var UnreadStore = firstResult([
			function () { return metro.findStore && metro.findStore('Unread'); },
			function () { return metro.findByProps && metro.findByProps('isForumPostUnread'); }
		]);

		var Dispatcher = firstResult([
			function () { return metro.common && metro.common.Dispatcher; },
			function () { return metro.findByProps && metro.findByProps('_currentDispatchActionType', '_processingWaitQueue'); },
			function () { return metro.findByProps && metro.findByProps('dispatch', 'subscribe'); }
		]);

		var UserStore = firstResult([
			function () { return metro.findStore && metro.findStore('User'); },
			function () { return metro.findByProps && metro.findByProps('getCurrentUser'); },
			function () { return metro.findByProps && metro.findByProps('getCurrentUserId'); }
		]);

		var CRBOwner = firstResult([function () { return metro.findByProps && metro.findByProps('ChannelRecordBase'); }]);
		var ChannelRecordBase = CRBOwner ? CRBOwner.ChannelRecordBase : null;

		state.patches.length = 0;
		state.missing = [];
		state.optionalMissing = [];
		state.errors = [];
		state.permCache = {};
		state.cacheSize = 0;
		state.permissionGeneration = 1;
		state.cacheStats = { hits: 0, misses: 0, expirations: 0, writes: 0, trims: 0 };
		state.toastCooldown = {};
		state.refreshScheduled = false;
		state.isHiddenInfo = null;
		loadSettings();

		refs.realCan = (PermissionStore && typeof PermissionStore.can === 'function') ? PermissionStore.can.bind(PermissionStore) : null;
		refs.channelStore = ChannelStore || null;
		refs.dispatcher = Dispatcher || null;
		refs.userStore = UserStore || null;
		state.userId = getUserId();

		state.modules = {
			permissionStore: !!PermissionStore,
			can: typeof refs.realCan === 'function',
			canWithPartialContext: !!(PermissionStore && typeof PermissionStore.canWithPartialContext === 'function'),
			channelStore: !!ChannelStore,
			dispatcher: !!Dispatcher,
			fetchMessages: !!FetchModule,
			jumpToMessage: !!JumpModule,
			joinVoiceChannel: !!JoinModule,
			selectVoiceChannel: !!SelectModule,
			acknowledge: !!AckModule,
			unreadStore: !!UnreadStore,
			channelRecordBase: !!ChannelRecordBase
		};

		// 1) PermissionStore.can : retournement VIEW_CHANNEL false -> true SANS
		//    recalcul (ctx.result est deja le verdict du vrai can), avec
		//    ecriture du cache contextualise. CONNECT/SEND jamais modifies.
		okPatch('PermissionStore.can', true, function () {
			if (!PermissionStore || typeof PermissionStore.can !== 'function') return null;
			return Patcher.after(PermissionStore, 'can', function (ctx) {
				try {
					var perm = ctx.args && ctx.args[0];
					var target = ctx.args && ctx.args[1];
					if (!isChannelLike(target)) return ctx.result;
					if (!samePerm(perm, refs.VIEW)) return ctx.result;
					if (isDmType(target.type)) return ctx.result;
					var channel = resolveChannel(target);
					if (!channel || channel.id == null) return ctx.result;
					var status;
					if (ctx.result === true) status = STATUS.ACCESSIBLE;
					else if (ctx.result === false) status = STATUS.RESTRICTED;
					else return ctx.result;
					setCached(cacheKey(channel), status === STATUS.RESTRICTED);
					if (status === STATUS.RESTRICTED && typeShown(channel)) ctx.result = true;
				} catch (e) {
					recordError('patch:can', e);
				}
				return ctx.result;
			});
		});

		// 2) canWithPartialContext : contextes partiels { guildId, channelId }.
		//    Fonctionne meme si le salon n'est pas encore dans le ChannelStore :
		//    le verdict vient du vrai appel, le cache est keyed sur le contexte.
		okPatch('PermissionStore.canWithPartialContext', true, function () {
			if (!PermissionStore || typeof PermissionStore.canWithPartialContext !== 'function') return null;
			return Patcher.after(PermissionStore, 'canWithPartialContext', function (ctx) {
				try {
					var perm = ctx.args && ctx.args[0];
					var target = ctx.args && ctx.args[1];
					if (!target || typeof target !== 'object') return ctx.result;
					if (!samePerm(perm, refs.VIEW)) return ctx.result;
					if (target.channelId == null && target.channel_id == null) return ctx.result;
					var partial = resolvePartialChannel(target);
					if (!partial) return ctx.result;
					var status;
					if (ctx.result === true) status = STATUS.ACCESSIBLE;
					else if (ctx.result === false) status = STATUS.RESTRICTED;
					else return ctx.result;
					setCached(cacheKey(partial), status === STATUS.RESTRICTED);
					if (status === STATUS.RESTRICTED && typeShown(partial)) ctx.result = true;
				} catch (e) {
					recordError('patch:canWithPartialContext', e);
				}
				return ctx.result;
			});
		});

		// 3) Invalidation paresseuse du cache (generation) + detection de
		//    changement de compte + reconstruction coalescee.
		okPatch('Dispatcher.dispatch', true, function () {
			if (!Dispatcher || typeof Dispatcher.dispatch !== 'function') return null;
			return Patcher.before(Dispatcher, 'dispatch', function (ctx) {
				try {
					var action = ctx.args && ctx.args[0];
					var type = action && action.type;
					if (!type || !INVALIDATE[type]) return;
					var uid = getUserId();
					if (uid != null) {
						if (state.userId != null && uid !== state.userId) {
							debugLog('compte', 'changement de compte detecte');
						}
						state.userId = uid;
					}
					invalidateAll(type);
					scheduleRefresh();
				} catch (e) {
					recordError('patch:dispatch', e);
				}
			});
		});

		// 4) Gardes d'actions : jamais solliciter un salon reellement restreint.
		//    Un statut inconnu ne bloque jamais (passthrough).
		guardAction('fetchMessages', FetchModule, 'fetchMessages', {
			gate: ['safety', 'preventNetworkRequests'],
			onBlock: function (ch) {
				toastOnce('fetch:' + String(ch.id), 'Salon restreint : chargement des messages bloque');
			}
		});
		guardAction('jumpToMessage', JumpModule, 'jumpToMessage', {
			gate: ['safety', 'preventNetworkRequests']
		});
		guardAction('joinVoiceChannel', JoinModule, 'joinVoiceChannel', {
			gate: ['safety', 'preventOpenAttempt'],
			onBlock: function (ch) {
				toastOnce('voice:' + String(ch.id), 'Salon vocal restreint : connexion bloquee');
			}
		});
		guardAction('selectVoiceChannel', SelectModule, 'selectVoiceChannel', {
			gate: ['safety', 'preventOpenAttempt'],
			onBlock: function (ch) {
				toastOnce('voice:' + String(ch.id), 'Salon vocal restreint : connexion bloquee');
			}
		});
		guardAction('acknowledge', AckModule, 'acknowledge', {
			gate: ['safety', 'preventOpenAttempt']
		});

		// 5) UnreadStore : aucun badge de non-lu sur les salons restreints.
		var unreadGuards = [
			['getGuildChannelUnreadState', { mentionCount: 0, hasNotableUnread: false }],
			['getMentionCount', 0],
			['getUnreadCount', 0]
		];
		for (var u = 0; u < unreadGuards.length; u++) {
			(function (methodName, blockValue) {
				okPatch('UnreadStore.' + methodName, false, function () {
					if (!UnreadStore || typeof UnreadStore[methodName] !== 'function') return null;
					return Patcher.after(UnreadStore, methodName, function (ctx) {
						try {
							if (state.settings.blockUnreads !== true) return ctx.result;
							var cid = extractChannelId(ctx.args);
							if (cid == null) return ctx.result;
							var cs = refs.channelStore;
							if (!cs || typeof cs.getChannel !== 'function') return ctx.result;
							var channel = cs.getChannel(cid);
							if (channel && isRestricted(channel)) ctx.result = blockValue;
						} catch (e) {
							recordError('patch:' + methodName, e);
						}
						return ctx.result;
					});
				});
			})(unreadGuards[u][0], unreadGuards[u][1]);
		}

		// 6) isHidden : marquer les salons reellement caches, comme le client
		//    natif. Ajout seulement si absent, restauration exacte au stop.
		installIsHidden(ChannelRecordBase);

		// 7) Reconstruction coalescee de la liste des salons.
		scheduleRefresh();
		state.started = true;

		var handle = {
			setSetting: setSetting,
			setSettings: setSettings,
			getSetting: getSetting,
			getSettings: getSettings,
			resetSettings: resetSettings,
			getHiddenChannelIds: getHiddenChannelIds,
			refresh: function () { refreshChannelList(); },
			dump: buildDump,
			formatDump: formatDump
		};
		try { api.__showHiddenChannels = handle; } catch (e) {
			recordError('handle', e);
		}

		var content = 'Actif v' + VERSION + ' - ' + state.patches.length + ' patches';
		if (state.missing.length) {
			content += ' (manque: ' + state.missing.join(', ') + ')';
		} else {
			content += ' - change de serveur puis reviens';
		}
		toast(content);
	}

	function stop() {
		try {
			for (var i = state.patches.length - 1; i >= 0; i--) {
				try {
					state.patches[i].unpatch();
				} catch (e) {
					recordError('unpatch:' + state.patches[i].label, e);
				}
			}
		} catch (e) {
			recordError('stop:unpatch', e);
		}
		state.patches.length = 0;
		try {
			if (Patcher && typeof Patcher.unpatchAll === 'function') Patcher.unpatchAll();
		} catch (e) {}

		if (state.isHiddenInfo) {
			try {
				var info = state.isHiddenInfo;
				if (info.had && typeof info.original !== 'undefined') {
					info.proto.isHidden = info.original;
				} else {
					delete info.proto.isHidden;
				}
			} catch (e) {
				recordError('stop:isHidden', e);
			}
			state.isHiddenInfo = null;
		}

		state.permCache = {};
		state.cacheSize = 0;
		state.permissionGeneration = 1;
		state.missing = [];
		state.optionalMissing = [];
		state.modules = {};
		state.refreshScheduled = false;
		state.toastCooldown = {};
		state.started = false;

		try { if (api) delete api.__showHiddenChannels; } catch (e) {}

		try { refreshChannelList(); } catch (e) {
			recordError('stop:refresh', e);
		}
		toast('Arrete - patches retires');
	}

	return {
		start: start,
		stop: stop,
		default: { start: start, stop: stop }
	};
})()