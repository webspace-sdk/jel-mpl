import nextTick from "../utils/next-tick";
import { mapMaterials } from "../utils/material-utils";
import SketchfabZipWorker from "../workers/sketchfab-zip.worker.js";
import MobileStandardMaterial from "../materials/MobileStandardMaterial";
import { getCustomGLTFParserURLResolver } from "../utils/media-url-utils";
import { hasMediaLayer, MEDIA_INTERACTION_TYPES } from "../utils/media-utils";
import { promisifyWorker } from "../utils/promisify-worker.js";
import { acceleratedRaycast } from "three-mesh-bvh";
import { generateMeshBVH } from "../utils/three-utils";
import { disposeNode, disposeExistingMesh, cloneObject3D } from "../utils/three-utils";
import HubsTextureLoader from "../loaders/HubsTextureLoader";
import HubsBasisTextureLoader from "../loaders/HubsBasisTextureLoader";
import { resetMediaRotation, MEDIA_PRESENCE } from "../utils/media-utils";
import { addVertexCurvingToMaterial } from "../../jel/systems/terrain-system";
import { RENDER_ORDER } from "../constants";

THREE.Mesh.prototype.raycast = acceleratedRaycast;
let toonGradientMap;

(() => {
  const colors = new Uint8Array(3);

  for (let c = 0; c <= colors.length; c++) {
    colors[c] = (c / colors.length) * 256;
  }

  toonGradientMap = new THREE.DataTexture(colors, colors.length, 1, THREE.LuminanceFormat);
  toonGradientMap.minFilter = THREE.NearestFilter;
  toonGradientMap.magFilter = THREE.NearestFilter;
  toonGradientMap.generateMipmaps = false;
})();

class GLTFCache {
  cache = new Map();

  set(src, gltf) {
    this.cache.set(src, {
      gltf,
      count: 0
    });
    return this.retain(src);
  }

  has(src) {
    return this.cache.has(src);
  }

  get(src) {
    return this.cache.get(src);
  }

  retain(src) {
    const cacheItem = this.cache.get(src);
    cacheItem.count++;
    return cacheItem;
  }

  clear() {
    for (const src of [...this.cache.keys()]) {
      this.release(src, true);
    }
  }

  release(src, force = false) {
    const cacheItem = this.cache.get(src);

    if (!cacheItem) {
      console.error(`Releasing uncached gltf ${src}`);
      return;
    }

    cacheItem.count--;
    if (cacheItem.count <= 0 || force) {
      cacheItem.gltf.scene.traverse(disposeNode);
      this.cache.delete(src);
    }
  }
}
const gltfCache = new GLTFCache();
const inflightGltfs = new Map();

const extractZipFile = promisifyWorker(new SketchfabZipWorker());

function defaultInflator(el, componentName, componentData) {
  if (!AFRAME.components[componentName]) {
    throw new Error(`Inflator failed. "${componentName}" component does not exist.`);
  }
  if (AFRAME.components[componentName].multiple && Array.isArray(componentData)) {
    for (let i = 0; i < componentData.length; i++) {
      el.setAttribute(componentName + "__" + i, componentData[i]);
    }
  } else {
    el.setAttribute(componentName, componentData);
  }
}

AFRAME.GLTFModelPlus = {
  // eslint-disable-next-line no-unused-vars
  components: {},
  registerComponent(componentKey, componentName, inflator) {
    inflator = inflator || defaultInflator;
    AFRAME.GLTFModelPlus.components[componentKey] = { inflator, componentName };
  }
};

async function cloneGltf(gltf) {
  return {
    animations: gltf.scene.animations,
    scene: await cloneObject3D(gltf.scene)
  };
}

function getHubsComponents(node) {
  const hubsComponents =
    node.userData.gltfExtensions &&
    (node.userData.gltfExtensions.MOZ_hubs_components || node.userData.gltfExtensions.HUBS_components);

  // We can remove support for legacy components when our environment, avatar and interactable models are
  // updated to match Spoke output.
  const legacyComponents = node.userData.components;

  return hubsComponents || legacyComponents;
}

