import { MeshBVH } from "three-mesh-bvh";
import nextTick from "./next-tick";
import { upload } from "./media-utils";
import { dataURItoBlob } from "../../jel/utils/dom-utils";

const tempVector3 = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();

export function getLastWorldPosition(src, target) {
  src.updateMatrices();
  target.setFromMatrixPosition(src.matrixWorld);
  return target;
}

export function getLastWorldQuaternion(src, target) {
  src.updateMatrices();
  src.matrixWorld.decompose(tempVector3, target, tempVector3);
  return target;
}

export function getLastWorldScale(src, target) {
  src.updateMatrices();
  src.matrixWorld.decompose(tempVector3, tempQuaternion, target);
  return target;
}

export function disposeTextureImage(texture) {
  if (!texture.image) return;

  // Unload the video element to prevent it from continuing to play in the background
  if (texture.image instanceof HTMLVideoElement) {
    const video = texture.image;
    video.pause();
    video.src = "";
    video.load();
  }

  texture.image.close && texture.image.close();
  delete texture.image;
}

export function disposeTexture(texture) {
  if (!texture) return;

  disposeTextureImage(texture);

  if (texture.hls) {
    texture.hls.stopLoad();
    texture.hls.detachMedia();
    texture.hls.destroy();
    texture.hls = null;
  }

  if (texture.dash) {
    texture.dash.reset();
  }

  texture.dispose();
}

export function disposeMaterial(mtrl) {
  if (mtrl.map) disposeTexture(mtrl.map);
  if (mtrl.lightMap) disposeTexture(mtrl.lightMap);
  if (mtrl.bumpMap) disposeTexture(mtrl.bumpMap);
  if (mtrl.normalMap) disposeTexture(mtrl.normalMap);
  if (mtrl.specularMap) disposeTexture(mtrl.specularMap);
  if (mtrl.envMap) disposeTexture(mtrl.envMap);
  mtrl.dispose();
}

export function disposeNode(node, dereference = true) {
  if (node.geometry) {
    node.geometry.dispose();
    node.geometry.boundsTree = null;
  }

  if (node.material) {
    let materialArray;
    if (node.material instanceof THREE.MeshFaceMaterial || node.material instanceof THREE.MultiMaterial) {
      materialArray = node.material.materials;
    } else if (node.material instanceof Array) {
      materialArray = node.material;
    }
    if (materialArray) {
      materialArray.forEach(disposeMaterial);
    } else {
      disposeMaterial(node.material);
    }
  }

  if (dereference) {
    // Dereference a-frame elements, since stale render list entries may still point to this object.
    node.el = null;
  }
}

export function disposeNodeContents(node) {
  disposeNode(node, false);
}

export function disposeExistingMesh(el) {
  const mesh = el.getObject3D("mesh");
  if (!mesh) return;
  disposeNode(mesh);
  el.removeObject3D("mesh");
}

export const IDENTITY = new THREE.Matrix4().identity();
export const IDENTITY_QUATERNION = new THREE.Quaternion();
export const ONES = new THREE.Vector3(1, 1, 1);

export function setMatrixWorld(object3D, m) {
  // Check for equality to avoid invaliding children matrices
  if (object3D.matrixWorld.equals(m)) return;

  if (!object3D.matrixIsModified) {
    object3D.applyMatrix(IDENTITY); // hack around our matrix optimizations
  }
  object3D.matrixWorld.copy(m);

  // Deal with parent transform unless it is the scene
  if (object3D.parent && object3D.parent.parent !== null) {
    object3D.parent.updateMatrices();
    object3D.matrix = object3D.matrix.getInverse(object3D.parent.matrixWorld).multiply(object3D.matrixWorld);
  } else {
    object3D.matrix.copy(object3D.matrixWorld);
  }
  object3D.matrix.decompose(object3D.position, object3D.quaternion, object3D.scale);
  object3D.childrenNeedMatrixWorldUpdate = true;
  object3D.worldMatrixConsumerFlags = 0x00;
}

// Modified version of Don McCurdy's AnimationUtils.clone
// https://github.com/mrdoob/three.js/pull/14494

function parallelTraverse(a, b, callback) {
  callback(a, b);

  for (let i = 0; i < a.children.length; i++) {
    parallelTraverse(a.children[i], b.children[i], callback);
  }
}

