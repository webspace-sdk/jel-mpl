const bindAllEvents = function(elements, events, f) {
  if (!elements || !elements.length) return;
  for (const el of elements) {
    events.length &&
      events.forEach(e => {
        el.addEventListener(e, f);
      });
  }
};
const unbindAllEvents = function(elements, events, f) {
  if (!elements || !elements.length) return;
  for (const el of elements) {
    events.length &&
      events.forEach(e => {
        el.removeEventListener(e, f);
      });
  }
};

/**
 * Toggles the microphone on the current network connection based on the given events.
 * @namespace network
 * @component mute-mic
 */
AFRAME.registerComponent("mute-mic", {
  schema: {
    eventSrc: { type: "selectorAll" },
    toggleEvents: { type: "array" },
    muteEvents: { type: "array" },
    unmuteEvents: { type: "array" }
  },
  init: function() {
    this.onToggle = this.onToggle.bind(this);
    this.onMute = this.onMute.bind(this);
    this.onUnmute = this.onUnmute.bind(this);
  },

  play: function() {
    const { eventSrc, toggleEvents, muteEvents, unmuteEvents } = this.data;
    bindAllEvents(eventSrc, toggleEvents, this.onToggle);
    bindAllEvents(eventSrc, muteEvents, this.onMute);
    bindAllEvents(eventSrc, unmuteEvents, this.onUnmute);
  },

  pause: function() {
    const { eventSrc, toggleEvents, muteEvents, unmuteEvents } = this.data;
    unbindAllEvents(eventSrc, toggleEvents, this.onToggle);
    unbindAllEvents(eventSrc, muteEvents, this.onMute);
    unbindAllEvents(eventSrc, unmuteEvents, this.onUnmute);
  },

  onToggle: async function() {
    if (!NAF.connection.adapter) return;
    if (!this.el.sceneEl.is("entered")) return;

    if (!this.el.is("unmuted")) {
      if (!this._beganAudioStream) {
        this._beganAudioStream = true;
        await SYSTEMS.mediaStreamSystem.beginStreamingPreferredMic();
      }
      await NAF.connection.adapter.enableMicrophone(true);
      SYSTEMS.audioSystem.enableOutboundAudioStream("microphone");
      this.el.addState("unmuted");
      window.APP.store.handleActivityFlag("unmute");
      window.APP.spaceChannel.updateUnmuted(true);
    } else {
      if (this._beganAudioStream) {
        this._beganAudioStream = false;
        await SYSTEMS.mediaStreamSystem.stopMicrophoneTrack();
      }
      await NAF.connection.adapter.enableMicrophone(false);
      SYSTEMS.audioSystem.disableOutboundAudioStream("microphone");
      this.el.removeState("unmuted");
      window.APP.spaceChannel.updateUnmuted(false);
    }
  },

  onMute: async function() {
    if (!NAF.connection.adapter) return;
    if (this.el.is("unmuted")) {
      await NAF.connection.adapter.enableMicrophone(false);
      this.el.removeState("unmuted");
      window.APP.spaceChannel.updateUnmuted(false);
    }
  },

  onUnmute: async function() {
    if (!this.el.is("unmuted")) {
      await NAF.connection.adapter.enableMicrophone(true);
      this.el.addState("unmuted");
      window.APP.spaceChannel.updateUnmuted(true);
    }
  }
});