/// Walks the tree of three.js objects starting at the given node, using the GLTF data
/// and template data to construct A-Frame entities and components when necessary.
/// (It's unnecessary to construct entities for subtrees that have no component data
/// or templates associated with any of their nodes.)
///
/// Returns the A-Frame entity associated with the given node, if one was constructed.
const inflateEntities = function(indexToEntityMap, node, templates, isRoot, modelToWorldScale = 1) {
  // TODO: Remove this once we update the legacy avatars to the new node names
  if (node.name === "Chest") {
    node.name = "Spine";
  } else if (node.name === "Root Scene") {
    node.name = "AvatarRoot";
  } else if (node.name === "Bot_Skinned") {
    node.name = "AvatarMesh";
  }

  const entityComponents = getHubsComponents(node);

  // Skip legacy hubs nav meshes
  if (
    entityComponents &&
    ("nav-mesh" in entityComponents ||
      "heightfield" in entityComponents ||
      "image" in entityComponents ||
      "skybox" in entityComponents ||
      "media-frame" in entityComponents ||
      "networked" in entityComponents ||
      "spawn-point" in entityComponents ||
      "scene-preview-camera" in entityComponents)
  ) {
    node.parent.remove(node);

    return;
  }

  // inflate subtrees first so that we can determine whether or not this node needs to be inflated
  const childEntities = [];
  const children = node.children.slice(0); // setObject3D mutates the node's parent, so we have to copy
  for (const child of children) {
    const el = inflateEntities(indexToEntityMap, child, templates);
    if (el) {
      childEntities.push(el);
    }
  }

  const nodeHasBehavior = !!entityComponents || node.name in templates;
  if (!nodeHasBehavior && !childEntities.length && !isRoot) {
    return null; // we don't need an entity for this node
  }

  const el = document.createElement("a-entity");
  el.append.apply(el, childEntities);

  // hubs components removed, so deal with visibility here
  if (entityComponents && entityComponents.visible && !entityComponents.visible.visible) {
    el.object3D.visible = false;
  }

  // Remove invalid CSS class name characters.
  const className = (node.name || node.uuid).replace(/[^\w-]/g, "");
  el.classList.add(className);

  // AFRAME rotation component expects rotations in YXZ, convert it
  if (node.rotation.order !== "YXZ") {
    node.rotation.setFromQuaternion(node.quaternion, "YXZ");
  }

  // Copy over the object's transform to the THREE.Group and reset the actual transform of the Object3D
  // all updates to the object should be done through the THREE.Group wrapper
  el.object3D.position.copy(node.position);
  el.object3D.rotation.copy(node.rotation);
  el.object3D.scale.copy(node.scale).multiplyScalar(modelToWorldScale);
  el.object3D.matrixNeedsUpdate = true;

  node.matrixAutoUpdate = false;
  node.matrix.identity();
  node.matrix.decompose(node.position, node.rotation, node.scale);

  // HACK for 1729
  if (node.name.startsWith("HexFloor")) {
    el.object3D.position.y += 0.05;
    el.object3D.matrixNeedsUpdate = true;
  }

  el.setObject3D(node.type.toLowerCase(), node);

  // Set the name of the `THREE.Group` to match the name of the node,
  // so that templates can be attached to the correct AFrame entity.
  el.object3D.name = node.name;

  // Set the uuid of the `THREE.Group` to match the uuid of the node,
  // so that `THREE.PropertyBinding` will find (and later animate)
  // the group. See `PropertyBinding.findNode`:
  // https://github.com/mrdoob/three.js/blob/dev/src/animation/PropertyBinding.js#L211
  el.object3D.uuid = node.uuid;
  node.uuid = THREE.Math.generateUUID();

  if (node.animations) {
    // Pass animations up to the group object so that when we can pass the group as
    // the optional root in `THREE.AnimationMixer.clipAction` and use the hierarchy
    // preserved under the group (but not the node). Otherwise `clipArray` will be
    // `null` in `THREE.AnimationClip.findByName`.
    node.parent.animations = node.animations;
  }

  if (node.morphTargetInfluences) {
    node.parent.morphTargetInfluences = node.morphTargetInfluences;
  }

  const gltfIndex = node.userData.gltfIndex;
  if (gltfIndex !== undefined) {
    indexToEntityMap[gltfIndex] = el;
  }

  return el;
};

