import { Socket } from "phoenix";
import { Presence } from "phoenix";
import configs from "../utils/configs";
import { getDefaultWorldColorPreset } from "../../jel/utils/world-color-presets";

const MIN_DEFAULT_WORLD_TYPE = 1;
const MAX_DEFAULT_WORLD_TYPE = 3;

export function hasReticulumServer() {
  return !!configs.RETICULUM_SERVER;
}

export function isLocalClient() {
  return hasReticulumServer() && document.location.host !== configs.RETICULUM_SERVER;
}

const resolverLink = document.createElement("a");
let reticulumMeta = null;
let invalidatedReticulumMetaThisSession = false;

export function getReticulumFetchUrl(path, absolute = false, host = null, port = null) {
  if (host || hasReticulumServer()) {
    return `https://${host || configs.RETICULUM_SERVER}${port ? `:${port}` : ""}${path}`;
  } else if (absolute) {
    resolverLink.href = path;
    return resolverLink.href;
  } else {
    return path;
  }
}

export async function getReticulumMeta() {
  if (!reticulumMeta) {
    // Initially look up version based upon page, avoiding round-trip, otherwise fetch.
    if (!invalidatedReticulumMetaThisSession && document.querySelector("meta[name='ret:version']")) {
      reticulumMeta = {
        version: document.querySelector("meta[name='ret:version']").getAttribute("value"),
        pool: document.querySelector("meta[name='ret:pool']").getAttribute("value"),
        phx_host: document.querySelector("meta[name='ret:phx_host']").getAttribute("value")
      };
    } else {
      await fetch(getReticulumFetchUrl("/api/v1/meta")).then(async res => {
        reticulumMeta = await res.json();
      });
    }
  }

  const qs = new URLSearchParams(location.search);
  const phxHostOverride = qs.get("phx_host");

  if (phxHostOverride) {
    reticulumMeta.phx_host = phxHostOverride;
  }

  return reticulumMeta;
}

let directReticulumHostAndPort;

async function refreshDirectReticulumHostAndPort() {
  const qs = new URLSearchParams(location.search);
  let host = qs.get("phx_host");
  const reticulumMeta = await getReticulumMeta();
  host = host || configs.RETICULUM_SOCKET_SERVER || reticulumMeta.phx_host;
  const port =
    qs.get("phx_port") ||
    (hasReticulumServer() ? new URL(`${document.location.protocol}//${configs.RETICULUM_SERVER}`).port : "443");
  directReticulumHostAndPort = { host, port };
}

export function getDirectReticulumFetchUrl(path, absolute = false) {
  if (!directReticulumHostAndPort) {
    console.warn("Cannot call getDirectReticulumFetchUrl before connectToReticulum. Returning non-direct url.");
    return getReticulumFetchUrl(path, absolute);
  }

  const { host, port } = directReticulumHostAndPort;
  return getReticulumFetchUrl(path, absolute, host, port);
}

export async function invalidateReticulumMeta() {
  invalidatedReticulumMetaThisSession = true;
  reticulumMeta = null;
}

export async function connectToReticulum(debug = false, params = null, socketClass = Socket, existingSocket = null) {
  const qs = new URLSearchParams(location.search);

  const getNewSocketUrl = async () => {
    await refreshDirectReticulumHostAndPort();
    const { host, port } = directReticulumHostAndPort;
    const protocol =
      qs.get("phx_protocol") ||
      configs.RETICULUM_SOCKET_PROTOCOL ||
      (document.location.protocol === "https:" ? "wss:" : "ws:");

    return `${protocol}//${host}${port ? `:${port}` : ""}`;
  };

  const socketUrl = await getNewSocketUrl();
  console.log(`Phoenix Socket URL: ${socketUrl}`);

  const socketSettings = {};

  if (debug) {
    socketSettings.logger = (kind, msg, data) => {
      console.log(`${kind}: ${msg}`, data);
    };
  }

  let socket = existingSocket;

  if (!socket) {
    if (params) {
      socketSettings.params = params;
    }

    socket = new socketClass(`${socketUrl}/socket`, socketSettings);

    socket.onError(async () => {
      // On error, underlying reticulum node may have died, so rebalance by
      // fetching a new healthy node to connect to.
      invalidateReticulumMeta();

      const endPointPath = new URL(socket.endPoint).pathname;
      const newSocketUrl = await getNewSocketUrl();
      const newEndPoint = `${newSocketUrl}${endPointPath}`;
      console.log(`Socket error, changed endpoint to ${newEndPoint}`);
      socket.endPoint = newEndPoint;
    });
  }

  socket.connect();

  return socket;
}

export function getLandingPageForPhoto(photoUrl) {
  const parsedUrl = new URL(photoUrl);
  return getReticulumFetchUrl(parsedUrl.pathname.replace(".png", ".html") + parsedUrl.search, true);
}