// Supports the following PropertyBinding path formats:
// uuid.propertyName
// uuid.propertyName[propertyIndex]
// uuid.objectName[objectIndex].propertyName[propertyIndex]
// Does not support property bindings that use object3D names or parent nodes
function cloneKeyframeTrack(sourceKeyframeTrack, cloneUUIDLookup) {
  const { nodeName: uuid, objectName, objectIndex, propertyName, propertyIndex } = THREE.PropertyBinding.parseTrackName(
    sourceKeyframeTrack.name
  );

  let path = "";

  if (uuid !== undefined) {
    const clonedUUID = cloneUUIDLookup.get(uuid);

    if (clonedUUID === undefined) {
      console.warn(`Could not find KeyframeTrack target with uuid: "${uuid}"`);
    }

    path += clonedUUID;
  }

  if (objectName !== undefined) {
    path += "." + objectName;
  }

  if (objectIndex !== undefined) {
    path += "[" + objectIndex + "]";
  }

  if (propertyName !== undefined) {
    path += "." + propertyName;
  }

  if (propertyIndex !== undefined) {
    path += "[" + propertyIndex + "]";
  }

  const clonedKeyframeTrack = sourceKeyframeTrack.clone();
  clonedKeyframeTrack.name = path;

  return clonedKeyframeTrack;
}

function cloneAnimationClip(sourceAnimationClip, cloneUUIDLookup) {
  const clonedTracks = sourceAnimationClip.tracks.map(keyframeTrack =>
    cloneKeyframeTrack(keyframeTrack, cloneUUIDLookup)
  );
  return new THREE.AnimationClip(sourceAnimationClip.name, sourceAnimationClip.duration, clonedTracks);
}

export async function cloneObject3D(source, preserveUUIDs) {
  const cloneLookup = new Map();
  const cloneUUIDLookup = new Map();

  const clone = source.clone();

  parallelTraverse(source, clone, (sourceNode, clonedNode) => {
    cloneLookup.set(sourceNode, clonedNode);
  });

  source.traverse(sourceNode => {
    const clonedNode = cloneLookup.get(sourceNode);

    if (preserveUUIDs) {
      clonedNode.uuid = sourceNode.uuid;
    }

    cloneUUIDLookup.set(sourceNode.uuid, clonedNode.uuid);
  });

  const clonePromises = [];

  source.traverse(sourceNode => {
    const clonedNode = cloneLookup.get(sourceNode);

    if (!clonedNode) {
      return;
    }

    // Clone animation and skeleton in microtasks
    if (sourceNode.animations) {
      clonePromises.push(
        new Promise(res => {
          setTimeout(() => {
            clonedNode.animations = sourceNode.animations.map(animationClip =>
              cloneAnimationClip(animationClip, cloneUUIDLookup)
            );

            res();
          });
        })
      );
    }

    if (sourceNode.isMesh && sourceNode.geometry.boundsTree) {
      clonedNode.geometry.boundsTree = sourceNode.geometry.boundsTree;
    }

    if (!sourceNode.isSkinnedMesh) return;

    clonePromises.push(
      new Promise(res => {
        setTimeout(() => {
          const sourceBones = sourceNode.skeleton.bones;

          clonedNode.skeleton = sourceNode.skeleton.clone();

          clonedNode.skeleton.bones = sourceBones.map(sourceBone => {
            if (!cloneLookup.has(sourceBone)) {
              throw new Error("Required bones are not descendants of the given object.");
            }

            return cloneLookup.get(sourceBone);
          });

          clonedNode.bind(clonedNode.skeleton, sourceNode.bindMatrix);
          res();
        });
      })
    );
  });

  await Promise.all(clonePromises);

  // First level of cloned children will have parents pointing to scene,
  // which can mis-root objects.
  for (let i = 0; i < clone.children.length; i++) {
    clone.children[i].parent = clone;
  }

  return clone;
}

export function findNode(root, pred) {
  let nodes = [root];
  while (nodes.length) {
    const node = nodes.shift();
    if (pred(node)) return node;
    if (node.children) nodes = nodes.concat(node.children);
  }
  return null;
}

export const interpolateAffine = (function() {
  const mat4 = new THREE.Matrix4();
  const end = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3()
  };
  const start = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3()
  };
  const interpolated = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3()
  };
  return function(startMat4, endMat4, progress, outMat4) {
    start.quaternion.setFromRotationMatrix(mat4.extractRotation(startMat4));
    end.quaternion.setFromRotationMatrix(mat4.extractRotation(endMat4));
    THREE.Quaternion.slerp(start.quaternion, end.quaternion, interpolated.quaternion, progress);
    interpolated.position.lerpVectors(
      start.position.setFromMatrixColumn(startMat4, 3),
      end.position.setFromMatrixColumn(endMat4, 3),
      progress
    );
    interpolated.scale.lerpVectors(
      start.scale.setFromMatrixScale(startMat4),
      end.scale.setFromMatrixScale(endMat4),
      progress
    );
    return outMat4.compose(
      interpolated.position,
      interpolated.quaternion,
      interpolated.scale
    );
  };
})();