async function inflateComponents(inflatedEntity, indexToEntityMap) {
  let isFirstInflation = true;
  const objectInflations = [];

  inflatedEntity.object3D.traverse(async object3D => {
    const objectInflation = {};
    objectInflation.promise = new Promise(resolve => (objectInflation.resolve = resolve));
    objectInflations.push(objectInflation);

    if (!isFirstInflation) {
      await objectInflations.shift().promise;
    }
    isFirstInflation = false;

    const entityComponents = getHubsComponents(object3D);
    const el = object3D.el;

    if (entityComponents && el) {
      for (const prop in entityComponents) {
        if (entityComponents.hasOwnProperty(prop) && AFRAME.GLTFModelPlus.components.hasOwnProperty(prop)) {
          const { componentName, inflator } = AFRAME.GLTFModelPlus.components[prop];
          await inflator(el, componentName, entityComponents[prop], entityComponents, indexToEntityMap);
        }
      }
    }

    objectInflation.resolve();
  });

  await objectInflations.shift().promise;
}

function attachTemplate(root, name, templateRoot) {
  const targetEls = root.querySelectorAll("." + name);
  for (const el of targetEls) {
    const root = templateRoot.cloneNode(true);
    // Merge root element attributes with the target element
    for (const { name, value } of root.attributes) {
      el.setAttribute(name, value);
    }

    // Append all child elements
    while (root.children.length > 0) {
      el.appendChild(root.children[0]);
    }
  }
}

function getHubsComponentsExtension(node) {
  if (node.extensions && node.extensions.MOZ_hubs_components) {
    return node.extensions.MOZ_hubs_components;
  } else if (node.extensions && node.extensions.HUBS_components) {
    return node.extensions.HUBS_components;
  } else if (node.extras && node.extras.gltfExtensions && node.extras.gltfExtensions.MOZ_hubs_components) {
    return node.extras.gltfExtensions.MOZ_hubs_components;
  }
}

// Versions are documented here: https://github.com/mozilla/hubs/wiki/MOZ_hubs_components-Changelog
// Make sure to update the wiki and Spoke when bumping a version
function runMigration(version, json) {
  if (version < 2) {
    //old heightfields will be on the same node as the nav-mesh, delete those
    const oldHeightfieldNode = json.nodes.find(node => {
      const components = getHubsComponentsExtension(node);
      return components && components.heightfield && components["nav-mesh"];
    });
    if (oldHeightfieldNode) {
      if (oldHeightfieldNode.extensions && oldHeightfieldNode.extensions.MOZ_hubs_components) {
        delete oldHeightfieldNode.extensions.MOZ_hubs_components.heightfield;
      } else if (oldHeightfieldNode.extensions && oldHeightfieldNode.extensions.HUBS_components) {
        delete oldHeightfieldNode.extensions.HUBS_components.heightfield;
      } else if (
        oldHeightfieldNode.extras &&
        oldHeightfieldNode.extras.gltfExtensions &&
        oldHeightfieldNode.extras.gltfExtensions.MOZ_hubs_components
      ) {
        delete oldHeightfieldNode.extras.gltfExtensions.MOZ_hubs_components;
      }
    }
  }

  if (version < 4) {
    // Lights prior to version 4 should treat range === 0 as if it has zero decay
    if (json.nodes) {
      for (const node of json.nodes) {
        const components = getHubsComponentsExtension(node);

        if (!components) {
          continue;
        }

        const light = components["spot-light"] || components["point-light"];

        if (light && light.range === 0) {
          light.decay = 0;
        }
      }
    }
  }
}

