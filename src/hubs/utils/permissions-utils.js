import { getCreator, getNetworkedTemplate } from "../../jel/utils/ownership-utils";

// Brief overview of client authorization can be found in the wiki:
// https://github.com/mozilla/hubs/wiki/Hubs-authorization
export function canMove(el) {
  const isHoldableButton = el.components.tags && el.components.tags.data.holdableButton;
  const mediaLoader = el.components["media-loader"];
  const isMedia = !!mediaLoader;
  const canMove = window.APP.hubChannel.can("spawn_and_move_media");
  const isLocked = mediaLoader && mediaLoader.data.locked;
  return isHoldableButton || (isMedia && canMove && !isLocked);
}

export function canCloneOrSnapshot(el) {
  const isHoldableButton = el.components.tags && el.components.tags.data.holdableButton;
  const mediaLoader = el.components["media-loader"];
  const isMedia = !!mediaLoader;
  const canSpawn = window.APP.hubChannel.can("spawn_and_move_media");
  return isHoldableButton || (isMedia && canSpawn);
}

export function showHoverEffect(el) {
  const isMedia = !!el.components["media-loader"];
  return isMedia && canMove(el);
}

function indexForComponent(component, schema) {
  const fullComponent = typeof component === "string";
  const componentName = fullComponent ? component : component.component;

  if (fullComponent) {
    return schema.components.findIndex(schemaComponent => schemaComponent === componentName);
  } else {
    return schema.components.findIndex(
      schemaComponent => schemaComponent.component === componentName && schemaComponent.property === component.property
    );
  }
}

let nonAuthorizedSchemas = null;
function initializeNonAuthorizedSchemas() {
  /*
  Takes the NAF schemas defined in network-schemas.js and produces a data structure of template name to non-authorized
  component indices:
  {
    "#interactable-media": ["4", "5", "6"]
  }
  */
  nonAuthorizedSchemas = {};
  const { schemaDict } = NAF.schemas;
  for (const template in schemaDict) {
    if (!schemaDict.hasOwnProperty(template)) continue;
    const schema = schemaDict[template];
    nonAuthorizedSchemas[template] = (schema.nonAuthorizedComponents || [])
      .map(nonAuthorizedComponent => indexForComponent(nonAuthorizedComponent, schema))
      .map(index => index.toString());
  }
}

function sanitizeMessageData(template, data) {
  if (nonAuthorizedSchemas === null) {
    initializeNonAuthorizedSchemas();
  }
  const nonAuthorizedIndices = nonAuthorizedSchemas[template];
  for (const index in data.components) {
    if (!data.components.hasOwnProperty(index)) continue;
    if (!nonAuthorizedIndices.includes(index)) {
      data.components[index] = null;
    }
  }
  return data;
}

function authorizeEntityManipulation(entityMetadata, sender, senderPermissions) {
  const { template, creator } = entityMetadata;
  const isCreator = sender === creator;

  if (template.endsWith("-avatar")) {
    return isCreator;
  } else if (template.endsWith("-media")) {
    return isCreator || senderPermissions.spawn_and_move_media;
  } else if (template.endsWith("-camera")) {
    return isCreator || senderPermissions.spawn_camera;
  } else if (template.endsWith("-pen") || template.endsWith("-drawing")) {
    return isCreator || senderPermissions.spawn_drawing;
  } else {
    return false;
  }
}

function getPendingOrExistingEntityMetadata(networkId) {
  const pendingData = NAF.connection.adapter.getPendingDataForNetworkId(networkId);

  if (pendingData) {
    if (pendingData.owner) {
      // If owner is no longer present, give up.
      const presenceState = window.APP.hubChannel.presence.state[pendingData.owner];
      if (!presenceState) return;
    }

    const { template, creator } = pendingData;
    return { template, creator };
  }

  const entity = NAF.entities.getEntity(networkId);
  if (!entity) return null;

  const template = getNetworkedTemplate(entity);
  const creator = getCreator(entity);
  return { template, creator };
}

