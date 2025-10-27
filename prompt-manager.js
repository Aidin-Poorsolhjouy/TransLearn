// in prompt-manager.js

class PromptSessionManager {
  constructor() {
    // This will hold the PROMISE for the session, not the session itself.
    this.sessionPromise = null;
  }

  /**
   * Gets the active session. Handles initialization, race conditions, and cancellation.
   * @param {AbortSignal} signal The signal for the NEW operation.
   */
  getSession(signal) {
    // If a session promise doesn't exist, or if the signal it was created with
    // has been aborted, we need to create a new one.
    if (!this.sessionPromise || (this.sessionPromise.signal && this.sessionPromise.signal.aborted)) {
      console.log("PromptManager: Creating new session promise.");
      this.sessionPromise = this._initializeSession(signal);
      // Attach the signal to the promise itself for later checks.
      this.sessionPromise.signal = signal;
    }
    return this.sessionPromise;
  }

  /**
   * Private helper to create the session. This is only called when a new session is needed.
   * @param {AbortSignal} signal The signal for this specific session.
   */
  async _initializeSession(signal) {
    console.log("PromptManager: Initializing new session...");
    try {
      if (!('LanguageModel' in self)) throw new Error("Prompt API not available.");
      
      // Check if the new signal is already aborted before we even start.
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const availability = await LanguageModel.availability();
      const state = availability?.state || 'downloadable';
      if (state === 'unavailable') throw new Error("Gemini Nano is unavailable.");

      const session = await LanguageModel.create({ signal });
      console.log("PromptManager: New session is ready.");
      return session;
    } catch (error) {
      // If initialization fails, nullify the promise so the next call can try again.
      this.sessionPromise = null;
      console.error("Failed to initialize PromptSessionManager:", error.message);
      throw error; // Re-throw to be caught by the caller
    }
  }
}

const promptManager = new PromptSessionManager();