const loadLightmap = async (parser, materialIndex) => {
  const lightmapDef = parser.json.materials[materialIndex].extensions.MOZ_lightmap;
  const [material, lightMap] = await Promise.all([
    parser.getDependency("material", materialIndex),
    parser.getDependency("texture", lightmapDef.index)
  ]);
  material.lightMap = lightMap;
  material.lightMapIntensity = lightmapDef.intensity !== undefined ? lightmapDef.intensity : 1;
  return lightMap;
};

export async function loadGLTF(src, contentType, preferredTechnique, onProgress, jsonPreprocessor) {
  let gltfUrl = src;
  let fileMap;

  if (contentType && (contentType.includes("model/gltf+zip") || contentType.includes("application/x-zip-compressed"))) {
    fileMap = await extractZipFile(gltfUrl);
    gltfUrl = fileMap["scene.gtlf"];
  }

  const loadingManager = new THREE.LoadingManager();
  loadingManager.setURLModifier(getCustomGLTFParserURLResolver(gltfUrl));
  const gltfLoader = new THREE.GLTFLoader(loadingManager);
  gltfLoader.setBasisTextureLoader(new HubsBasisTextureLoader(loadingManager));

  const parser = await new Promise((resolve, reject) => gltfLoader.createParser(gltfUrl, resolve, onProgress, reject));

  parser.textureLoader = new HubsTextureLoader(loadingManager);

  if (jsonPreprocessor) {
    parser.json = jsonPreprocessor(parser.json);
  }

  let version = 0;
  if (
    parser.json.extensions &&
    parser.json.extensions.MOZ_hubs_components &&
    parser.json.extensions.MOZ_hubs_components.hasOwnProperty("version")
  ) {
    version = parser.json.extensions.MOZ_hubs_components.version;
  }
  runMigration(version, parser.json);

  const nodes = parser.json.nodes;
  if (nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (!node.extras) {
        node.extras = {};
      }

      node.extras.gltfIndex = i;
    }
  }

  // Mark the special nodes/meshes in json for efficient parse, all json manipulation should happen before this point
  parser.markDefs();

  const materials = parser.json.materials;
  const extensionDeps = [];
  if (materials) {
    for (let i = 0; i < materials.length; i++) {
      const materialNode = materials[i];

      if (!materialNode.extensions) continue;

      if (
        materialNode.extensions.MOZ_alt_materials &&
        materialNode.extensions.MOZ_alt_materials[preferredTechnique] !== undefined
      ) {
        const altMaterialIndex = materialNode.extensions.MOZ_alt_materials[preferredTechnique];
        materials[i] = materials[altMaterialIndex];
      } else if (materialNode.extensions.MOZ_lightmap) {
        extensionDeps.push(loadLightmap(parser, i));
      }
    }
  }

  // Note this is being done in place of parser.parse() which we now no longer call. This gives us more control over the order of execution.
  const [scenes, animations, cameras] = await Promise.all([
    parser.getDependencies("scene"),
    parser.getDependencies("animation"),
    parser.getDependencies("camera"),
    Promise.all(extensionDeps)
  ]);
  const gltf = {
    scene: scenes[parser.json.scene || 0],
    scenes,
    animations,
    cameras,
    asset: parser.json.asset,
    parser,
    userData: {}
  };

  // this is likely a noop since the whole parser will get GCed
  parser.cache.removeAll();

  gltf.scene.traverse(object => {
    // GLTFLoader sets matrixAutoUpdate on animated objects, we want to keep the defaults
    object.matrixAutoUpdate = THREE.Object3D.DefaultMatrixAutoUpdate;

    if (preferredTechnique === "JEL_materials_toon") {
      object.renderOrder = RENDER_ORDER.TOON;
    }

    object.material = mapMaterials(object, material => {
      let mat = material;

      if (material.isMeshStandardMaterial && preferredTechnique === "KHR_materials_unlit") {
        mat = MobileStandardMaterial.fromStandardMaterial(material);
      }
      if (preferredTechnique === "JEL_materials_toon") {
        if (material.isMeshBasicMaterial) {
          mat = new THREE.MeshToonMaterial({
            alphaMap: material.alphaMap,
            color: material.color,
            map: material.map,
            morphTargets: material.morphTargets,
            refractionRatio: material.refractionRatio,
            skinning: material.skinning,
            wireframe: material.wireframe,
            wireframeLinecap: material.wireframeLinecap,
            wireframeLinejoin: material.wireframeLinejoin,
            wireframeLinewidth: material.wireframeLinewidth
          });
        } else if (material.isMeshStandardMaterial) {
          mat = new THREE.MeshToonMaterial({
            alphaMap: material.alphaMap,
            color: material.color,
            displacementMap: material.displacementMap,
            displacementScale: material.displacementScale,
            displacementBias: material.displacementBias,
            emissive: material.emissive,
            emissiveMap: material.emissiveMap,
            emissiveIntensity: material.emissiveIntensity,
            map: material.map,
            morphNormals: material.morphNormals,
            morphTargets: material.morphTargets,
            refractionRatio: material.refractionRatio,
            skinning: material.skinning,
            wireframe: material.wireframe,
            wireframeLinecap: material.wireframeLinecap,
            wireframeLinejoin: material.wireframeLinejoin,
            wireframeLinewidth: material.wireframeLinewidth
          });
        } else {
          mat = new THREE.MeshToonMaterial({
            color: material.color,
            map: material.map,
            skinning: material.skinning
          });
        }

        mat.gradientMap = toonGradientMap;
        mat.shininess = 0;
        mat.stencilWrite = true;
        mat.stencilFunc = THREE.AlwaysStencilFunc;
        mat.stencilRef = 2;
        mat.stencilZPass = THREE.ReplaceStencilOp;
      }

      if (mat !== material) {
        addVertexCurvingToMaterial(mat);
      }

      return mat;
    });
  });

  if (fileMap) {
    // The GLTF is now cached as a THREE object, we can get rid of the original blobs
    Object.keys(fileMap).forEach(URL.revokeObjectURL);
  }

  gltf.scene.animations = gltf.animations;

  return gltf;
}