export const squareDistanceBetween = (function() {
  const posA = new THREE.Vector3();
  const posB = new THREE.Vector3();
  return function(objA, objB) {
    objA.updateMatrices();
    objB.updateMatrices();
    posA.setFromMatrixColumn(objA.matrixWorld, 3);
    posB.setFromMatrixColumn(objB.matrixWorld, 3);
    return posA.distanceToSquared(posB);
  };
})();

export function isAlmostUniformVector3(v, epsilonHalf = 0.005) {
  return Math.abs(v.x - v.y) < epsilonHalf && Math.abs(v.x - v.z) < epsilonHalf;
}
export function almostEqual(a, b, epsilon = 0.01) {
  return Math.abs(a - b) < epsilon;
}
export function almostEqualVec3(a, b, epsilon = 0.01) {
  return almostEqual(a.x, b.x, epsilon) && almostEqual(a.y, b.y, epsilon) && almostEqual(a.z, b.z, epsilon);
}
export function almostEqualQuaternion(a, b) {
  return Math.abs(a.dot(b) - 1.0) < 0.000001;
}

export const affixToWorldUp = (function() {
  const inRotationMat4 = new THREE.Matrix4();
  const inForward = new THREE.Vector3();
  const outForward = new THREE.Vector3();
  const outSide = new THREE.Vector3();
  const worldUp = new THREE.Vector3(); // Could be called "outUp"
  const v = new THREE.Vector3();
  const inMat4Copy = new THREE.Matrix4();
  return function affixToWorldUp(inMat4, outMat4) {
    inRotationMat4.identity().extractRotation(inMat4Copy.copy(inMat4));
    inForward.setFromMatrixColumn(inRotationMat4, 2).multiplyScalar(-1);
    outForward
      .copy(inForward)
      .sub(v.copy(inForward).projectOnVector(worldUp.set(0, 1, 0)))
      .normalize();
    outSide.crossVectors(outForward, worldUp);
    outMat4.makeBasis(outSide, worldUp, outForward.multiplyScalar(-1));
    outMat4.scale(v.setFromMatrixScale(inMat4Copy));
    outMat4.setPosition(v.setFromMatrixColumn(inMat4Copy, 3));
    return outMat4;
  };
})();

export const calculateViewingDistance = (function() {
  return function calculateViewingDistance(fov, aspect, object, box, center, vrMode) {
    const halfYExtents = Math.max(Math.abs(box.max.y - center.y), Math.abs(center.y - box.min.y));
    const halfXExtents = Math.max(Math.abs(box.max.x - center.x), Math.abs(center.x - box.min.x));
    const halfVertFOV = THREE.Math.degToRad(fov / 2);
    const halfHorFOV = Math.atan(Math.tan(halfVertFOV) * aspect) * (vrMode ? 0.5 : 1);
    const margin = 1.05;
    const length1 = Math.abs((halfYExtents * margin) / Math.tan(halfVertFOV));
    const length2 = Math.abs((halfXExtents * margin) / Math.tan(halfHorFOV));
    const length3 = Math.abs(box.max.z - center.z) + Math.max(length1, length2);
    const length = vrMode ? Math.max(0.25, length3) : length3;
    return length || 1.25;
  };
})();

export const rotateInPlaceAroundWorldUp = (function() {
  const inMat4Copy = new THREE.Matrix4();
  const startRotation = new THREE.Matrix4();
  const endRotation = new THREE.Matrix4();
  const v = new THREE.Vector3();
  return function rotateInPlaceAroundWorldUp(inMat4, theta, outMat4) {
    if (theta !== 0) {
      inMat4Copy.copy(inMat4);
      return outMat4
        .copy(endRotation.makeRotationY(theta).multiply(startRotation.extractRotation(inMat4Copy)))
        .scale(v.setFromMatrixScale(inMat4Copy))
        .setPosition(v.setFromMatrixPosition(inMat4Copy));
    } else {
      outMat4.copy(inMat4);
    }
  };
})();

