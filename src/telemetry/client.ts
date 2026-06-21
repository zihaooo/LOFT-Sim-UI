import type { ProjectionOrigin } from "../types";
import {
  convertTelemetrySnapshotToScene,
  parseTelemetrySnapshotFrame,
  TelemetrySnapshotBuffer,
  type TelemetryProjection,
  type TelemetryRegistry,
  type TelemetryRegistryDrone,
  type TelemetryRegistryCorridor,
  type TelemetryRegistryRoute,
  type TelemetrySnapshot,
} from "./protocol";

type TelemetryClientOptions = {
  url: string;
  frontendOrigin: ProjectionOrigin;
};

export type TelemetryConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type TelemetryClientStats = {
  connectionState: TelemetryConnectionState;
  receivedSnapshotCount: number;
  droppedSnapshotCount: number;
  reconnectCount: number;
  lastParseTimeMs: number;
  snapshotHz: number;
  lastError: string;
};

type RegistryMessage = {
  type?: string;
  projection?: TelemetryProjection;
  drones?: TelemetryRegistryDrone[];
  corridors?: TelemetryRegistryCorridor[];
  routes?: TelemetryRegistryRoute[];
};

type TelemetryControlMessage =
  | { type: "pause" | "resume" }
  | { type: "speed"; speed: number };

export class TelemetryClient {
  private readonly buffer = new TelemetrySnapshotBuffer();
  private readonly registry: TelemetryRegistry = {
    dronesByHandle: new Map(),
    corridorsByHandle: new Map(),
    routesByHandle: new Map(),
  };
  private readonly recentReceiveTimes: number[] = [];
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private simulatorProjection: TelemetryProjection | undefined;
  private requestedRunning = true;
  private requestedSpeed = 1;
  private stopped = true;
  private stats: TelemetryClientStats = {
    connectionState: "idle",
    receivedSnapshotCount: 0,
    droppedSnapshotCount: 0,
    reconnectCount: 0,
    lastParseTimeMs: 0,
    snapshotHz: 0,
    lastError: "",
  };

  constructor(private readonly options: TelemetryClientOptions) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.buffer.clear();
  }

  latestSnapshot(): TelemetrySnapshot | undefined {
    return this.buffer.latest();
  }

  getRegistry(): TelemetryRegistry {
    return this.registry;
  }

  setRunning(running: boolean): void {
    this.requestedRunning = running;
    this.sendControlMessage({ type: running ? "resume" : "pause" });
  }

  setSpeed(speed: number): void {
    this.requestedSpeed = speed;
    this.sendControlMessage({ type: "speed", speed });
  }

  getStats(): TelemetryClientStats {
    const latest = this.buffer.latest();
    return {
      ...this.stats,
      snapshotHz: this.computeSnapshotHz(),
      lastError: latest ? this.stats.lastError : this.stats.lastError,
    };
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.stats.connectionState = "connecting";
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      this.stats.connectionState = "connected";
      this.stats.lastError = "";
      this.sendControlMessage({ type: this.requestedRunning ? "resume" : "pause" });
      this.sendControlMessage({ type: "speed", speed: this.requestedSpeed });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.stats.connectionState = "disconnected";
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.stats.connectionState = "error";
      this.stats.lastError = "WebSocket connection error";
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      this.applyRegistryMessage(data);
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      return;
    }

    const startedAt = performance.now();
    try {
      const parsed = parseTelemetrySnapshotFrame(data);
      const receivedAt = performance.now();
      const accepted = this.buffer.push(convertTelemetrySnapshotToScene(
        parsed,
        this.options.frontendOrigin,
        this.simulatorProjection,
        receivedAt,
      ));
      if (!accepted) {
        this.stats.droppedSnapshotCount += 1;
      }
      this.stats.receivedSnapshotCount += 1;
      this.stats.lastParseTimeMs = performance.now() - startedAt;
      this.recordReceiveTime(receivedAt);
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private applyRegistryMessage(rawMessage: string): void {
    let message: RegistryMessage;
    try {
      message = JSON.parse(rawMessage) as RegistryMessage;
    } catch {
      return;
    }

    if (message.type !== "registry") {
      return;
    }

    if (message.projection) {
      this.simulatorProjection = message.projection;
    }

    message.drones?.forEach((drone) => {
      this.registry.dronesByHandle.set(drone.handle, drone);
    });
    message.corridors?.forEach((corridor) => {
      this.registry.corridorsByHandle.set(corridor.handle, corridor);
    });
    message.routes?.forEach((route) => {
      this.registry.routesByHandle.set(route.handle, route);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.stats.reconnectCount += 1;
      this.connect();
    }, 1_500);
  }

  private sendControlMessage(message: TelemetryControlMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private recordReceiveTime(receivedAt: number): void {
    this.recentReceiveTimes.push(receivedAt);
    const cutoff = receivedAt - 2_000;
    while (this.recentReceiveTimes.length > 0 && this.recentReceiveTimes[0] < cutoff) {
      this.recentReceiveTimes.shift();
    }
  }

  private computeSnapshotHz(): number {
    const latest = this.recentReceiveTimes[this.recentReceiveTimes.length - 1];
    const earliest = this.recentReceiveTimes[0];
    if (latest === undefined || earliest === undefined || latest <= earliest) {
      return 0;
    }
    return ((this.recentReceiveTimes.length - 1) * 1_000) / (latest - earliest);
  }
}