export function fetchReticulumAuthenticated(url, method = "GET", payload) {
  const { token } = window.APP.store.state.credentials;
  const retUrl = getReticulumFetchUrl(url);
  const params = {
    headers: { "content-type": "application/json" },
    method
  };
  if (token) {
    params.headers.authorization = `bearer ${token}`;
  }
  if (payload) {
    params.body = JSON.stringify(payload);
  }
  return fetch(retUrl, params).then(async r => {
    const result = await r.text();
    try {
      return JSON.parse(result);
    } catch (e) {
      // Some reticulum responses, particularly DELETE requests, don't return json.
      return result;
    }
  });
}

export async function createSpace(name) {
  const store = window.APP.store;
  const createUrl = getReticulumFetchUrl("/api/v1/spaces");
  const payload = { space: { name } };

  const headers = { "content-type": "application/json" };
  if (!store.state || !store.state.credentials.token) {
    throw new Error("Must be signed in to create space.");
  }

  headers.authorization = `bearer ${store.state.credentials.token}`;

  const res = await fetch(createUrl, {
    body: JSON.stringify(payload),
    headers,
    method: "POST"
  }).then(r => r.json());

  if (res.error === "invalid_token") {
    // Clear the invalid token from store.
    store.clearCredentials();
    throw new Error("Must be signed in to create space.");
  }

  return res;
}

export async function createHub(
  spaceId,
  type,
  name,
  template,
  worldType = null,
  worldSeed = null,
  worldColors = null,
  spawnPosition = null,
  spawnRotation = null,
  spawnRadius = null
) {
  const store = window.APP.store;
  const createUrl = getReticulumFetchUrl("/api/v1/hubs");
  const payload = { hub: { name, type: type, space_id: spaceId } };

  if (template) {
    payload.hub.template = template;
  }

  if (worldType !== null) {
    payload.hub.world_type = worldType;
  } else {
    payload.hub.world_type =
      MIN_DEFAULT_WORLD_TYPE + Math.floor(Math.random() * (MAX_DEFAULT_WORLD_TYPE - MIN_DEFAULT_WORLD_TYPE + 1));
  }

  if (worldSeed !== null) {
    payload.hub.world_seed = worldSeed;
  }

  if (worldColors === null) {
    worldColors = getDefaultWorldColorPreset();
  }

  for (const [k, v] of Object.entries(worldColors)) {
    payload.hub[`world_${k}`] = v;
  }

  if (spawnPosition != null) {
    payload.hub.spawn_position_x = spawnPosition.x;
    payload.hub.spawn_position_y = spawnPosition.y;
    payload.hub.spawn_position_z = spawnPosition.z;
  }

  if (spawnRotation != null) {
    payload.hub.spawn_rotation_x = spawnRotation.x;
    payload.hub.spawn_rotation_y = spawnRotation.y;
    payload.hub.spawn_rotation_z = spawnRotation.z;
    payload.hub.spawn_rotation_w = spawnRotation.w;
  }

  if (spawnRadius != null) {
    payload.hub.spawn_radius = spawnRadius;
  }

  const headers = { "content-type": "application/json" };
  if (store.state && store.state.credentials.token) {
    headers.authorization = `bearer ${store.state.credentials.token}`;
  }

  return await fetch(createUrl, {
    body: JSON.stringify(payload),
    headers,
    method: "POST"
  }).then(r => r.json());
}

export async function createVox(spaceId, hubId = null, bakedFromVoxId = null) {
  const store = window.APP.store;
  const createUrl = getReticulumFetchUrl("/api/v1/vox");
  const payload = { vox: { space_id: spaceId, hub_id: hubId, baked_from_vox_id: bakedFromVoxId } };

  const headers = { "content-type": "application/json" };

  if (store.state && store.state.credentials.token) {
    headers.authorization = `bearer ${store.state.credentials.token}`;
  }

  return await fetch(createUrl, {
    body: JSON.stringify(payload),
    headers,
    method: "POST"
  }).then(r => r.json());
}

export function getPresenceEntryForSession(presences, sessionId) {
  const entry = Object.entries(presences || {}).find(([k]) => k === sessionId) || [];
  const presence = entry[1];
  return (presence && presence.metas && presence.metas[0]) || {};
}

export function getPresenceContextForSession(presences, sessionId) {
  return (getPresenceEntryForSession(presences, sessionId) || {}).context || {};
}

export function getPresenceProfileForSession(presences, sessionId) {
  return (getPresenceEntryForSession(presences, sessionId) || {}).profile || {};
}

// Unbinds presence, and returns a function that must be passed the new channel to rebind.
export function unbindPresence(presence) {
  if (!presence) return () => presence;

  const presenceBindings = {
    onJoin: presence.caller.onJoin,
    onLeave: presence.caller.onLeave,
    onSync: presence.caller.onSync
  };

  presence.onJoin(function() {});
  presence.onLeave(function() {});
  presence.onSync(function() {});

  return channel => {
    const presence = new Presence(channel);
    presence.onJoin(presenceBindings.onJoin);
    presence.onLeave(presenceBindings.onLeave);
    presence.onSync(presenceBindings.onSync);
    return presence;
  };
}
