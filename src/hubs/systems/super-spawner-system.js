import { addMedia } from "../utils/media-utils";
import { ObjectContentOrigins } from "../object-types";

const isPermitted = superSpawner =>
  window.APP.hubChannel &&
  (superSpawner && superSpawner.data.template === "#interactable-emoji"
    ? window.APP.hubChannel.can("spawn_emoji")
    : window.APP.hubChannel.can("spawn_and_move_media"));

// WARNING: This system mutates interaction system state!
export class SuperSpawnerSystem {
  maybeSpawn(state, grabPath) {
    const userinput = AFRAME.scenes[0].systems.userinput;
    const superSpawner = state.hovered && state.hovered.components["super-spawner"];

    if (
      superSpawner &&
      superSpawner.spawnedMediaScale &&
      !superSpawner.cooldownTimeout &&
      userinput.get(grabPath) &&
      isPermitted(superSpawner)
    ) {
      this.performSpawn(state, grabPath, userinput, superSpawner);
    }
  }

  performSpawn(state, grabPath, userinput, superSpawner) {
    const data = superSpawner.data;

    const { entity: spawnedEntity } = addMedia(
      data.src,
      null,
      data.template,
      ObjectContentOrigins.SPAWNER,
      null,
      data.resolve,
      true,
      false,
      data.mediaOptions
    ).entity;

    superSpawner.el.object3D.getWorldPosition(spawnedEntity.object3D.position);
    superSpawner.el.object3D.getWorldQuaternion(spawnedEntity.object3D.quaternion);
    spawnedEntity.object3D.matrixNeedsUpdate = true;

    superSpawner.el.emit("spawned-entity-created", { target: spawnedEntity });

    state.held = spawnedEntity;

    superSpawner.activateCooldown();
    state.spawning = true;

    spawnedEntity.addEventListener(
      "media-loaded",
      () => {
        spawnedEntity.object3D.scale.copy(superSpawner.spawnedMediaScale);
        spawnedEntity.object3D.matrixNeedsUpdate = true;
        state.spawning = false;
        superSpawner.el.emit("spawned-entity-loaded", { target: spawnedEntity });
      },
      { once: true }
    );
  }

  tick() {
    const interaction = AFRAME.scenes[0].systems.interaction;
    if (!interaction.ready) return; //DOMContentReady workaround
    this.maybeSpawn(interaction.state.leftHand, interaction.options.leftHand.grabPath);
    this.maybeSpawn(interaction.state.rightHand, interaction.options.rightHand.grabPath);
    this.maybeSpawn(interaction.state.rightRemote, interaction.options.rightRemote.grabPath);
    this.maybeSpawn(interaction.state.leftRemote, interaction.options.leftRemote.grabPath);
  }
}