function authorizeOrSanitizeMessageData(data, sender, senderPermissions) {
  const entityMetadata = getPendingOrExistingEntityMetadata(data.networkId);
  if (!entityMetadata) return false;

  if (authorizeEntityManipulation(entityMetadata, sender, senderPermissions)) {
    return true;
  } else {
    const { template } = entityMetadata;
    sanitizeMessageData(template, data);
    return true;
  }
}

// If we receive a sync from a persistent object that we don't have an entity for yet, it must be a scene-owned object
// Since we need to get metadata (the template id in particular) from the entity, we must stash these messages until
// the scene has loaded.
// Components which require this data must call applyPersistentSync after they are initialized
const persistentSyncs = {};
function stashPersistentSync(message, entityData) {
  if (!persistentSyncs[entityData.networkId]) {
    persistentSyncs[entityData.networkId] = {
      dataType: "u",
      data: entityData,
      clientId: message.clientId,
      from_session_id: message.from_session_id
    };
  } else {
    const currentData = persistentSyncs[entityData.networkId].data;
    const currentComponents = currentData.components;
    Object.assign(currentData, entityData);
    currentData.components = Object.assign(currentComponents, entityData.components);
  }
}

const emptyObject = {};
export function authorizeOrSanitizeMessage(message) {
  const { dataType, from_session_id } = message;

  if (dataType === "u" && message.data.isFirstSync && !message.data.persistent) {
    // The server has already authorized first sync messages that result in an instantiation.
    return message;
  }

  const presenceState = window.APP.hubChannel.presence.state[from_session_id];

  if (!presenceState) {
    // We've received a manipulation message from a user that we don't have presence state for yet.
    // Since we can't make a judgement about their permissions, we'll have to ignore the message.
    return emptyObject;
  }

  const senderPermissions = presenceState.metas[0].permissions;

  if (dataType === "um") {
    let sanitizedAny = false;
    let stashedAny = false;
    for (const index in message.data.d) {
      if (!message.data.d.hasOwnProperty(index)) continue;
      const entityData = message.data.d[index];
      if (entityData.persistent && !NAF.entities.getEntity(entityData.networkId)) {
        stashPersistentSync(message, entityData);
        message.data.d[index] = null;
        stashedAny = true;
      } else {
        const authorizedOrSanitized = authorizeOrSanitizeMessageData(entityData, from_session_id, senderPermissions);
        if (!authorizedOrSanitized) {
          message.data.d[index] = null;
          sanitizedAny = true;
        }
      }
    }

    if (sanitizedAny || stashedAny) {
      message.data.d = message.data.d.filter(x => x != null);
    }

    return message;
  } else if (dataType === "u") {
    if (message.data.persistent && !NAF.entities.getEntity(message.data.networkId)) {
      persistentSyncs[message.data.networkId] = message;
      return emptyObject;
    } else {
      const authorizedOrSanitized = authorizeOrSanitizeMessageData(message.data, from_session_id, senderPermissions);
      if (authorizedOrSanitized) {
        return message;
      } else {
        return emptyObject;
      }
    }
  } else if (dataType === "r") {
    const entityMetadata = getPendingOrExistingEntityMetadata(message.data.networkId);
    if (!entityMetadata) return emptyObject;
    if (authorizeEntityManipulation(entityMetadata, from_session_id, senderPermissions)) {
      return message;
    } else {
      return emptyObject;
    }
  } else {
    // Fall through for other data types. Namely, "drawing-<networkId>" messages at the moment.
    return message;
  }
}

const PHOENIX_RELIABLE_NAF = "phx-reliable";
export function applyPersistentSync(networkId) {
  if (!persistentSyncs[networkId]) return;
  NAF.connection.adapter.onData(authorizeOrSanitizeMessage(persistentSyncs[networkId]), PHOENIX_RELIABLE_NAF);
  delete persistentSyncs[networkId];
}