export const childMatch = (function() {
  const inverseParentWorld = new THREE.Matrix4();
  const childRelativeToParent = new THREE.Matrix4();
  const childInverse = new THREE.Matrix4();
  const newParentMatrix = new THREE.Matrix4();
  // transform the parent such that its child matches the target
  return function childMatch(parent, child, target) {
    parent.updateMatrices();
    inverseParentWorld.getInverse(parent.matrixWorld);
    child.updateMatrices();
    childRelativeToParent.multiplyMatrices(inverseParentWorld, child.matrixWorld);
    childInverse.getInverse(childRelativeToParent);
    newParentMatrix.multiplyMatrices(target, childInverse);
    setMatrixWorld(parent, newParentMatrix);
  };
})();

export function isChildOf(obj, parent) {
  let node = obj.parent;

  do {
    if (node === parent) return true;
    node = node.parent;
  } while (node !== null);

  return false;
}

export function generateMeshBVH(object3D, force = true) {
  object3D.traverse(obj => {
    // note that we might already have a bounds tree if this was a clone of an object with one
    const hasBufferGeometry = obj.isMesh && obj.geometry.isBufferGeometry;
    const hasBoundsTree = hasBufferGeometry && obj.geometry.boundsTree;
    if (hasBufferGeometry && (!hasBoundsTree || force) && obj.geometry.attributes.position) {
      const geo = obj.geometry;
      const triCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      if (triCount === 0) {
        geo.boundsTree = null;
      } else {
        // only bother using memory and time making a BVH if there are a reasonable number of tris,
        // and if there are too many it's too painful and large to tolerate doing it (at least until we put this in a web worker)
        if (force || (triCount > 1000 && triCount < 1000000)) {
          // note that bounds tree construction creates an index as a side effect if one doesn't already exist
          geo.boundsTree = new MeshBVH(obj.geometry, { strategy: 0, maxDepth: 30 });
        }
      }
    }
  });
}

const _box = new THREE.Box3();

const expandByObjectSpaceBoundingBox = (bbox, object, mat = null) => {
  const geometry = object.geometry;

  object.updateMatrices();

  const newMat = new THREE.Matrix4();

  if (mat === null) {
    newMat.identity();
  } else {
    newMat.multiplyMatrices(mat, object.matrix);
  }

  if (geometry !== undefined && object.userData.excludeFromBoundingBox !== true) {
    if (geometry.boundingBox === null) {
      geometry.computeBoundingBox();
    }

    _box.copy(geometry.boundingBox);
    _box.applyMatrix4(newMat);

    bbox.expandByPoint(_box.min);
    bbox.expandByPoint(_box.max);
  }

  const children = object.children;

  for (let i = 0, l = children.length; i < l; i++) {
    expandByObjectSpaceBoundingBox(bbox, children[i], newMat);
  }
};

export function expandByEntityObjectSpaceBoundingBox(bbox, el) {
  const mesh = el.getObject3D("mesh");
  if (!mesh) return bbox;

  const voxBox = SYSTEMS.voxSystem.getBoundingBoxForSource(mesh, false);

  if (voxBox) {
    bbox.copy(voxBox);
    return bbox;
  }

  const object = el.object3D;
  object.updateMatrices();
  expandByObjectSpaceBoundingBox(bbox, object);
  return bbox;
}

export function getSpawnInFrontZOffsetForEntity(sourceEntity) {
  const sourceScale = sourceEntity.object3D.scale;

  const box = new THREE.Box3();
  const size = new THREE.Vector3();

  expandByEntityObjectSpaceBoundingBox(box, sourceEntity);
  box.getSize(size);

  const scaledSize = sourceScale.z * Math.min(size.x, size.y, size.z);
  return Math.min(-1, -2.15 * scaledSize);
}

export function screenshotSceneCanvas(scene, width, height) {
  return new Promise(res => {
    const { externalCameraSystem } = SYSTEMS;

    if (SYSTEMS.externalCameraSystem.isEnabled()) {
      console.error("cannot take scene screenshot when external camera already enabled");
      return;
    }

    scene.addEventListener(
      "external_camera_added",
      async () => {
        for (let i = 0; i < 10; i++) {
          await nextTick();
        }
        const canvas = externalCameraSystem.canvas;
        const data = canvas.toDataURL();
        externalCameraSystem.removeExternalCamera();
        externalCameraSystem.releaseForcedViewingCamera();
        res(data);
      },
      { once: true }
    );

    externalCameraSystem.enableForcedViewingCamera();
    externalCameraSystem.addExternalCamera(width, height, true, { preserveDrawingBuffer: true });
  });
}

export async function screenshotAndUploadSceneCanvas(scene, width, height) {
  const { hubChannel } = window.APP;

  const data = await screenshotSceneCanvas(scene, width, height);
  const blob = dataURItoBlob(data);
  return await upload(blob, "image/png", hubChannel.hubId);
}
