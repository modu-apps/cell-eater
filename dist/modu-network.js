"use strict";
var moduNetwork = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/modu-network.ts
  var modu_network_exports = {};
  __export(modu_network_exports, {
    connect: () => connect,
    decodeBinaryMessage: () => decodeBinaryMessage,
    encodeSyncHash: () => encodeSyncHash,
    getRandomRoom: () => getRandomRoom,
    hashClientId: () => hashClientId,
    listRooms: () => listRooms,
    modd: () => modd,
    registerClientId: () => registerClientId,
    unregisterClientId: () => unregisterClientId
  });

  // src/auth.ts
  var TOKEN_KEY = "modd_auth_token";
  var RETURN_URL_KEY = "modd_auth_return_url";
  var AuthModule = class {
    constructor() {
      this.appId = null;
      this.centralServiceUrl = "https://nodes.modd.io";
      this.debug = false;
      this.initialized = false;
      this.successCallbacks = [];
      this.errorCallbacks = [];
      this.stateChangeCallbacks = [];
      this.currentUser = null;
      this.pendingAuthCode = null;
      this.pendingAuthError = null;
    }
    /**
     * Initialize the auth module
     */
    init(options) {
      this.appId = options.appId;
      this.debug = options.debug || false;
      if (options.centralServiceUrl) {
        this.centralServiceUrl = options.centralServiceUrl;
      } else if (typeof window !== "undefined") {
        const hostname = window.location.hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          this.centralServiceUrl = "http://localhost:9001";
        }
      }
      this.initialized = true;
      this.log("Auth module initialized", { appId: this.appId, centralServiceUrl: this.centralServiceUrl });
      this.handleAuthCallback();
      this.checkExistingSession();
    }
    /**
     * Start the login flow
     */
    login(options) {
      this.ensureInitialized();
      const provider = options?.provider;
      const returnUrl = typeof window !== "undefined" ? window.location.href : "/";
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(RETURN_URL_KEY, returnUrl);
      }
      const params = new URLSearchParams({
        appId: this.appId,
        returnUrl
      });
      let authUrl;
      if (provider) {
        authUrl = `${this.centralServiceUrl}/auth/${provider}?${params}`;
      } else {
        authUrl = `${this.centralServiceUrl}/auth/select?${params}`;
      }
      this.log("Starting login flow", { provider, authUrl });
      if (typeof window !== "undefined") {
        window.location.href = authUrl;
      }
    }
    /**
     * Logout the current user
     */
    async logout() {
      this.ensureInitialized();
      const token = this.getStoredToken();
      if (token) {
        try {
          await fetch(`${this.centralServiceUrl}/auth/logout`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`
            }
          });
        } catch (err) {
          this.log("Logout API call failed (continuing anyway)", err);
        }
      }
      this.clearStoredToken();
      this.currentUser = null;
      this.notifyStateChange(null);
      this.log("User logged out");
    }
    /**
     * Get the current user
     */
    async getUser() {
      this.ensureInitialized();
      if (this.currentUser) {
        return this.currentUser;
      }
      const token = this.getStoredToken();
      if (!token) {
        return null;
      }
      try {
        const response = await fetch(`${this.centralServiceUrl}/auth/whoami`, {
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });
        if (!response.ok) {
          this.clearStoredToken();
          return null;
        }
        const data = await response.json();
        this.currentUser = data.user;
        return this.currentUser;
      } catch (err) {
        this.log("Failed to get user", err);
        return null;
      }
    }
    /**
     * Delete the user's account
     */
    async deleteAccount() {
      this.ensureInitialized();
      const token = this.getStoredToken();
      if (!token) {
        throw new Error("Not logged in");
      }
      const response = await fetch(`${this.centralServiceUrl}/auth/account`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to delete account" }));
        throw new Error(error.error);
      }
      this.clearStoredToken();
      this.currentUser = null;
      this.notifyStateChange(null);
      this.log("Account deleted");
    }
    /**
     * Register callback for successful auth
     */
    onSuccess(callback) {
      this.successCallbacks.push(callback);
      if (this.pendingAuthCode) {
        const code = this.pendingAuthCode;
        this.pendingAuthCode = null;
        callback(code);
      }
      return () => {
        const idx = this.successCallbacks.indexOf(callback);
        if (idx !== -1) this.successCallbacks.splice(idx, 1);
      };
    }
    /**
     * Register callback for auth errors
     */
    onError(callback) {
      this.errorCallbacks.push(callback);
      if (this.pendingAuthError) {
        const error = this.pendingAuthError;
        this.pendingAuthError = null;
        callback(error);
      }
      return () => {
        const idx = this.errorCallbacks.indexOf(callback);
        if (idx !== -1) this.errorCallbacks.splice(idx, 1);
      };
    }
    /**
     * Register callback for auth state changes
     */
    onAuthStateChange(callback) {
      this.stateChangeCallbacks.push(callback);
      callback(this.currentUser);
      return () => {
        const idx = this.stateChangeCallbacks.indexOf(callback);
        if (idx !== -1) this.stateChangeCallbacks.splice(idx, 1);
      };
    }
    /**
     * Get the stored session token (for backend calls)
     */
    getToken() {
      return this.getStoredToken();
    }
    /**
     * Set a session token (received from backend after code exchange)
     */
    setToken(token) {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(TOKEN_KEY, token);
      }
      this.checkExistingSession();
    }
    // Private methods
    ensureInitialized() {
      if (!this.initialized || !this.appId) {
        throw new Error("Auth module not initialized. Call moddNetwork.auth.init() first.");
      }
    }
    async handleAuthCallback() {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        this.log("Auth error received", { error, errorDescription });
        url.searchParams.delete("error");
        url.searchParams.delete("error_description");
        window.history.replaceState({}, "", url.toString());
        this.pendingAuthError = {
          code: error,
          message: errorDescription || error
        };
        this.errorCallbacks.forEach((cb) => cb(this.pendingAuthError));
        return;
      }
      if (code) {
        this.log("Auth code received", { code: code.substring(0, 20) + "..." });
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.toString());
        try {
          const response = await fetch(`${this.centralServiceUrl}/auth/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
          });
          if (response.ok) {
            const { token } = await response.json();
            if (token) {
              if (typeof localStorage !== "undefined") {
                localStorage.setItem(TOKEN_KEY, token);
              }
              this.log("Session token stored");
            }
          } else {
            this.log("Failed to exchange auth code for session token");
          }
        } catch (err) {
          this.log("Error exchanging auth code:", err);
        }
        this.pendingAuthCode = code;
        this.successCallbacks.forEach((cb) => cb(code));
      }
    }
    async checkExistingSession() {
      const user = await this.getUser();
      if (user) {
        this.notifyStateChange(user);
      } else {
        const hadToken = this.getStoredToken() === null && this.currentUser !== null;
        if (hadToken) {
          this.notifyStateChange(null);
        }
      }
    }
    notifyStateChange(user) {
      this.currentUser = user;
      this.stateChangeCallbacks.forEach((cb) => cb(user));
    }
    getStoredToken() {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(TOKEN_KEY);
    }
    clearStoredToken() {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(RETURN_URL_KEY);
      }
    }
    log(...args) {
      if (this.debug) {
        console.log("[modd-auth]", ...args);
      }
    }
  };
  var auth = new AuthModule();
  if (typeof window !== "undefined") {
    window.moddAuth = auth;
  }

  // src/modu-network.ts
  var BinaryMessageType = {
    TICK: 1,
    INITIAL_STATE: 2,
    ROOM_JOINED: 3,
    ROOM_CREATED: 4,
    ERROR: 5,
    SNAPSHOT_UPDATE: 6,
    ROOM_LEFT: 7,
    SYNC_HASH: 8,
    CLIENT_LIST_UPDATE: 9,
    // Client-to-server markers (also used for server broadcast)
    BINARY_INPUT: 32,
    BINARY_SNAPSHOT: 33
  };
  function hashClientId(clientId) {
    let hash = 2166136261;
    for (let i = 0; i < clientId.length; i++) {
      hash ^= clientId.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  }
  var clientHashMap = /* @__PURE__ */ new Map();
  function registerClientId(clientId) {
    const hash = hashClientId(clientId);
    clientHashMap.set(hash, clientId);
  }
  function unregisterClientId(clientId) {
    const hash = hashClientId(clientId);
    clientHashMap.delete(hash);
  }
  function lookupClientHash(hash) {
    return clientHashMap.get(hash);
  }
  function reResolveClientId(input) {
    if (input.clientHash === void 0) return false;
    const resolved = lookupClientHash(input.clientHash);
    if (resolved && input.clientId !== resolved) {
      input.clientId = resolved;
      return true;
    }
    return false;
  }
  function encodeSyncHash(roomId, hash, seq, frame) {
    const roomIdBytes = new TextEncoder().encode(roomId);
    const hashBytes = new TextEncoder().encode(hash);
    const buf = new Uint8Array(1 + 2 + roomIdBytes.length + 2 + hashBytes.length + 4 + 4);
    const view = new DataView(buf.buffer);
    let offset = 0;
    buf[offset++] = BinaryMessageType.SYNC_HASH;
    view.setUint16(offset, roomIdBytes.length, true);
    offset += 2;
    buf.set(roomIdBytes, offset);
    offset += roomIdBytes.length;
    view.setUint16(offset, hashBytes.length, true);
    offset += 2;
    buf.set(hashBytes, offset);
    offset += hashBytes.length;
    view.setUint32(offset, seq, true);
    offset += 4;
    view.setUint32(offset, frame, true);
    return buf;
  }
  function decodeBinaryMessage(buffer) {
    if (buffer.byteLength === 0) return null;
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    try {
      switch (type) {
        case BinaryMessageType.TICK: {
          const frame = view.getUint32(1, true);
          let inputs = [];
          let snapshotFrame;
          let snapshotHash;
          if (buffer.byteLength > 9) {
            snapshotFrame = view.getUint32(5, true);
            const hashLen = view.getUint8(9);
            let offset = 10;
            if (hashLen > 0 && offset + hashLen <= buffer.byteLength) {
              snapshotHash = new TextDecoder().decode(new Uint8Array(buffer, offset, hashLen));
              offset += hashLen;
            }
            if (offset >= buffer.byteLength) {
              return { type: "TICK", frame, snapshotFrame, snapshotHash, inputs, events: inputs };
            }
            const inputCount = view.getUint8(offset);
            offset++;
            for (let i = 0; i < inputCount && offset < buffer.byteLength; i++) {
              const clientHash = view.getUint32(offset, true);
              offset += 4;
              const seq = view.getUint32(offset, true);
              offset += 4;
              const dataLen = view.getUint16(offset, true);
              offset += 2;
              if (offset + dataLen > buffer.byteLength) break;
              const rawBytes = new Uint8Array(buffer, offset, dataLen);
              offset += dataLen;
              let data;
              const firstByte = rawBytes[0];
              if (firstByte === 123 || firstByte === 91) {
                try {
                  const jsonStr = new TextDecoder().decode(rawBytes);
                  data = JSON.parse(jsonStr);
                } catch {
                  data = rawBytes;
                }
              } else {
                data = rawBytes;
              }
              let clientId;
              if (typeof data === "object" && !(data instanceof Uint8Array)) {
                if (data.clientId && !lookupClientHash(clientHash)) {
                  registerClientId(data.clientId);
                }
                clientId = data.clientId || lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
              } else {
                clientId = lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
              }
              inputs.push({ seq, data, clientId, clientHash });
            }
          }
          return { type: "TICK", frame, snapshotFrame, snapshotHash, inputs, events: inputs };
        }
        case BinaryMessageType.INITIAL_STATE: {
          let offset = 1;
          const frame = view.getUint32(offset, true);
          offset += 4;
          const roomIdLen = view.getUint16(offset, true);
          offset += 2;
          if (offset + roomIdLen > buffer.byteLength) {
            console.error("[modu-network] Buffer overflow reading INITIAL_STATE roomId");
            return null;
          }
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen));
          offset += roomIdLen;
          const snapshotLen = view.getUint32(offset, true);
          offset += 4;
          if (offset + snapshotLen > buffer.byteLength) {
            console.error("[modu-network] Buffer overflow reading INITIAL_STATE snapshot");
            return null;
          }
          const snapshotBytes = new Uint8Array(buffer, offset, snapshotLen);
          offset += snapshotLen;
          const inputCount = view.getUint16(offset, true);
          offset += 2;
          const inputs = [];
          for (let i = 0; i < inputCount && offset < buffer.byteLength; i++) {
            const clientHash = view.getUint32(offset, true);
            offset += 4;
            const seq = view.getUint32(offset, true);
            offset += 4;
            const inputFrame = view.getUint32(offset, true);
            offset += 4;
            const dataLen = view.getUint16(offset, true);
            offset += 2;
            if (offset + dataLen > buffer.byteLength) break;
            const rawBytes = new Uint8Array(buffer, offset, dataLen);
            offset += dataLen;
            let data;
            const firstByte = rawBytes[0];
            if (firstByte === 123 || firstByte === 91) {
              try {
                const jsonStr = new TextDecoder().decode(rawBytes);
                data = JSON.parse(jsonStr);
              } catch {
                data = rawBytes;
              }
            } else {
              data = rawBytes;
            }
            let clientId;
            if (typeof data === "object" && !(data instanceof Uint8Array)) {
              if (data.clientId && !lookupClientHash(clientHash)) {
                registerClientId(data.clientId);
              }
              clientId = data.clientId || lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
            } else {
              clientId = lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
            }
            inputs.push({ seq, frame: inputFrame, data, clientId, clientHash });
          }
          return { type: "INITIAL_STATE", frame, snapshot: snapshotBytes, snapshotHash: "", inputs, events: inputs };
        }
        case BinaryMessageType.ROOM_CREATED: {
          let offset = 1;
          const roomIdLen = view.getUint16(offset, true);
          offset += 2;
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen));
          offset += roomIdLen;
          const clientIdLen = view.getUint16(offset, true);
          offset += 2;
          const clientId = new TextDecoder().decode(new Uint8Array(buffer, offset, clientIdLen));
          offset += clientIdLen;
          const snapshotLen = view.getUint32(offset, true);
          offset += 4;
          const snapshotJson = new TextDecoder().decode(new Uint8Array(buffer, offset, snapshotLen));
          const { snapshot, snapshotHash } = JSON.parse(snapshotJson);
          return { type: "ROOM_CREATED", roomId, clientId, snapshot, snapshotHash };
        }
        case BinaryMessageType.ROOM_JOINED: {
          let offset = 1;
          const roomIdLen = view.getUint16(offset, true);
          offset += 2;
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen));
          offset += roomIdLen;
          const clientIdLen = view.getUint16(offset, true);
          offset += 2;
          const clientId = new TextDecoder().decode(new Uint8Array(buffer, offset, clientIdLen));
          return { type: "ROOM_JOINED", roomId, clientId };
        }
        case BinaryMessageType.ERROR: {
          const msgLen = view.getUint16(1, true);
          const message = new TextDecoder().decode(new Uint8Array(buffer, 3, msgLen));
          return { type: "ERROR", message };
        }
        case BinaryMessageType.SNAPSHOT_UPDATE: {
          let offset = 1;
          const roomIdLen = view.getUint16(offset, true);
          offset += 2;
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen));
          offset += roomIdLen;
          const snapshotLen = view.getUint32(offset, true);
          offset += 4;
          const snapshotJson = new TextDecoder().decode(new Uint8Array(buffer, offset, snapshotLen));
          const { snapshot, snapshotHash } = JSON.parse(snapshotJson);
          return { type: "SNAPSHOT_UPDATE", roomId, snapshot, snapshotHash };
        }
        case BinaryMessageType.ROOM_LEFT: {
          const roomIdLen = view.getUint16(1, true);
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, 3, roomIdLen));
          return { type: "ROOM_LEFT", roomId };
        }
        case BinaryMessageType.CLIENT_LIST_UPDATE: {
          let offset = 1;
          const roomIdLen = view.getUint16(offset, true);
          offset += 2;
          const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen));
          offset += roomIdLen;
          const clientsLen = view.getUint32(offset, true);
          offset += 4;
          const clientsJson = new TextDecoder().decode(new Uint8Array(buffer, offset, clientsLen));
          const clients = JSON.parse(clientsJson);
          return { type: "CLIENT_LIST_UPDATE", roomId, clients };
        }
        case BinaryMessageType.BINARY_SNAPSHOT: {
          const binaryData = new Uint8Array(buffer, 1);
          return { type: "BINARY_SNAPSHOT", binaryData };
        }
        default:
          return null;
      }
    } catch (err) {
      console.error("[modu-network] Decode error:", err);
      return null;
    }
  }
  async function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (typeof Blob !== "undefined" && data instanceof Blob) return await data.arrayBuffer();
    return new Uint8Array(data).buffer;
  }
  async function connect(roomId, options) {
    const initialSnapshot = options.snapshot || {};
    const user = options.user || null;
    const onConnect = options.onConnect || (() => {
    });
    const onDisconnect = options.onDisconnect || (() => {
    });
    const onError = options.onError || ((err) => console.error("[modu-network]", err));
    const onMessage = options.onMessage || (() => {
    });
    const onTick = options.onTick || null;
    const getStateHash = options.getStateHash || null;
    const appId = options.appId;
    if (!appId) {
      throw new Error("[modu-network] appId is required. Pass appId in connect options.");
    }
    const centralServiceUrl = options.centralServiceUrl || (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "http://localhost:9001" : "https://nodes.modd.io");
    console.log("[modu-network] Central service URL:", centralServiceUrl);
    let connected = false;
    let deliveredSeqs = /* @__PURE__ */ new Set();
    let pendingTicks = [];
    let ws = null;
    let nodeUrl = null;
    let nodeToken = null;
    let tickRate = options.fps || 20;
    let connectionResolve = null;
    let bytesIn = 0;
    let bytesOut = 0;
    let lastBytesIn = 0;
    let lastBytesOut = 0;
    let bandwidthIn = 0;
    let bandwidthOut = 0;
    let bandwidthInterval = null;
    let hashInterval = null;
    let lastSyncSeq = 0;
    let lastSyncFrame = 0;
    let currentFrame = 0;
    let myClientId = null;
    function processInputsForClientIds(inputs) {
      for (const input of inputs) {
        const data = input.data || {};
        const inputType = data.type || input.type;
        if (inputType === "join" || inputType === "reconnect") {
          const clientId = data.clientId || input.clientId;
          if (clientId) {
            registerClientId(clientId);
          }
        } else if (inputType === "leave") {
          const clientId = data.clientId || input.clientId;
          if (clientId) {
            unregisterClientId(clientId);
          }
        }
      }
    }
    try {
      const requestBody = {};
      if (options.joinToken) {
        requestBody.joinToken = options.joinToken;
      }
      const authToken = options.authToken || (typeof localStorage !== "undefined" ? localStorage.getItem("modd_auth_token") : null);
      if (authToken && !options.joinToken) {
        requestBody.authToken = authToken;
      }
      if (options.nodeUrl) {
        const portMatch = options.nodeUrl.match(/:(\d+)/);
        if (portMatch) {
          requestBody.preferredNodeId = `port_${portMatch[1]}`;
        }
        console.log("[modu-network] Requesting preferred node:", options.nodeUrl);
      }
      const connectUrl = `${centralServiceUrl}/api/apps/${appId}/rooms/${roomId}/connect`;
      const res = await fetch(connectUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(`Failed to get node assignment: ${errorData.error || res.statusText}`);
      }
      const responseData = await res.json();
      nodeUrl = responseData.url;
      nodeToken = responseData.token;
      tickRate = responseData.fps || 20;
      const assignedToPreferred = options.nodeUrl && responseData.url === options.nodeUrl;
      console.log("[modu-network] Received Node URL:", nodeUrl, "token:", nodeToken ? "yes" : "no", "fps:", tickRate, assignedToPreferred ? "(preferred)" : "");
      const WS = typeof globalThis !== "undefined" && globalThis.WebSocket ? globalThis.WebSocket : WebSocket;
      return new Promise((resolve, reject) => {
        connectionResolve = resolve;
        const wsUrl = nodeToken ? `${nodeUrl}?token=${encodeURIComponent(nodeToken)}` : nodeUrl;
        ws = new WS(wsUrl);
        ws.binaryType = "arraybuffer";
        const instance = {
          send(data) {
            if (!connected || !ws || ws.readyState !== 1) return;
            if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
              const binary = data instanceof Uint8Array ? data : new Uint8Array(data);
              const wrapper = new Uint8Array(1 + binary.length);
              wrapper[0] = 32;
              wrapper.set(binary, 1);
              bytesOut += wrapper.length;
              ws.send(wrapper);
              return;
            }
            const msg = JSON.stringify({ type: "SEND_INPUT", payload: { roomId, data } });
            bytesOut += msg.length;
            ws.send(msg);
          },
          sendSnapshot(snapshot, hash, seq, frame) {
            if (!connected || !ws) return;
            if (snapshot instanceof Uint8Array || snapshot instanceof ArrayBuffer) {
              const binary = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
              const hashBytes = new TextEncoder().encode(hash || "");
              const wrapper = new Uint8Array(1 + 4 + 4 + 1 + hashBytes.length + binary.length);
              wrapper[0] = 35;
              const view = new DataView(wrapper.buffer);
              view.setUint32(1, seq ?? 0, true);
              view.setUint32(5, frame ?? 0, true);
              wrapper[9] = hashBytes.length;
              wrapper.set(hashBytes, 10);
              wrapper.set(binary, 10 + hashBytes.length);
              bytesOut += wrapper.length;
              ws.send(wrapper);
              return;
            }
            const msg = JSON.stringify({ type: "SEND_SNAPSHOT", payload: { roomId, snapshot, hash } });
            bytesOut += msg.length;
            ws.send(msg);
          },
          leaveRoom() {
            if (connected && ws) {
              const msg = JSON.stringify({ type: "LEAVE_ROOM", payload: { roomId } });
              bytesOut += msg.length;
              ws.send(msg);
            }
            if (ws) ws.close();
          },
          getClients() {
            if (connected && ws && ws.readyState === 1) {
              const msg = JSON.stringify({ type: "GET_CLIENTS", payload: { roomId } });
              bytesOut += msg.length;
              ws.send(msg);
            }
          },
          close() {
            if (ws) ws.close();
          },
          get connected() {
            return connected;
          },
          get clientId() {
            return myClientId;
          },
          get node() {
            return nodeUrl ? nodeUrl.match(/:(\d+)/)?.[1] || nodeUrl : null;
          },
          get bandwidthIn() {
            return bandwidthIn;
          },
          get bandwidthOut() {
            return bandwidthOut;
          },
          get totalBytesIn() {
            return bytesIn;
          },
          get totalBytesOut() {
            return bytesOut;
          },
          get frame() {
            return currentFrame;
          },
          getLatency() {
            return "0";
          }
        };
        ws.onopen = () => {
          bandwidthInterval = setInterval(() => {
            bandwidthIn = bytesIn - lastBytesIn;
            bandwidthOut = bytesOut - lastBytesOut;
            lastBytesIn = bytesIn;
            lastBytesOut = bytesOut;
          }, 1e3);
          if (getStateHash) {
            hashInterval = setInterval(() => {
              if (!connected || !ws || ws.readyState !== 1) return;
              try {
                const hash = getStateHash();
                if (hash) {
                  const hashMsg = encodeSyncHash(roomId, hash, lastSyncSeq, lastSyncFrame);
                  bytesOut += hashMsg.byteLength;
                  ws.send(hashMsg);
                }
              } catch (err) {
                console.warn("[modu-network] Error getting state hash:", err);
              }
            }, 1e3);
          }
          const joinMsg = JSON.stringify({ type: "JOIN_ROOM", payload: { roomId, user } });
          bytesOut += joinMsg.length;
          ws.send(joinMsg);
        };
        ws.onerror = (e) => {
          const errMsg = `Failed to connect to ${nodeUrl}: ${e.message || "Unknown error"}`;
          onError(errMsg);
          if (!connected) reject(new Error(errMsg));
        };
        ws.onclose = () => {
          connected = false;
          if (bandwidthInterval) clearInterval(bandwidthInterval);
          if (hashInterval) clearInterval(hashInterval);
          onDisconnect();
        };
        ws.onmessage = async (e) => {
          let buffer;
          try {
            buffer = await toArrayBuffer(e.data);
          } catch (err) {
            console.warn("[modu-network] Failed to read message data:", err);
            return;
          }
          bytesIn += buffer.byteLength;
          const msg = decodeBinaryMessage(buffer);
          if (!msg) return;
          switch (msg.type) {
            case "TICK": {
              if (!connected) {
                pendingTicks.push(msg);
                break;
              }
              currentFrame = msg.frame;
              lastSyncFrame = msg.frame;
              const tickInputs = msg.inputs || msg.events || [];
              if (tickInputs && tickInputs.length > 0) {
                const maxSeq = Math.max(...tickInputs.map((e2) => e2.seq || 0));
                if (maxSeq > lastSyncSeq) lastSyncSeq = maxSeq;
              }
              const newInputs = tickInputs.filter((e2) => !deliveredSeqs.has(e2.seq));
              newInputs.forEach((e2) => deliveredSeqs.add(e2.seq));
              if (newInputs.length > 0) {
                processInputsForClientIds(newInputs);
              }
              if (onTick) {
                onTick(msg.frame, newInputs, msg.snapshotFrame, msg.snapshotHash);
              }
              break;
            }
            case "ERROR": {
              if (msg.message === "Room not found") {
                const createMsg = JSON.stringify({
                  type: "CREATE_ROOM",
                  payload: { roomId, snapshot: initialSnapshot, user }
                });
                bytesOut += createMsg.length;
                ws.send(createMsg);
              } else {
                onError(msg.message);
                reject(new Error(msg.message));
              }
              break;
            }
            case "ROOM_CREATED": {
              connected = true;
              currentFrame = 0;
              if (msg.clientId) {
                myClientId = msg.clientId;
                registerClientId(msg.clientId);
                console.log(`[modu-network] Assigned clientId: ${msg.clientId}`);
              }
              onConnect(initialSnapshot, [], 0, nodeUrl, tickRate, myClientId);
              if (connectionResolve) connectionResolve(instance);
              break;
            }
            case "INITIAL_STATE": {
              console.log("[modu-network] Received INITIAL_STATE, connecting...");
              const { snapshot, frame, snapshotHash } = msg;
              if (snapshot && snapshotHash) {
                snapshot.snapshotHash = snapshotHash;
              }
              const inputs = msg.inputs || msg.events || [];
              currentFrame = frame;
              lastSyncFrame = frame;
              if (inputs && inputs.length > 0) {
                const maxSeq = Math.max(...inputs.map((e2) => e2.seq || 0));
                if (maxSeq > lastSyncSeq) lastSyncSeq = maxSeq;
                inputs.forEach((e2) => deliveredSeqs.add(e2.seq));
              }
              if (inputs && inputs.length > 0) {
                processInputsForClientIds(inputs);
              }
              connected = true;
              onConnect(snapshot, inputs || [], frame, nodeUrl, tickRate, myClientId);
              if (pendingTicks.length > 0) {
                pendingTicks.sort((a, b) => a.frame - b.frame);
                for (const tickMsg of pendingTicks) {
                  const tickInputs = (tickMsg.inputs || tickMsg.events || []).filter((e2) => !deliveredSeqs.has(e2.seq));
                  tickInputs.forEach((e2) => deliveredSeqs.add(e2.seq));
                  if (tickInputs.length > 0) {
                    processInputsForClientIds(tickInputs);
                  }
                  for (const inp of tickInputs) {
                    reResolveClientId(inp);
                  }
                  if (onTick && (tickInputs.length > 0 || tickMsg.frame > frame)) {
                    onTick(tickMsg.frame, tickInputs, tickMsg.snapshotFrame, tickMsg.snapshotHash);
                  }
                }
                pendingTicks = [];
              }
              if (connectionResolve) connectionResolve(instance);
              break;
            }
            case "ROOM_JOINED": {
              connected = true;
              if (msg.clientId) {
                myClientId = msg.clientId;
                registerClientId(msg.clientId);
                console.log(`[modu-network] Assigned clientId: ${msg.clientId}`);
              }
              break;
            }
            case "SNAPSHOT_UPDATE": {
              if (options.onSnapshot) options.onSnapshot(msg.snapshot, msg.snapshotHash);
              break;
            }
            case "BINARY_SNAPSHOT": {
              if (options.onBinarySnapshot) options.onBinarySnapshot(msg.binaryData);
              break;
            }
            case "ROOM_LEFT": {
              console.log(`[modu-network] Left room ${msg.roomId}`);
              break;
            }
            case "CLIENT_LIST_UPDATE": {
              if (options.onClientsUpdate) options.onClientsUpdate(msg.clients);
              break;
            }
          }
        };
      });
    } catch (err) {
      throw new Error(`Failed to get node assignment: ${err.message}`);
    }
  }
  function getCentralServiceUrl(centralServiceUrl) {
    return centralServiceUrl || (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "http://localhost:9001" : "https://nodes.modd.io");
  }
  async function listRooms(appId, options = {}) {
    const centralUrl = getCentralServiceUrl(options.centralServiceUrl);
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const url = `${centralUrl}/api/apps/${encodeURIComponent(appId)}/rooms/list?limit=${limit}&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(errorData.error || `Failed to list rooms: ${response.statusText}`);
    }
    return await response.json();
  }
  async function getRandomRoom(appId, options = {}) {
    const centralUrl = getCentralServiceUrl(options.centralServiceUrl);
    const minClients = options.minClients ?? 0;
    const maxClients = options.maxClients ?? 999;
    const url = `${centralUrl}/api/apps/${encodeURIComponent(appId)}/rooms/random?minClients=${minClients}&maxClients=${maxClients}`;
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(errorData.error || `Failed to get random room: ${response.statusText}`);
    }
    return await response.json();
  }
  var modd = connect;
  if (typeof window !== "undefined") {
    window.moddNetwork = { connect, modd, listRooms, getRandomRoom, auth };
  }
  return __toCommonJS(modu_network_exports);
})();
//# sourceMappingURL=modu-network.iife.js.map