export async function loadModel(src, contentType = null, useCache = false, jsonPreprocessor = null, toon = false) {
  let preferredTechnique =
    window.APP && window.APP.materialQuality === "low" ? "KHR_materials_unlit" : "pbrMetallicRoughness";

  if (toon) {
    preferredTechnique = "JEL_materials_toon";
  }

  if (useCache) {
    if (gltfCache.has(src)) {
      gltfCache.retain(src);
      return cloneGltf(gltfCache.get(src).gltf);
    } else {
      if (inflightGltfs.has(src)) {
        const gltf = await inflightGltfs.get(src);
        gltfCache.retain(src);
        return cloneGltf(gltf);
      } else {
        const promise = loadGLTF(src, contentType, preferredTechnique, null, jsonPreprocessor);
        inflightGltfs.set(src, promise);
        const gltf = await promise;
        inflightGltfs.delete(src);
        gltfCache.set(src, gltf);
        return cloneGltf(gltf);
      }
    }
  } else {
    return loadGLTF(src, contentType, preferredTechnique, null, jsonPreprocessor);
  }
}

function resolveAsset(src) {
  // If the src attribute is a selector, get the url from the asset item.
  if (src && src.charAt(0) === "#") {
    const assetEl = document.getElementById(src.substring(1));
    if (assetEl) {
      return assetEl.getAttribute("src");
    }
  }
  return src;
}

/**
 * Loads a GLTF model, optionally recursively "inflates" the child nodes of a model into a-entities and sets
 * allowed components on them if defined in the node's extras.
 * @namespace gltf
 * @component gltf-model-plus
 */
AFRAME.registerComponent("gltf-model-plus", {
  schema: {
    src: { type: "string" },
    contentType: { type: "string" },
    useCache: { default: true },
    inflate: { default: false },
    batch: { default: false },
    toon: { default: false },
    modelToWorldScale: { type: "number", default: 1 }
  },

  init() {
    // This can be set externally if a consumer wants to do some node preprocssing.
    this.jsonPreprocessor = null;

    this.loadTemplates();

    if (hasMediaLayer(this.el)) {
      this.el.sceneEl.systems["hubs-systems"].mediaPresenceSystem.registerMediaComponent(this);
    }
  },

  update(oldData) {
    const { src } = this.data;
    if (!src) return;

    const refresh = oldData.src !== src;

    if (!hasMediaLayer(this.el) || refresh) {
      this.setMediaPresence(MEDIA_PRESENCE.PRESENT, refresh);
    }
  },

  remove() {
    if (this.data.batch && this.model) {
      this.el.sceneEl.systems["hubs-systems"].batchManagerSystem.removeObject(this.el.object3DMap.mesh);
    }
    const src = resolveAsset(this.data.src);
    if (src) {
      gltfCache.release(src);
    }

    this.disposeLastInflatedEl();
    disposeExistingMesh(this.el);

    if (this.el.getObject3D("mesh")) {
      this.el.removeObject3D("mesh");
    }

    if (hasMediaLayer(this.el)) {
      this.el.sceneEl.systems["hubs-systems"].mediaPresenceSystem.unregisterMediaComponent(this);
    }
  },

  setMediaPresence(presence, refresh = false) {
    switch (presence) {
      case MEDIA_PRESENCE.PRESENT:
        return this.setMediaToPresent(refresh);
      case MEDIA_PRESENCE.HIDDEN:
        return this.setMediaToHidden(refresh);
    }
  },

  async setMediaToHidden() {
    const mediaPresenceSystem = this.el.sceneEl.systems["hubs-systems"].mediaPresenceSystem;

    if (this.model && this.el.object3DMap.mesh) {
      this.el.object3DMap.mesh.visible = false;
      this.stopAnimations();
    }

    mediaPresenceSystem.setMediaPresence(this, MEDIA_PRESENCE.HIDDEN);
  },

  async setMediaToPresent() {
    const src = resolveAsset(this.data.src);
    const mediaPresenceSystem = this.el.sceneEl.systems["hubs-systems"].mediaPresenceSystem;

    try {
      if (
        mediaPresenceSystem.getMediaPresence(this) === MEDIA_PRESENCE.HIDDEN &&
        this.model &&
        this.el.object3DMap.mesh &&
        !this.el.object3DMap.mesh.visible
      ) {
        this.el.object3DMap.mesh.visible = true;
        this.startAnimations();
        return;
      }

      mediaPresenceSystem.setMediaPresence(this, MEDIA_PRESENCE.PENDING);

      const contentType = this.data.contentType;
      if (src === this.lastSrc) return;

      const lastSrc = this.lastSrc;
      this.lastSrc = src;

      if (!src) {
        if (this.inflatedEl) {
          console.warn("gltf-model-plus set to an empty source, unloading inflated model.");
          this.disposeLastInflatedEl();
          disposeExistingMesh(this.el);
        }
        return;
      }

      this.el.emit("model-loading");
      const gltf = await loadModel(src, contentType, this.data.useCache, this.jsonPreprocessor, this.data.toon);

      // If we started loading something else already or delete this element
      // TODO: there should be a way to cancel loading instead
      if (src != this.lastSrc || !this.el.parentNode) return;

      // If we had inflated something already before, clean that up
      this.disposeLastInflatedEl();
      disposeExistingMesh(this.el);

      this.model = gltf.scene || gltf.scenes[0];

      if (this.data.batch) {
        this.el.sceneEl.systems["hubs-systems"].batchManagerSystem.addObject(this.model);
      }

      if (gltf.animations.length > 0) {
        // Skip BVH if animated to ensure raycaster is accurate - most likely larger models
        // won't be animated.
        this.startAnimations();
      } else {
        await new Promise(res =>
          setTimeout(() => {
            generateMeshBVH(this.model);
            res();
          })
        );
      }

      const indexToEntityMap = {};

      let object3DToSet = this.model;
      if (
        this.data.inflate &&
        (this.inflatedEl = inflateEntities(
          indexToEntityMap,
          this.model,
          this.templates,
          true,
          this.data.modelToWorldScale
        ))
      ) {
        this.el.appendChild(this.inflatedEl);

        object3DToSet = this.inflatedEl.object3D;
        object3DToSet.visible = false;

        // TODO: Still don't fully understand the lifecycle here and how it differs between browsers, we should dig in more
        // Wait one tick for the appended custom elements to be connected before attaching templates
        await nextTick();
        if (src != this.lastSrc) return; // TODO: there must be a nicer pattern for this

        if (this.inflatedEl) {
          await inflateComponents(this.inflatedEl, indexToEntityMap);
        }

        for (const name in this.templates) {
          attachTemplate(this.el, name, this.templates[name]);
        }
      }

      // The call to setObject3D below recursively clobbers any `el` backreferences to entities
      // in the entire inflated entity graph to point to `object3DToSet`.
      //
      // We don't want those overwritten, since lots of code assumes `object3d.el` points to the relevant
      // A-Frame entity for that three.js object, so we back them up and re-wire them here. If we didn't do
      // this, all the `el` properties on these object3ds would point to the `object3DToSet` which is either
      // the model or the root GLTF inflated entity.
      const rewires = [];

      object3DToSet.traverse(o => {
        const el = o.el;
        if (el) rewires.push(() => (o.el = el));
      });

      const environmentMapComponent = this.el.sceneEl.components["environment-map"];

      if (environmentMapComponent) {
        environmentMapComponent.applyEnvironmentMap(object3DToSet);
      }

      if (lastSrc) {
        gltfCache.release(lastSrc);
      }
      this.el.setObject3D("mesh", object3DToSet);

      rewires.forEach(f => f());

      object3DToSet.matrixNeedsUpdate = true;
      object3DToSet.visible = true;
      object3DToSet.traverse(o => (o.castShadow = true));
      this.el.emit("model-loaded", { format: "gltf", model: this.model });
    } catch (e) {
      gltfCache.release(src);
      console.error("Failed to load glTF model", e, this);
      this.el.emit("model-error", { format: "gltf", src });
    } finally {
      mediaPresenceSystem.setMediaPresence(this, MEDIA_PRESENCE.PRESENT);
    }
  },

  startAnimations() {
    const mixerComponent = this.el.components["animation-mixer"];
    if (mixerComponent) {
      mixerComponent.play();
    } else {
      this.el.setAttribute("animation-mixer", {});

      if (this.model.animations) {
        this.el.components["animation-mixer"].initMixer(this.model.animations);
      }
    }
  },

  stopAnimations() {
    const mixerComponent = this.el.components["animation-mixer"];

    if (mixerComponent) {
      mixerComponent.pause();
    }
  },

  loadTemplates() {
    this.templates = {};
    this.el.querySelectorAll(":scope > template").forEach(templateEl => {
      const root = document.importNode(templateEl.firstElementChild || templateEl.content.firstElementChild, true);
      this.templates[templateEl.getAttribute("data-name")] = root;
    });
  },

  disposeLastInflatedEl() {
    this.el.removeAttribute("animation-mixer");

    if (this.inflatedEl) {
      if (this.inflatedEl.parentNode) {
        this.inflatedEl.parentNode.removeChild(this.inflatedEl);
      }

      delete this.inflatedEl;
    }
  },

  handleMediaInteraction(type) {
    if (type === MEDIA_INTERACTION_TYPES.OPEN) {
      window.open(this.data.src);
    }

    if (type === MEDIA_INTERACTION_TYPES.RESET) {
      resetMediaRotation(this.el);
    }
  }
});
